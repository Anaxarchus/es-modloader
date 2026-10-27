/* loader.c
 * The Dado loader's C side: es_loader_init, the EsLoader entries the game
 * calls, finding the mods (<source>/scripts/<name>.js), the hook_timing brackets
 * and the watchdog. The mods themselves run in the Dado harness (harness/),
 * which dadoc transpiles to esmod.c; this file reaches it through esmod.h.
 *
 * Every mod has an engine (a QuickJS VM) of its own, in a slot of the
 * harness. Each call into a mod's hook is
 *
 *     hook_timing(mod, hook, 1)   the game learns which mod runs
 *     arm the watchdog
 *     esmod_call(slot, hook, ...) the harness runs the hook in the mod's engine
 *     disarm the watchdog
 *     hook_timing(mod, hook, 0)
 *
 * so the brackets are always closed, even when the watchdog stops the mod,
 * and never nest (calls from inside a hook are refused). */
#include "es_api.h"
#include "esmod.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <sys/stat.h>
#include <time.h>
#endif

#ifndef ESDADO_VERSION
#define ESDADO_VERSION "0.0.0"
#endif

/* The generated shim (tools/gen-host-shim.cmake). */
extern const EsHost *es_shim_game;
const char *es_shim_missing(const EsHost *host);
#define game es_shim_game

/* The hooks, numbered as the harness numbers them (harness/harness.dado). */
enum {
	H_LOAD, H_STEP, H_DAY, H_ENTER, H_PLANET_BUTTON, H_PANEL, H_CAN_OUTFITTER,
	H_OUTFITTER, H_CONFIRM, H_PANEL_ROW, H_PANEL_HEADER, H_NUMBER, H_COUNT
};
static const char *const HOOK_NAMES[H_COUNT] = {
	"on_load", "on_step", "on_day", "on_enter", "on_planet_button", "on_panel", "can_outfitter",
	"on_outfitter", "on_confirm", "on_panel_row", "on_panel_header", "on_number"
};
#define BIT(hook) (1u << (hook))

/* The most bytes of a mod's path (Dado's limit for a script loaded by its path). */
#define MAX_PATH_BYTES 1000

static const char LOADER_NAME[] = "Dado loader " ESDADO_VERSION;

/* The watchdog's limits, in milliseconds: a hook, loading a mod (its module's
 * top-level code), and how long a stopped script has to leave by itself before
 * it is forced. ES_DADO_HOOK_MS and ES_DADO_LOAD_MS change the first two; 0
 * switches the watchdog off. */
static int hookLimit = 250;
static int loadLimit = 2000;
static const int GRACE = 100;

typedef struct Mod {
	char *name;
	/* The mod's file without ".js", as the harness loads it. */
	char *path;
	int slot;
	unsigned hooks;
	int live;
} Mod;

static Mod *mods;
static int modCount;
static int loadedOnce;
static int inHook;

static void Say(const char *format, ...)
{
	char text[2048];
	va_list args;
	va_start(args, format);
	vsnprintf(text, sizeof(text), format, args);
	va_end(args);
	if(game && game->log)
		game->log(text);
}

static char *Copy(const char *text)
{
	size_t n = strlen(text) + 1;
	char *out = malloc(n);
	if(out)
		memcpy(out, text, n);
	return out;
}

static int ReadLimit(const char *name, int fallback)
{
	const char *value = getenv(name);
	if(!value || !*value)
		return fallback;
	char *end = NULL;
	long n = strtol(value, &end, 10);
	if(*end || n < 0 || n > 600000)
		return fallback;
	return (int)n;
}

/* ---- The watchdog ----
 * One thread, started with the first armed call. The main thread arms it
 * before each call into a mod (slot and deadline, under the lock) and disarms
 * it after. If the deadline passes while armed, the watchdog thread stops the
 * slot's engine (esmod_interrupt, #script_stop: the script is asked to stop,
 * then forced), still holding the lock, so the main thread cannot arm another
 * call until the stop is done. The call then answers -2 and disarm reports
 * that it fired. The thread is woken only when it has nothing armed; while a
 * deadline is pending it sleeps until that deadline, sees the later one of the
 * call armed since, and sleeps again, so it wakes a few times a second at most.
 * It is signalled when it sleeps with nothing armed, and when a deadline earlier
 * than the one it sleeps until is armed (a 250 ms hook after a 2000 ms load). */
#ifdef _WIN32
typedef SRWLOCK WdLock;
typedef CONDITION_VARIABLE WdCond;
static uint64_t NowMs(void) { return GetTickCount64(); }
#else
typedef pthread_mutex_t WdLock;
typedef pthread_cond_t WdCond;
static uint64_t NowMs(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u;
}
#endif

static struct {
	WdLock lock;
	WdCond wake;
#ifdef _WIN32
	HANDLE thread;
#else
	pthread_t thread;
#endif
	int ready;
	int started;
	int failed;
	int quit;
	int armed;
	int idle;
	/* The deadline the thread sleeps until, while it does. */
	uint64_t waitUntil;
	int fired;
	int slot;
	uint64_t deadline;
} wd;

static void WdLockIt(void)
{
#ifdef _WIN32
	AcquireSRWLockExclusive(&wd.lock);
#else
	pthread_mutex_lock(&wd.lock);
#endif
}

static void WdUnlock(void)
{
#ifdef _WIN32
	ReleaseSRWLockExclusive(&wd.lock);
#else
	pthread_mutex_unlock(&wd.lock);
#endif
}

static void WdSignal(void)
{
#ifdef _WIN32
	WakeAllConditionVariable(&wd.wake);
#else
	pthread_cond_broadcast(&wd.wake);
#endif
}

/* Wait, holding the lock, until signalled or (with a deadline) until then. */
static void WdWait(int timed, uint64_t deadline)
{
#ifdef _WIN32
	DWORD ms = INFINITE;
	if(timed)
	{
		uint64_t now = NowMs();
		ms = deadline > now ? (DWORD)(deadline - now) : 0;
	}
	SleepConditionVariableSRW(&wd.wake, &wd.lock, ms, 0);
#else
	if(!timed)
	{
		pthread_cond_wait(&wd.wake, &wd.lock);
		return;
	}
	uint64_t now = NowMs();
	uint64_t left = deadline > now ? deadline - now : 0;
#ifdef __APPLE__
	struct timespec rel = {(time_t)(left / 1000u), (long)(left % 1000u) * 1000000L};
	pthread_cond_timedwait_relative_np(&wd.wake, &wd.lock, &rel);
#else
	struct timespec at;
	clock_gettime(CLOCK_MONOTONIC, &at);
	at.tv_sec += (time_t)(left / 1000u);
	at.tv_nsec += (long)(left % 1000u) * 1000000L;
	if(at.tv_nsec >= 1000000000L)
	{
		at.tv_sec += 1;
		at.tv_nsec -= 1000000000L;
	}
	pthread_cond_timedwait(&wd.wake, &wd.lock, &at);
#endif
#endif
}

static void WdLoop(void)
{
	WdLockIt();
	while(!wd.quit)
	{
		if(!wd.armed)
		{
			wd.idle = 1;
			WdWait(0, 0);
			wd.idle = 0;
			continue;
		}
		if(NowMs() >= wd.deadline)
		{
			wd.armed = 0;
			wd.fired = 1;
			esmod_interrupt(wd.slot, GRACE);
			continue;
		}
		wd.waitUntil = wd.deadline;
		WdWait(1, wd.deadline);
		wd.waitUntil = 0;
	}
	WdUnlock();
}

#ifdef _WIN32
static DWORD WINAPI WdThread(LPVOID unused) { (void)unused; WdLoop(); return 0; }
#else
static void *WdThread(void *unused) { (void)unused; WdLoop(); return NULL; }
#endif

static int WdStart(void)
{
	if(wd.started)
		return 1;
	if(wd.failed)
		return 0;
	if(!wd.ready)
	{
#ifdef _WIN32
		InitializeSRWLock(&wd.lock);
		InitializeConditionVariable(&wd.wake);
#else
		pthread_mutex_init(&wd.lock, NULL);
		pthread_condattr_t attr;
		pthread_condattr_init(&attr);
#ifndef __APPLE__
		pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
#endif
		pthread_cond_init(&wd.wake, &attr);
		pthread_condattr_destroy(&attr);
#endif
		wd.ready = 1;
	}
	wd.quit = 0;
#ifdef _WIN32
	wd.thread = CreateThread(NULL, 0, WdThread, NULL, 0, NULL);
	wd.started = wd.thread != NULL;
#else
	wd.started = pthread_create(&wd.thread, NULL, WdThread, NULL) == 0;
#endif
	if(!wd.started)
	{
		wd.failed = 1;
		Say("dado: the watchdog thread did not start; mods run without a time limit");
	}
	return wd.started;
}

static void WdStop(void)
{
	if(!wd.started)
		return;
	WdLockIt();
	wd.quit = 1;
	wd.armed = 0;
	WdSignal();
	WdUnlock();
#ifdef _WIN32
	WaitForSingleObject(wd.thread, INFINITE);
	CloseHandle(wd.thread);
#else
	pthread_join(wd.thread, NULL);
#endif
	wd.started = 0;
}

static void WdArm(int slot, int limit)
{
	if(limit <= 0 || !WdStart())
		return;
	WdLockIt();
	wd.slot = slot;
	wd.deadline = NowMs() + (uint64_t)limit;
	wd.fired = 0;
	wd.armed = 1;
	/* Wake the thread when it sleeps with nothing armed, or until a later
	 * deadline than this one (a hook armed after a longer load limit). */
	if(wd.idle || (wd.waitUntil && wd.deadline < wd.waitUntil))
		WdSignal();
	WdUnlock();
}

/* Whether the watchdog stopped the call it was armed for. */
static int WdDisarm(void)
{
	if(!wd.started)
		return 0;
	WdLockIt();
	int fired = wd.fired;
	wd.fired = 0;
	wd.armed = 0;
	WdUnlock();
	return fired;
}

/* ---- Running hooks ---- */

/* Hooks that are switched off for a mod when they fail once. */
static int OffOnFailure(int hook)
{
	return hook == H_STEP || hook == H_DAY || hook == H_ENTER || hook == H_CAN_OUTFITTER;
}

static void Drop(Mod *mod)
{
	if(mod->live)
		esmod_drop(mod->slot);
	mod->live = 0;
	mod->hooks = 0;
}

/* Run one hook of one mod: its answer, -1 when it failed, -2 when the
 * watchdog stopped it (the mod is then off), -3 when it did not run. */
static int RunHook(Mod *mod, int hook, const char *text, int32_t a, int32_t b)
{
	if(!mod->live || !(mod->hooks & BIT(hook)))
		return -3;
	if(inHook)
	{
		Say("dado: mod \"%s\": %s was asked for from inside another hook and did not run", mod->name, HOOK_NAMES[hook]);
		return -3;
	}
	inHook = 1;
	game->hook_timing(mod->name, HOOK_NAMES[hook], 1);
	WdArm(mod->slot, hookLimit);
	int result = esmod_call(mod->slot, hook, text ? text : "", a, b);
	int fired = WdDisarm();
	game->hook_timing(mod->name, HOOK_NAMES[hook], 0);
	inHook = 0;
	if(fired || result == -2)
	{
		if(fired)
			Say("dado: mod \"%s\" ran longer than %d ms in %s and was stopped; the mod is now off",
				mod->name, hookLimit, HOOK_NAMES[hook]);
		else
			Say("dado: mod \"%s\" was stopped in %s; the mod is now off", mod->name, HOOK_NAMES[hook]);
		Drop(mod);
		return -2;
	}
	if(result == -1 && OffOnFailure(hook))
	{
		mod->hooks &= ~BIT(hook);
		/* A mod whose can_outfitter fails has its outfitter button disabled. */
		if(hook == H_CAN_OUTFITTER)
			mod->hooks &= ~BIT(H_OUTFITTER);
	}
	return result;
}

static Mod *FindMod(const char *name)
{
	if(!name)
		return NULL;
	for(int i = 0; i < modCount; ++i)
		if(mods[i].live && !strcmp(mods[i].name, name))
			return &mods[i];
	return NULL;
}

/* ---- Finding the mods ---- */

typedef struct Found {
	char *name;
	char *path;
} Found;

typedef struct FoundList {
	Found *items;
	int count;
	int capacity;
} FoundList;

/* Add a mod; one of the same name found in an earlier source is replaced. */
static void Offer(FoundList *list, const char *name, const char *path)
{
	for(int i = 0; i < list->count; ++i)
		if(!strcmp(list->items[i].name, name))
		{
			char *copy = Copy(path);
			if(copy)
			{
				free(list->items[i].path);
				list->items[i].path = copy;
			}
			return;
		}
	if(list->count == list->capacity)
	{
		int capacity = list->capacity ? list->capacity * 2 : 16;
		Found *items = realloc(list->items, (size_t)capacity * sizeof(Found));
		if(!items)
			return;
		list->items = items;
		list->capacity = capacity;
	}
	Found found = {Copy(name), Copy(path)};
	if(!found.name || !found.path)
	{
		free(found.name);
		free(found.path);
		return;
	}
	list->items[list->count++] = found;
}

static int EndsWith(const char *text, const char *suffix, int ignoreCase)
{
	size_t n = strlen(text), k = strlen(suffix);
	if(n < k)
		return 0;
	for(size_t i = 0; i < k; ++i)
	{
		char x = text[n - k + i], y = suffix[i];
		if(ignoreCase)
		{
			if(x >= 'A' && x <= 'Z')
				x = (char)(x - 'A' + 'a');
			if(y >= 'A' && y <= 'Z')
				y = (char)(y - 'A' + 'a');
		}
		if(x != y)
			return 0;
	}
	return 1;
}

/* A file in a scripts folder: a mod when its name ends in ".js" and does not start with ".". */
static void OfferFile(FoundList *list, const char *folder, const char *file)
{
	if(file[0] == '.' || !EndsWith(file, ".js", 0) || strlen(file) <= 3)
		return;
	size_t stem = strlen(file) - 3;
	size_t length = strlen(folder) + 1 + stem;
	if(length > MAX_PATH_BYTES)
	{
		Say("dado: skipped \"%s/%s\": its path is too long", folder, file);
		return;
	}
	char *path = malloc(length + 1);
	char *name = malloc(stem + 1);
	if(path && name)
	{
		snprintf(path, length + 1, "%s/%.*s", folder, (int)stem, file);
		memcpy(name, file, stem);
		name[stem] = '\0';
		Offer(list, name, path);
	}
	free(path);
	free(name);
}

/* Every <source>/scripts/<name>.js. */
static void Scan(FoundList *list, const char *source)
{
	size_t n = strlen(source);
	while(n > 1 && (source[n - 1] == '/' || source[n - 1] == '\\'))
		--n;
	char *folder = malloc(n + sizeof("/scripts"));
	if(!folder)
		return;
	memcpy(folder, source, n);
	memcpy(folder + n, "/scripts", sizeof("/scripts"));
#ifdef _WIN32
	/* The game's paths are UTF-8; Windows takes UTF-16. */
	char *pattern = malloc(strlen(folder) + 3);
	if(pattern)
	{
		sprintf(pattern, "%s/*", folder);
		int wide = MultiByteToWideChar(CP_UTF8, 0, pattern, -1, NULL, 0);
		wchar_t *wpattern = wide > 0 ? malloc((size_t)wide * sizeof(wchar_t)) : NULL;
		if(wpattern && MultiByteToWideChar(CP_UTF8, 0, pattern, -1, wpattern, wide) > 0)
		{
			WIN32_FIND_DATAW data;
			HANDLE find = FindFirstFileW(wpattern, &data);
			if(find != INVALID_HANDLE_VALUE)
			{
				do
				{
					if(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
						continue;
					char file[MAX_PATH * 4];
					if(WideCharToMultiByte(CP_UTF8, 0, data.cFileName, -1, file, sizeof(file), NULL, NULL) > 0)
						OfferFile(list, folder, file);
				} while(FindNextFileW(find, &data));
				FindClose(find);
			}
		}
		free(wpattern);
		free(pattern);
	}
#else
	DIR *dir = opendir(folder);
	if(dir)
	{
		struct dirent *entry;
		while((entry = readdir(dir)))
		{
			if(entry->d_name[0] == '.')
				continue;
			/* Regular files only (or links to them). */
			size_t length = strlen(folder) + 1 + strlen(entry->d_name);
			char *full = malloc(length + 1);
			struct stat info;
			if(full)
			{
				snprintf(full, length + 1, "%s/%s", folder, entry->d_name);
				if(stat(full, &info) == 0 && S_ISREG(info.st_mode))
					OfferFile(list, folder, entry->d_name);
				free(full);
			}
		}
		closedir(dir);
	}
#endif
	free(folder);
}

static int ByName(const void *a, const void *b)
{
	return strcmp(((const Found *)a)->name, ((const Found *)b)->name);
}

/* Load one mod: a slot, its module (under the load limit), then on_load. */
static void LoadOne(const Found *found)
{
	int slot = esmod_new();
	if(slot < 0)
	{
		Say("dado: mod \"%s\" did not load: no script engine could be made for it", found->name);
		return;
	}
	/* Loading runs the mod's code (its module's top level, api_version, any
	 * getter or Proxy trap behind the hook check), so it is one armed call,
	 * bracketed as the mod's "load". */
	inHook = 1;
	game->hook_timing(found->name, "load", 1);
	WdArm(slot, loadLimit);
	int hooks = esmod_prepare(slot, found->path, found->name);
	int fired = WdDisarm();
	game->hook_timing(found->name, "load", 0);
	inHook = 0;
	if(fired || hooks == -2)
	{
		Say("dado: mod \"%s\" took longer than %d ms to load and was stopped", found->name, loadLimit);
		esmod_drop(slot);
		return;
	}
	if(hooks < 0)
	{
		esmod_drop(slot);
		return;
	}
	Mod *grown = realloc(mods, (size_t)(modCount + 1) * sizeof(Mod));
	if(!grown)
	{
		esmod_drop(slot);
		return;
	}
	mods = grown;
	Mod *mod = &mods[modCount];
	mod->name = Copy(found->name);
	mod->path = Copy(found->path);
	mod->slot = slot;
	mod->hooks = (unsigned)hooks;
	mod->live = 1;
	if(!mod->name || !mod->path)
	{
		free(mod->name);
		free(mod->path);
		esmod_drop(slot);
		return;
	}
	++modCount;
	if(mod->hooks & BIT(H_LOAD))
	{
		int result = RunHook(mod, H_LOAD, "", 0, 0);
		if(result < 0)
		{
			/* RunHook said why; a mod whose on_load fails is not loaded. */
			Drop(mod);
			free(mod->name);
			free(mod->path);
			--modCount;
			return;
		}
	}
	Say("dado: loaded mod \"%s\"", mod->name);
}

/* ---- The EsLoader entries ---- */

static void ES_CALL LoadMods(int32_t count, const char *const *paths, const char *const *names)
{
	(void)names;
	if(loadedOnce)
		return;
	loadedOnce = 1;
	FoundList list = {NULL, 0, 0};
	for(int32_t i = 0; i < count; ++i)
	{
		if(!paths || !paths[i] || !*paths[i])
			continue;
		/* A zipped plugin: scripts are read from folders only. */
		if(EndsWith(paths[i], ".zip", 1))
			continue;
		Scan(&list, paths[i]);
	}
	if(list.count)
		qsort(list.items, (size_t)list.count, sizeof(Found), ByName);
	for(int i = 0; i < list.count; ++i)
	{
		LoadOne(&list.items[i]);
		free(list.items[i].name);
		free(list.items[i].path);
	}
	free(list.items);
}

/* The mods running now: loaded, and not stopped by the watchdog since. */
static int32_t ES_CALL Count(void)
{
	int32_t live = 0;
	for(int i = 0; i < modCount; ++i)
		live += mods[i].live != 0;
	return live;
}

static void ES_CALL Step(int32_t step)
{
	for(int i = 0; i < modCount; ++i)
		RunHook(&mods[i], H_STEP, "", step, 0);
}

static void ES_CALL Day(int32_t day)
{
	for(int i = 0; i < modCount; ++i)
		RunHook(&mods[i], H_DAY, "", day, 0);
}

static void ES_CALL Enter(const char *system)
{
	for(int i = 0; i < modCount; ++i)
		RunHook(&mods[i], H_ENTER, system, 0, 0);
}

static void ES_CALL PlanetButton(const char *name)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_PLANET_BUTTON, "", 0, 0);
}

static void ES_CALL Panel(const char *name, int32_t button)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_PANEL, "", button, 0);
}

static int32_t ES_CALL CanOutfitter(const char *name, const char *outfit)
{
	Mod *mod = FindMod(name);
	if(!mod)
		return 0;
	/* A mod with no can_outfitter has its button enabled when it has on_outfitter. */
	if(!(mod->hooks & BIT(H_CAN_OUTFITTER)))
		return (mod->hooks & BIT(H_OUTFITTER)) ? 1 : 0;
	return RunHook(mod, H_CAN_OUTFITTER, outfit, 0, 0) == 1;
}

static void ES_CALL Outfitter(const char *name, const char *outfit)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_OUTFITTER, outfit, 0, 0);
}

static void ES_CALL Confirm(const char *name, int32_t token)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_CONFIRM, "", token, 0);
}

static void ES_CALL PanelRow(const char *name, int32_t row)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_PANEL_ROW, "", row, 0);
}

static void ES_CALL PanelHeader(const char *name, int32_t column)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_PANEL_HEADER, "", column, 0);
}

static void ES_CALL Number(const char *name, int32_t token, int32_t value)
{
	Mod *mod = FindMod(name);
	if(mod)
		RunHook(mod, H_NUMBER, "", token, value);
}

static void ES_CALL Shutdown(void)
{
	WdStop();
	for(int i = 0; i < modCount; ++i)
	{
		free(mods[i].name);
		free(mods[i].path);
	}
	free(mods);
	mods = NULL;
	modCount = 0;
	esmod_shutdown();
}

ES_LOADER_EXPORT int32_t ES_CALL es_loader_init(const EsHost *host, EsLoader *loader)
{
	if(!host || !loader)
		return 1;
	if(host->size < offsetof(EsHost, version) + sizeof(host->version) || host->version < ES_API_VERSION)
		return 2;
	const char *missing = es_shim_missing(host);
	if(missing)
	{
		if(ES_HOST_HAS(host, log) && host->log)
		{
			char text[256];
			snprintf(text, sizeof(text), "%s: the game's host table has no %s; the loader is off", LOADER_NAME, missing);
			host->log(text);
		}
		return 3;
	}
	/* The game must have room for every entry this loader fills. */
	if(!ES_LOADER_HAS(loader, shutdown))
		return 4;
	if(esmod_init() != 0)
		return 5;
	game = host;
	hookLimit = ReadLimit("ES_DADO_HOOK_MS", hookLimit);
	loadLimit = ReadLimit("ES_DADO_LOAD_MS", loadLimit);

	EsLoader mine;
	memset(&mine, 0, sizeof(mine));
	mine.size = (uint32_t)(loader->size < sizeof(mine) ? loader->size : sizeof(mine));
	mine.version = ES_API_VERSION;
	mine.name = LOADER_NAME;
	mine.load_mods = LoadMods;
	mine.count = Count;
	mine.step = Step;
	mine.day = Day;
	mine.enter = Enter;
	mine.planet_button = PlanetButton;
	mine.panel = Panel;
	mine.can_outfitter = CanOutfitter;
	mine.outfitter = Outfitter;
	mine.confirm = Confirm;
	mine.panel_row = PanelRow;
	mine.panel_header = PanelHeader;
	mine.number = Number;
	mine.shutdown = Shutdown;
	/* Write no more than the game reserved. */
	memcpy(loader, &mine, mine.size);
	return 0;
}
