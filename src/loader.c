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
 *     esmod_call*(slot, "on_...", ...)  the harness runs the hook, by name, in
 *                                 the mod's engine
 *     disarm the watchdog
 *     hook_timing(mod, hook, 0)
 *
 * so the brackets are always closed, even when the watchdog stops the mod,
 * and never nest (calls from inside a hook are refused).
 *
 * Hooks are named, not numbered: RunHook takes the hook's name and its
 * arguments (one int, one string, or a JSON array), and the harness calls the
 * mod's method of that name. Which hooks a mod has is asked by name too, and
 * remembered per mod: the hooks the game's entries run are asked about while
 * the mod loads (under the load's bracket and watchdog), any other on its first
 * call. So a new hook needs an entry here that calls RunHook with its name,
 * and a default in es.Mod; nothing else. */
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

#ifndef ESDADO_MIN_HOST_API
#define ESDADO_MIN_HOST_API 9
#endif

/* The hooks the game's entries run, asked about while each mod loads. A hook
 * not listed here works as well; a mod is asked about it on its first call. */
static const char *const KNOWN_HOOKS[] = {
	"on_load", "on_step", "on_day", "on_enter", "on_planet_button", "on_panel", "can_outfitter",
	"on_outfitter", "on_confirm", "on_panel_row", "on_panel_header", "on_number",
	"on_save", "on_pilot_loaded", "on_notification",
};
#define KNOWN_COUNT ((int)(sizeof(KNOWN_HOOKS) / sizeof(KNOWN_HOOKS[0])))

/* How a hook's arguments reach the mod: one int, one string, or a JSON array;
 * ARGS_STEP is on_step's int, on a fast path of its own (esmod_call_step). */
typedef enum { ARGS_INT, ARGS_STR, ARGS_JSON, ARGS_STEP } ArgsShape;

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
	/* Whether it has each hook, by hook id (HookId): 1, 0, or -1 not asked yet. */
	signed char *has;
	int hasCount;
	int live;
} Mod;

/* Hook names, interned: a hook's id is its index here. The known hooks come
 * first, in their order. */
static char **hookNames;
static int hookNameCount;

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

/* The id of a hook name (HookId), interning it the first time. -1 when out of memory. */
static int HookId(const char *name)
{
	for(int i = 0; i < hookNameCount; ++i)
		if(!strcmp(hookNames[i], name))
			return i;
	char **grown = realloc(hookNames, (size_t)(hookNameCount + 1) * sizeof(char *));
	if(!grown)
		return -1;
	hookNames = grown;
	char *copy = Copy(name);
	if(!copy)
		return -1;
	hookNames[hookNameCount] = copy;
	return hookNameCount++;
}

/* Hooks that are switched off for a mod when they fail once. */
static int OffOnFailure(const char *hook)
{
	return !strcmp(hook, "on_step") || !strcmp(hook, "on_day") || !strcmp(hook, "on_enter")
		|| !strcmp(hook, "can_outfitter");
}

/* Whether a mod has a hook, by id: 1, 0, or -1 when it has not been asked. */
static int Has(const Mod *mod, int id)
{
	return id >= 0 && id < mod->hasCount ? mod->has[id] : -1;
}

static void SetHas(Mod *mod, int id, int has)
{
	if(id < 0)
		return;
	if(id >= mod->hasCount)
	{
		signed char *grown = realloc(mod->has, (size_t)(id + 1));
		if(!grown)
			return;
		for(int i = mod->hasCount; i <= id; ++i)
			grown[i] = -1;
		mod->has = grown;
		mod->hasCount = id + 1;
	}
	mod->has[id] = (signed char)has;
}

static void Drop(Mod *mod)
{
	if(mod->live)
		esmod_drop(mod->slot);
	mod->live = 0;
	for(int i = 0; i < mod->hasCount; ++i)
		mod->has[i] = 0;
}

/* Run one hook of one mod, by its id, with its arguments in `shape`: `a`,
 * `text`, or `text` as a JSON array. Its answer, -1 when it failed, -2 when
 * the watchdog stopped it (the mod is then off), -3 when it did not run (the
 * mod has no such hook, or is off). */
static int RunHook(Mod *mod, int id, ArgsShape shape, const char *text, int32_t a)
{
	if(!mod->live || id < 0 || !Has(mod, id))
		return -3;
	const char *hook = hookNames[id];
	if(inHook)
	{
		Say("dado: mod \"%s\": %s was asked for from inside another hook and did not run", mod->name, hook);
		return -3;
	}
	const int mode = id == 0 ? 2 : OffOnFailure(hook) ? 1 : 0;
	inHook = 1;
	game->hook_timing(mod->name, hook, 1);
	WdArm(mod->slot, hookLimit);
	/* A hook not asked about yet is asked now, in the same armed call. */
	int result = Has(mod, id) < 0 ? esmod_has(mod->slot, id, hook) : 1;
	if(result == 0)
		result = -4;
	else if(result == 1)
	{
		if(shape == ARGS_STEP)
			result = esmod_call_step(mod->slot, a, mode);
		else if(shape == ARGS_INT)
			result = esmod_call_int(mod->slot, id, a, mode);
		else if(shape == ARGS_STR)
			result = esmod_call_str(mod->slot, id, text ? text : "", mode);
		else
			result = esmod_call(mod->slot, id, text ? text : "[]", mode);
	}
	int fired = WdDisarm();
	game->hook_timing(mod->name, hook, 0);
	inHook = 0;
	if(fired || result == -2)
	{
		if(fired)
			Say("dado: mod \"%s\" ran longer than %d ms in %s and was stopped; the mod is now off",
				mod->name, hookLimit, hook);
		else
			Say("dado: mod \"%s\" was stopped in %s; the mod is now off", mod->name, hook);
		Drop(mod);
		return -2;
	}
	if(result == -4)
	{
		/* Asked on its first call: the mod has no such hook. */
		SetHas(mod, id, 0);
		return -3;
	}
	SetHas(mod, id, 1);
	if(result == -1 && mode == 1)
	{
		SetHas(mod, id, 0);
		/* A mod whose can_outfitter fails has its outfitter button disabled. */
		if(!strcmp(hook, "can_outfitter"))
			SetHas(mod, HookId("on_outfitter"), 0);
	}
	return result;
}

/* A JSON array of strings, ["a","b",...], in memory the caller frees; NULL
 * when out of memory. */
static char *JsonStrings(int count, const char *const *items)
{
	size_t size = 3;
	for(int i = 0; i < count; ++i)
		size += 6 * strlen(items[i] ? items[i] : "") + 3;
	char *out = malloc(size);
	if(!out)
		return NULL;
	char *w = out;
	*w++ = '[';
	for(int i = 0; i < count; ++i)
	{
		if(i)
			*w++ = ',';
		*w++ = '"';
		for(const unsigned char *c = (const unsigned char *)(items[i] ? items[i] : ""); *c; ++c)
		{
			if(*c == '"' || *c == '\\')
			{
				*w++ = '\\';
				*w++ = (char)*c;
			}
			else if(*c < 0x20)
				w += snprintf(w, 7, "\\u%04x", *c);
			else
				*w++ = (char)*c;
		}
		*w++ = '"';
	}
	*w++ = ']';
	*w = '\0';
	return out;
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
	signed char has[KNOWN_COUNT];
	inHook = 1;
	game->hook_timing(found->name, "load", 1);
	WdArm(slot, loadLimit);
	int loaded = esmod_prepare(slot, found->path, found->name);
	/* Which of the known hooks it has, in the same armed call. */
	for(int i = 0; i < KNOWN_COUNT; ++i)
	{
		int answer = loaded == 0 ? esmod_has(slot, i, KNOWN_HOOKS[i]) : 0;
		if(answer == -2)
			loaded = -2;
		has[i] = (signed char)(answer == 1);
	}
	int fired = WdDisarm();
	game->hook_timing(found->name, "load", 0);
	inHook = 0;
	if(fired || loaded == -2)
	{
		Say("dado: mod \"%s\" took longer than %d ms to load and was stopped", found->name, loadLimit);
		esmod_drop(slot);
		return;
	}
	if(loaded < 0)
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
	mod->has = NULL;
	mod->hasCount = 0;
	mod->live = 1;
	/* The known hooks' ids are their indices (interned first, by es_loader_init). */
	for(int i = KNOWN_COUNT - 1; i >= 0; --i)
		SetHas(mod, i, has[i]);
	if(!mod->name || !mod->path || mod->hasCount != KNOWN_COUNT)
	{
		free(mod->name);
		free(mod->path);
		free(mod->has);
		esmod_drop(slot);
		return;
	}
	++modCount;
	if(Has(mod, 0) == 1)
	{
		int result = RunHook(mod, 0, ARGS_JSON, "[]", 0);
		if(result < 0 && result != -3)
		{
			/* RunHook said why; a mod whose on_load fails is not loaded. */
			Drop(mod);
			free(mod->name);
			free(mod->path);
			free(mod->has);
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

/* Every mod's hook, with one int (or none, for "[]" in ARGS_JSON). */
static void EachMod(const char *hook, ArgsShape shape, const char *text, int32_t a)
{
	const int id = HookId(hook);
	for(int i = 0; i < modCount; ++i)
		RunHook(&mods[i], id, shape, text, a);
}

/* One mod's hook, by the mod's name: its answer, or -3 when it did not run. */
static int OneMod(const char *name, const char *hook, ArgsShape shape, const char *text, int32_t a)
{
	Mod *mod = FindMod(name);
	return mod ? RunHook(mod, HookId(hook), shape, text, a) : -3;
}

static void ES_CALL Step(int32_t step)
{
	EachMod("on_step", ARGS_STEP, NULL, step);
}

static void ES_CALL Day(int32_t day)
{
	EachMod("on_day", ARGS_INT, NULL, day);
}

static void ES_CALL Enter(const char *system)
{
	EachMod("on_enter", ARGS_STR, system, 0);
}

static void ES_CALL PlanetButton(const char *name)
{
	OneMod(name, "on_planet_button", ARGS_JSON, "[]", 0);
}

static void ES_CALL Panel(const char *name, int32_t button)
{
	OneMod(name, "on_panel", ARGS_INT, NULL, button);
}

static int32_t ES_CALL CanOutfitter(const char *name, const char *outfit)
{
	Mod *mod = FindMod(name);
	if(!mod)
		return 0;
	/* A mod with no can_outfitter has its button enabled when it has on_outfitter. */
	if(Has(mod, HookId("can_outfitter")) != 1)
		return Has(mod, HookId("on_outfitter")) == 1 ? 1 : 0;
	return RunHook(mod, HookId("can_outfitter"), ARGS_STR, outfit, 0) == 1;
}

static void ES_CALL Outfitter(const char *name, const char *outfit)
{
	OneMod(name, "on_outfitter", ARGS_STR, outfit, 0);
}

static void ES_CALL Confirm(const char *name, int32_t token)
{
	OneMod(name, "on_confirm", ARGS_INT, NULL, token);
}

static void ES_CALL PanelRow(const char *name, int32_t row)
{
	OneMod(name, "on_panel_row", ARGS_INT, NULL, row);
}

static void ES_CALL PanelHeader(const char *name, int32_t column)
{
	OneMod(name, "on_panel_header", ARGS_INT, NULL, column);
}

static void ES_CALL Number(const char *name, int32_t token, int32_t value)
{
	char args[48];
	snprintf(args, sizeof(args), "[%ld,%ld]", (long)token, (long)value);
	OneMod(name, "on_number", ARGS_JSON, args, 0);
}

/* Mod API 10. */
static void ES_CALL Save(void)
{
	EachMod("on_save", ARGS_JSON, "[]", 0);
}

static void ES_CALL PilotLoaded(void)
{
	EachMod("on_pilot_loaded", ARGS_JSON, "[]", 0);
}

static void ES_CALL Notification(const char *name, const char *note, const char *payload, const char *sender)
{
	const char *items[3] = {note, payload, sender};
	char *args = JsonStrings(3, items);
	if(!args)
		return;
	OneMod(name, "on_notification", ARGS_JSON, args, 0);
	free(args);
}

static void ES_CALL Shutdown(void)
{
	WdStop();
	for(int i = 0; i < modCount; ++i)
	{
		free(mods[i].name);
		free(mods[i].path);
		free(mods[i].has);
	}
	free(mods);
	mods = NULL;
	modCount = 0;
	for(int i = 0; i < hookNameCount; ++i)
		free(hookNames[i]);
	free(hookNames);
	hookNames = NULL;
	hookNameCount = 0;
	esmod_shutdown();
}

ES_LOADER_EXPORT int32_t ES_CALL es_loader_init(const EsHost *host, EsLoader *loader)
{
	if(!host || !loader)
		return 1;
	/* An older game than ESDADO_MIN_HOST_API is declined; newer calls are optional
	 * (the generated shim answers 0 or "" for those an older game lacks). */
	if(host->size < offsetof(EsHost, version) + sizeof(host->version) || host->version < ESDADO_MIN_HOST_API)
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
	/* The known hooks' ids are their indices. */
	if(!hookNameCount)
		for(int i = 0; i < KNOWN_COUNT; ++i)
			if(HookId(KNOWN_HOOKS[i]) != i)
				return 6;
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
	mine.save = Save;
	mine.pilot_loaded = PilotLoaded;
	mine.notification = Notification;
	/* Write no more than the game reserved. */
	memcpy(loader, &mine, mine.size);
	return 0;
}
