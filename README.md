# The Dado loader for Endless Sky

Picking this up cold? Start with [HANDOFF.md](HANDOFF.md).

Endless Sky runs native mod loaders: shared libraries it finds in a
`modloaders` folder and talks to through one C header, `es_api.h` (in the
game's repository, `source/modding/es_api.h` and `docs/modding-api.md`). This
repository is one such loader. It runs mods written in **DadoScript**, the
scripting dialect of [Dado](https://dadolang.com), or in plain JavaScript, in
an embedded QuickJS engine. A mod is a class with hooks the game calls while
you fly; through the `Game` object it is handed, it can read and change ships,
read and write the player's conditions, read the galaxy, change the world as
an event would, spawn fleets, draw on the map, and put buttons, panels and
screens up. Missions and events use the same conditions, so mods and data
plugins talk to each other.

The game knows nothing of Dado: it loads `libesdado.dylib` (macOS),
`libesdado.so` (Linux) or `esdado.dll` (Windows) like any other loader. The
loader speaks mod API 9 (`ES_API_VERSION`), and the mod API only grows: mods
built for an earlier version keep working.

**Writing mods:** modders use the mod SDK (`endless-sky-mod-sdk`), which
targets this loader. It has the SDK, build and test tools, examples and editor
setup for DadoScript, JavaScript and TypeScript, and builds each mod into a
plugin folder (`plugins/<Name>/scripts/<mod>.js`). This page is about the
loader itself.

## How it fits together

```
 Endless Sky (C++)              this loader (one shared library)
 ─────────────────              ─────────────────────────────────────────────────────────────
 ModLoaders (game) ─ es_loader_init(host, loader) ─▶ src/loader.c  fills EsLoader, keeps EsHost
 first hook ──────── load_mods(paths, names) ─────▶ scans <source>/scripts/*.js, loads by name
 Engine step ─────── step / day / enter ──────────▶ for each mod:  hook_timing(mod, hook, 1)
 planet screen, ──── planet_button / panel / ... ─▶                watchdog armed
 outfitter, panels     (per mod, by name)                          esmod_call(slot, hook) ──▶ mod's own engine:
                                                                   watchdog disarmed            Harness ─▶ mod.on_x(game)
                                                                   hook_timing(mod, hook, 0)        │
 EsHost table ◀── es_*() shim (generated from es_api.h) ◀── host_* (host.dado) ◀── Game ◀─────────┘
```

* **`include/es_api.h`** is a copy of the game's API header, the contract.
  `tools/sync-api.sh` keeps it in step with `../endless-sky/source/modding/es_api.h`.
* **`src/loader.c`** is the loader's C side: `es_loader_init`, every
  `EsLoader` entry, finding the mods, the `hook_timing` brackets and the
  watchdog thread.
* **The host shim** (`build/gen/es_host.h`, `es_host_shim.c`) is generated
  from `es_api.h` by `tools/gen-host-shim.cmake` at build time: a plain C
  function `es_<field>` for every function of `EsHost`, forwarding to the
  game's table, and `es_shim_missing()`, which names a function the game's
  table lacks. The harness calls these functions; dadoc checks its
  declarations against the generated header.
* **`harness/`** is a Dado package. `dadoc` transpiles it to one C file
  (`esmod.c`), linked with the QuickJS engine into the library.
  - `entry.dado` exports `esmod_new`, `esmod_prepare`, `esmod_call`,
    `esmod_interrupt` and so on to `loader.c`. Each mod gets a slot: an engine
    (a VM) of its own holding one `Harness`.
  - `host.dado` declares the `es_*` functions and checks every value a script
    passes before it reaches the game.
  - `Game.dados` is the API mods see.
  - `harness.dado` loads one mod into its engine and runs its hooks.
  - `probe.js` asks what a mod object offers, and defines the globals a plain
    JavaScript mod builds on.
* **`sdk/es/`** is what a DadoScript mod builds against: `Mod.dados` (the base
  class), `game.dado` (`Game`'s declarations, generated from the harness) and
  `version.dado` (the mod API version, `MOD_API`).

The game calls the loader only on its main thread, from inside its hooks;
the loader calls the game only from inside those calls. The watchdog thread
never calls the game: it only stops a script.

## Building

You need:

* **The Dado toolchain**, 1.0.0-rc.8 or later:
  `curl -fsSL https://raw.githubusercontent.com/dadolangcom/Dado/main/install.sh | sh`.
  It goes in `~/dado`, with `dado` and `dadoc` linked into `~/.local/bin`, and
  brings its own zig (`~/dado/zig/<version>/zig`).
* **CMake** 3.21 or later, and Ninja (or make); a C compiler; git (the first
  build fetches QuickJS-ng once into `~/.cache/dado-quickjs`).
* **Node** (for `npx esbuild`), or esbuild itself, to build DadoScript mods
  and run the tests.

**Linux:**

```sh
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build                      # build/libesdado.so
ctest --test-dir build                   # the fake-host tests
```

**macOS, on the Mac:**

```sh
./build-mac.sh                           # or the two cmake lines above; build/libesdado.dylib
ctest --test-dir build
```

**macOS, cross-built anywhere zig runs** (Linux, or a Mac without Xcode's
tools), with `tools/zig-macos.cmake`:

```sh
./build-mac.sh                           # off a Mac: build-mac/libesdado.dylib (arm64, macOS 11+)
ZIG_TARGET=x86_64-macos.10.15 ./build-mac.sh   # an Intel Mac's
```

zig links and ad-hoc signs the arm64 dylib itself; no macOS SDK is needed. A
Release dylib is linked with `-Wl,-S` (no debug map, so no build paths in it),
and two clean builds of the same sources give the same bytes (checked with
zig 0.16.0, from different build folders, with one cached engine build).

**Windows** (not tried in the game yet): `tools/zig-windows.cmake` cross-builds
`esdado.dll` with zig (`x86_64-windows-gnu`) and it links:

```sh
cmake -B build-win -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=tools/zig-windows.cmake
cmake --build build-win
```

Everything the DLL needs is linked in statically, as the game requires (DLLs
next to a loader are not searched). `load_mods` scans folders with
`FindFirstFileW`; what is untested is the engine reading a mod by a UTF-8
path on Windows (Dado's `core:io`). A native MinGW build is the same CMake
build with MinGW's gcc.

What the build does: it builds Dado's patched QuickJS with `-fPIC
-fvisibility=hidden` (configure time, cached), transpiles `harness/` with
`dadoc --package --library --target=<triple>`, applies the max-align fix
(`tools/fix-max-align.cmake`), generates the host shim from `es_api.h`, and
links `src/loader.c`, `esmod.c`, the shim and the engine into one library
that exports `es_loader_init` and nothing else (`-Wl,--no-undefined` on
Linux). `ESDADO_TRIPLE` overrides the triple dadoc builds for.

Other targets: `install-loader` (below), `dado_mods` (rebuild the examples'
and the in-game test's `.js`) and `dado_sdk` (regenerate `sdk/es/game.dado`
after changing `Game.dados`).

## Installing

```sh
tools/install.sh                         # the library in build/, to your modloaders folder
tools/install.sh --to <dir> [<library>]  # anywhere else
cmake --build build --target install-loader
```

The game opens every loader in `<resources>/modloaders` and in its config
folder's `modloaders`:

| | |
|---|---|
| macOS | `~/Library/Application Support/endless-sky/modloaders` |
| Linux | `~/.local/share/endless-sky/modloaders` |
| Windows | `%APPDATA%\endless-sky\modloaders` |

The game logs each loader it opens, and the loader logs each mod it loads
(`dado: loaded mod "hull_regen"`). The conditions `"mod loaders"` and
`"mods loaded"` count them for missions. This loader's part of `"mods loaded"`
(`EsLoader::count`) is the mods **running now**: those that loaded (their
`on_load` included), less those the watchdog has stopped since. Refused mods
and mods that failed to load never count; the game asks again every engine
step, as `es_api.h` describes `count`.

**macOS: Gatekeeper and hardened games.** A loader downloaded with a browser
carries the quarantine attribute, and macOS refuses to load a quarantined,
unnotarized library into the game. Clear it before installing:
`xattr -d com.apple.quarantine libesdado.dylib`. A library built on your own
Mac, or copied there with `scp`/`git`, has no such attribute. The dylib is
signed ad hoc only, so a game built with the hardened runtime (as notarized
releases are) loads it only if that build is signed with library validation
disabled (the `com.apple.security.cs.disable-library-validation`
entitlement); a game you build yourself is not hardened and loads it as is.

## Where mods go: `scripts/`

The game hands `load_mods` its sources in load order: its resources folder
(named `""`), then each enabled plugin's folder and name. The loader reads
**`<source>/scripts/<name>.js`** from each:

```
plugins/My Plugin/
    plugin.txt
    data/...                 the usual data files
    scripts/shield_wall.js   a mod named "shield_wall"
```

* A mod's name is its file name without `.js`. The game uses it as the mod's
  identity: its saved data, its buttons and panels, its hook timing.
* A later source's mod **replaces** an earlier one of the same name, as a
  later plugin's data overrides an earlier one's.
* Mods load, and their hooks run, **in name order**, whatever source they come
  from.
* Only regular files named `*.js` count; hidden files (`.x.js`), folders and
  other files are ignored.
* A **zipped plugin** (a `.zip` source) is skipped: scripts are read from
  folders only.

## The sandbox

**Each mod runs in an engine of its own**: a QuickJS VM with its own heap and
its own global object. Mods share nothing but the game: one mod's globals,
prototypes or leftovers are invisible to another, and stopping one mod frees
its whole engine without touching the others. (The engines are small: twenty
mods and the loader take about 14 MB.) Inside one mod's engine everything
persists from hook to hook, so a mod may keep state in module variables or
fields, but not across game runs: what must last goes in conditions or saved
data (see "Persistence").

**What a mod sees.** The `Game` object handed to each hook, and its engine's
global object, which holds:

* the language's built-ins: `Object`, `Array`, `Map`, `Set`, `WeakRef`,
  `FinalizationRegistry`, `Promise`, `Proxy`, `Reflect`, `Math`, `JSON`,
  `Date` (with the real clock), typed arrays, `SharedArrayBuffer`, `Atomics`,
  `Iterator`, `parseInt` and friends, `encodeURI`/`decodeURI`, `btoa`/`atob`;
  and `eval` and `Function`, which compile code at run time;
* what Dado's runtime adds: `print` and `println`, which write to the game's
  standard output (not its log, and not shown to the player), `performance`
  (`performance.now()`), `queueMicrotask`, and `__dados_failure` (the
  runtime's error conversion);
* three globals the loader defines, read-only:

| Global | |
|---|---|
| `Mod` | the base class, the same as the SDK's `es.Mod`: every hook as a no-op, `name()`, `log(game, text)`, `every(step, seconds)`, `player_ships(game)`, and `api_version()` answering the loader's API |
| `MOD_API` | the mod API this loader speaks (9) |
| `es` | `{ Mod, MOD_API }`, so `extends es.Mod` reads as it does in DadoScript |

There is no `console`, no `std` or `os` module, no `setTimeout` or other
timer, no `fetch`, `WebAssembly`, `require` or `process`: no file, network or
process access. A mod may import only `dados:runtime`, Dado's runtime module
(the helpers bundled DadoScript mods use); any other `import` fails the load,
naming it. Promise jobs and finalizers a mod queues run inside its hook calls,
so under the watchdog. A plain JavaScript mod needs no build step at all:

```js
// plugins/My Plugin/scripts/shield_wall.js
export class ShieldWall extends Mod {
    name() { return "shield wall"; }
    on_step(game, step) {
        if (this.every(step, 1.0))
            for (const i of this.player_ships(game))
                game.set_shields(i, game.shields(i) + 10.0);
    }
}
```

A module exports exactly one class. Bundled DadoScript mods carry their own
copy of `es.Mod` and ignore the globals; both kinds load the same way.

**The watchdog.** Every call into a mod runs under a time limit: **250 ms** for
a hook, **2000 ms** for loading a mod (its module's top-level code). A mod
that runs past it is stopped and switched off for the rest of the run, the
other mods' hooks run on, and the log says which mod and hook:

```
dado: mod "spin" ran longer than 250 ms in on_step and was stopped; the mod is now off
```

The limits are set by the environment variables `ES_DADO_HOOK_MS` and
`ES_DADO_LOAD_MS` (milliseconds; `0` switches the watchdog off, which a
debugger session wants).

How it works: one watchdog thread, started with the first call. Before each
call into a mod the main thread arms it with the mod's slot and a deadline,
and disarms it after. If the deadline passes while it is armed, the watchdog
calls `esmod_interrupt` (Dado's `#script_stop(vm, 100)`), still holding its
lock: the engine's interrupt hook raises a stop `Error` in the script at its
next loop or call (so `finally` blocks run), and if the script has not left
within 100 ms (it caught the stop and went on), forces it out with an
uncatchable error. Either way the engine then ends and the call returns
`STOPPED` to the main thread, which closes the `hook_timing` bracket (the
brackets are written by `loader.c` around the call, never by the script, so a
stopped mod cannot leave one open), logs, and drops the mod. Because the
watchdog holds its lock while it stops a script, and the main thread arms and
disarms under the same lock, a stop can never land on a later call or another
mod; a hook that finishes just as the deadline passes is still reported
stopped. The thread sleeps until the pending deadline; the main thread wakes
it only when it sleeps with nothing armed, or when it arms a deadline earlier
than the one the thread sleeps until (a 250 ms hook right after a 2000 ms
load). A later deadline needs no wake-up: the thread wakes at the earlier one,
sees the later one and sleeps again. So it costs a few wake-ups a second, not
one per hook. Everything that runs a mod's code is armed: loading (its
module's top level, its constructor, `api_version`, and the hook check, which
reads the mod's methods and so may run a getter or a `Proxy` trap), every
hook, and the jobs and finalizers those queue. Loading is bracketed with
`hook_timing(mod, "load", 1/0)` before `on_load`'s own bracket. A
stop cannot interrupt the game's own code: a mod blocked inside a slow game
call is stopped when that call returns.

**Memory after unloading.** Dado's runtime allocates its table of script
handles (64 KB, and 48 bytes beside it) with the first engine and keeps it for
the life of the process: it is a global of `core:script` with no call to free
it. `esmod_shutdown` frees every engine, but a game that unloads the library
(`dlclose`) leaves those 64 KB behind, once per load. The game loads its
loaders once per run.

**Not a security boundary.** The engine is the same QuickJS a browser-style
sandbox would use, but the loader has not been hardened against hostile mods
(memory exhaustion, for one, is not limited). Install mods you trust, as with
any plugin.

## The SDK

The mod SDK (`endless-sky-mod-sdk`) targets this loader. Its headline is a
single file, `stub/es.d.ts`, generated from `harness/Game.dados` and
`sdk/es/Mod.dados`: it declares the globals above (`Mod`, `MOD_API`, `es`) and
`Game`, so a plain JavaScript mod gets editor types with no build. Beyond
that it syncs `sdk/es` (`Mod.dados`, `version.dado`; `game.dado` is
regenerated with the doc comments), `harness/Game.dados` and
`include/es_api.h` from this repository (`npm run sync`, from
`../es-modloader` by default), builds DadoScript, JavaScript and TypeScript
mods into one `.js` each, deploys them as `plugins/<Name>/scripts/<mod>.js`,
installs this library (`npm run install-loader`, from `build/` or
`build-mac/`), and has its own fake game for mod tests. When the API grows,
this repository changes first (see "Changing the API"), then the SDK syncs
from it.

## Writing a mod

A DadoScript mod is a directory holding one `.dados` file, whose class extends
`es.Mod`:

```dados
class ShieldWall extends es.Mod

import "imports:sdk/es"

string name():
    return "shield wall"

void on_load(es.Game game):
    log(game, "loaded")

void on_step(es.Game game, int step):
    if every(step, 1.0):
        for i in player_ships(game):
            game.set_shields(i, game.shields(i) + 10.0)
```

Build it (the SDK has its own build; this is the loader's):

```sh
tools/dado-mods.sh mod path/to/shield_wall      # writes path/to/shield_wall/shield_wall.js
```

and ship the `.js` in a plugin's `scripts` folder (see "Where mods go").
`tools/dado-mods.sh plugin <dir>` assembles the examples as such a plugin.

How the build works:

1. `dadoc` checks every call against the SDK. For example, `game.hul(i)` fails
   with *`Game` has no method `hul`* and a *did you mean `hull`?* hint.
2. The mod is built as a JavaScript library (`--emit=js-package`).
3. esbuild then flattens it into one file. That file holds your class, `es.Mod`
   and the parts of Dado's runtime they use, and it imports nothing.
4. The `Game` declarations are not in the output. At run time the mod receives
   the loader's real `Game`.

A built mod is a few kilobytes of plain JavaScript, so one file works on every
platform. Building needs esbuild: on your PATH, through `npx`, or named by the
`ESBUILD` environment variable.

Rules a mod lives by:

* **Extend `es.Mod`, and override what you need.** A file whose class doesn't
  extend it is refused. So is a mod built for a newer mod API than the loader
  speaks, as `es.Mod.api_version()` reports it. Mods built for the loader's
  version or an earlier one run.
* **Take `Game` as a parameter; don't store it.** A script has no null, so a
  field of `Game`'s type can't be declared. The loader passes `Game` into every
  hook.
* **Ship indices are per hook.** `0 ..< game.ship_count()` indexes the ships
  in the current system *for this call only*. An index out of range answers
  zeros or `""`, and writes to it are ignored. In a hook run from the planet
  screen or a panel there are no ships, so `ship_count()` is 0.
* **Spawned ships live only in the system.** `spawn()` works only in flight
  (in `on_step`, `on_day` or `on_enter` run by the engine; on landing it
  answers 0). The ships go into the engine's queue of new ships and appear in
  `ship_count()` from the next step. They exist only while the player is in
  that system: after a jump, landing or loading they are gone, and are not
  saved. Spawn them again from `on_enter` if they should still be there.
* **Failures are contained.** If a mod fails to load or fails in `on_load`,
  the failure is logged and the other mods load anyway. If `on_step`,
  `on_day`, `on_enter` or `can_outfitter` throws, it is logged once and that
  hook is switched off for that mod. A failure in a hook the player starts
  (`on_planet_button`, `on_panel`, ...) is logged and the hook stays on. A
  hook that runs too long is stopped by the watchdog and the whole mod is
  switched off (see "The sandbox"). The game keeps running.
* **Mods see only `Game`.** The loader refuses a mod file that imports
  anything, which keeps mods to the API. It is not a hardened security sandbox,
  so only install mods you trust, as with any plugin.
* **One class per directory.** Every file in a directory belongs to one Dado
  package, so give each mod its own folder.

### Hooks

| Hook | When it runs |
|---|---|
| `on_load(Game)` | once, when the loader starts its mods: on the first landing (a loaded pilot starts on a planet) or at the first engine step in flight, whichever comes first. It runs before any other hook of the mod. |
| `on_day(Game, int day)` | once for each new day, oldest first; `day` counts days since the game's epoch. Days pass when the player jumps or takes off. |
| `on_enter(Game, string system)` | when the player arrives in a system (its true name), on the first step after the mods start, on landing, and again on the first step after taking off or loading. |
| `on_step(Game, int step)` | every engine step (60 per second) while the player is flying and the game is not paused. |
| `on_planet_button(Game)` | when the player clicks this mod's planet-screen button (or presses `K`). |
| `on_panel(Game, int button)` | when the player clicks a button on this mod's panel; `button` is its index, in the order the buttons were added. |
| `can_outfitter(Game, string outfit) bool` | (API 5) every frame the outfitter draws this mod's button: whether it is enabled for the selected outfit (`""` for none). The default answers true. A failure switches the button off. |
| `on_outfitter(Game, string outfit)` | (API 5) when the player clicks this mod's outfitter button. |
| `on_confirm(Game, int token)` | (API 5) when the player clicks OK in a dialog the mod opened with `confirm()`. |
| `on_panel_row(Game, int row)` | (API 6) when the player clicks a row of the table in this mod's panel. |
| `on_number(Game, int token, int value)` | (API 6) when the player answers an `ask_number()` dialog with OK. |
| `on_panel_header(Game, int column)` | (API 7) when the player clicks a column heading of the table on this mod's full screen. |

In each engine step the game runs `on_day` for every new day, then
`on_enter` if the player has arrived in a system since the last step, then
`on_step`. Each hook runs for every mod in turn, in order of the mods'
names (their file names without `.js`).

Some details follow from how the game works:

* **Taking off replaces every ship**, so `on_enter` runs again for the system
  the player took off into. That is where a mod puts back the ships it
  spawned.
* **Landing runs `on_enter`** for the planet's system, with no ships and no
  spawning. It lets a mod put up its planet button even for a pilot that was
  loaded on a planet.
* **A jump in the date of more than a week**, or backwards, is not play: it is
  another pilot or another save. The game runs no `on_day` for it and runs
  `on_enter` again instead, so the mod can look around and rebuild what it
  shows.

### `es.Mod`

| Member | |
|---|---|
| `name() string` | the mod's name, used by `log`; override it |
| `on_load(Game)`, `on_step(Game, int step)` | hooks (API 1); the defaults do nothing |
| `on_day(Game, int day)`, `on_enter(Game, string system)` | hooks (API 2); the defaults do nothing |
| `on_planet_button(Game)`, `on_panel(Game, int button)` | hooks (API 2); the defaults do nothing |
| `log(Game, string)` | log a line prefixed with `name()` |
| `every(int step, float seconds) bool` | true once every `seconds` of game time |
| `player_ships(Game) []int` | the player's ships in the system that are not disabled |
| `api_version() int` | the API the mod was built against; don't override |

These are compiled into each mod, so calling them costs nothing extra. A plain
JavaScript mod gets the same members from the global `Mod`.

### The `Game` API

Systems, governments and fleets are named by their **true names**, the names
in the data files. `system()` is the one exception: it answers the current
system's display name, for showing to the player. `here()`, `system_at()`,
`link()`, `system_government()`, `ship_government()` and everything that takes
a system or a government use true names. An unknown name or an index out of
range answers zeros, `false` or `""`, and changes nothing.

**Messages and state** (API 1)

| Method | |
|---|---|
| `log(string)`, `message(string)` | write to the game log, or show the player a message |
| `step() int` | the engine's step counter: 60 steps per second of game time |
| `system() string` | the display name of the player's system |
| `condition(name) int`, `set_condition(name, v)` | the player's conditions, shared with missions and events |

**Ships in the system** (API 1)

| Method | |
|---|---|
| `ship_count() int`, `flagship() int` | ships in the system; the flagship's index or -1 |
| `ship_name(i)`, `ship_model(i)` | names |
| `is_player(i)`, `is_disabled(i)` | flags |
| `hull(i)`, `max_hull(i)`, `shields(i)`, `max_shields(i)`, `energy(i)`, `fuel(i)` | levels |
| `set_hull(i, v)`, `set_shields(i, v)` | set a level; clamped to `[0, max]` |

**The galaxy** (API 2)

| Method | |
|---|---|
| `day() int` | the date, as days since the game's epoch |
| `here() string` | the true name of the player's system, or `""` |
| `system_count() int`, `system_at(i) string` | every valid, accessible system, sorted by true name |
| `system_government(system) string` | the government a system belongs to |
| `link_count(system) int`, `link(system, k) string` | the systems linked to this one by hyperspace lanes |
| `inhabited(system) bool` | whether the system is inhabited |
| `defense_count(system) int`, `defense_fleet(system, k) string` | the defense fleets of the system's planets, the ones a player fights to dominate them |

**World changes and governments** (API 2)

| Method | |
|---|---|
| `change(text) bool` | apply `text` as the body of an event, as a plugin's event would; false only for an empty body |
| `attitude(government, toward) float` | one government's attitude toward another; below 0 is hostile |
| `reputation(government) float`, `set_reputation(government, v)` | the player's reputation with a government; below 0 is hostile |
| `fleet_strength(fleet) float` | a fleet definition's average strength: the sum of its ships' costs |
| `fleet_stat(fleet, stat) float` | (API 3) a fleet's expected stats, averaged over its variants: `"ships"`, `"hull"`, `"shields"`, `"dps"` (shield plus hull damage per second of its weapons) and `"cost"` are totals; `"speed"` is its ships' average top speed (thrust ÷ drag). 0 for an unknown fleet or stat |
| `system_fleet_count(system) int`, `system_fleet(system, k) string` | (API 3) the fleets that arrive in a system on their own, its `fleet` lines |
| `plugin_enabled(name) bool` | whether a plugin with this name is installed and enabled; a mod can ship a companion plugin as a switch the player flips in Preferences → Plugins (Diplomacy's debug mode works this way) |

`change()` takes the same lines an event holds, for example
`game.change("system \"Alpha Centauri\"\n\tgovernment \"Free Worlds\"")`. The
game wraps them in an unnamed event, applies it at once and adds it to the
pilot, so the change is saved. Anything an event may hold works, including
`visit "<system>"` and `visit planet "<planet>"` lines and condition
assignments. Only an empty body answers false.

Some of the game's conditions are wired to the player's state and can be
written too. For example, `set_condition("credits", n)` sets the player's
credits.

**Spawning, tags and kills** (API 2)

| Method | |
|---|---|
| `spawn(fleet, government, tag, arrive) int` | in flight only: add a fleet to the player's system under `government`, its ships tagged `tag`. With `arrive` they jump in; otherwise they are already there. Answers how many ships were added, counting the fighters and drones in their bays. |
| `ship_tag(i) string` | the tag a spawned ship carries, or `""` |
| `ship_government(i) string` | a ship's government |
| `ship_strength(i) float` | a ship's strength |
| `tag_strength(tag) float` | the strength of the ships in the system with this tag that can still fight |
| `player_kills(prefix) int` | how many ships whose tag starts with `prefix` the player has disabled or destroyed since the last call with this prefix |

A ship counts once for `player_kills()`: disabling it and then destroying it
is one kill. Each call answers the kills since the last call with the same
prefix and resets that count.

**Map overlays** (API 2)

| Method | |
|---|---|
| `map_line(from, to, r, g, b)` | a dashed line from one system to another, with an arrowhead at `to` |
| `map_marker(system, r, g, b, label)` | a ring around a system, with `label` under it |
| `map_detail(system, title, text, r, g, b)` | (API 4) a section of the map's side panel: while the player has `system` selected, the map shows `title` in the colour and `text` (wrapped; `\n` breaks a line) in a panel below the map key, like the vanilla side panels. Sections from every mod stack in order; what doesn't fit above the map buttons is left out with a note. `map_clear` removes them |
| `map_label(system, text, r, g, b)` | (API 9) `text` under a system, in the stack with the markers' labels, with no ring. `""` or an unknown system adds nothing |
| `map_ring(system, scale, r, g, b)` | (API 9) a ring around a system, `scale` times a marker's (clamped to 0.5 .. 3), with no label. Labels on that system start below its largest ring |
| `map_clear()` | remove this mod's lines and markers |

Colours are 0 to 1. Each mod has its own set of overlays. They stay until the
mod clears them and are drawn on every map view (not on the simplified map).
Labels on the same system stack downward.

**Planet button and panels** (API 2)

| Method | |
|---|---|
| `planet_button(label)` | show a button with this label on the planet screen; `""` removes it. Clicking it runs this mod's `on_planet_button`. |
| `panel_open(title, text)` | open this mod's panel with a title and text, or replace its contents if it is open |
| `panel_button(label)` | add a button to this mod's open panel; clicking it runs `on_panel` with its index |
| `panel_close()` | close this mod's panel |

The planet button sits in the free slot above *Depart*, and the `K` key
presses it. When several mods have a button, it reads *Mods* and opens a
chooser with one button per mod.

The panel is a planet sub-panel, like the bank and trading panels: the planet
screen swaps it into its content area (`ModHarness::NewPlanetPanel`, held by
`PlanetPanel`). It shows the title, the text in a scrolling text area, and the
buttons along the bottom, numbered for the keys `1` to `9`. Every other key
passes through to the planet screen, so *Bank*, *Trading*, *Depart* and the
rest work as usual and replace the panel. A panel opens from
`on_planet_button` or `on_panel` (the hooks the player starts), or from
`on_enter` while the player lands, which the planet screen then shows at once.
From any other hook, `panel_open()` can only refresh a panel of the same mod
that is already open. Leaving the panel, or the planet, closes it.

**The outfitter, the fleet and outfits** (API 5)

| Method | |
|---|---|
| `outfitter_button(label)` | a button with this label in the outfitter (`""` removes it), in rows of three above the outfitter's own buttons (up to six mods). It is enabled while the mod's `can_outfitter` says so; clicking it runs `on_outfitter` |
| `outfitter_ship_count() int`, `outfitter_ship(k) string` | in `can_outfitter`, `on_outfitter` and the `on_confirm` they lead to: the outfitter's selected ships as UUIDs, the one in focus first |
| `fleet_count() int`, `fleet_ship(k) string` | the player's ships that are not destroyed, wherever they are, as UUIDs (which last across saving and loading) |
| `fleet_ship_name(ship)`, `fleet_ship_model(ship)` | one of the player's ships' name and model |
| `ship_outfit_count(ship, outfit) int`, `ship_integrated_count(ship, outfit) int` | how many of an outfit (by true name) a ship has installed, and how many of those are integrated |
| `ship_integrate(ship, outfit, scale) bool` | integrate one installed outfit that is not yet integrated; see below |
| `outfit_name(outfit)`, `outfit_category(outfit)` | an outfit's display name and category |
| `outfit_attribute(outfit, attribute) float` | an attribute as in its data; `"mass"` and `"cost"` answer its mass and cost |
| `outfit_is_weapon(outfit) bool` | whether it goes in a gun port or turret mount |
| `confirm(text, token)` | a dialog with OK and Cancel (the default); OK runs `on_confirm` with `token`. Only from a hook the player started |

**Storage, planets, tables and numbers** (API 6)

| Method | |
|---|---|
| `data(key) string`, `set_data(key, text)` | text the mod keeps with the pilot, by key, apart from the conditions missions share (`""` removes a key; up to 4 MB). Saved in the pilot's `mod data` block, percent-encoded so any text survives |
| `planet() string` | the planet the player is landed on (true name), or `""` |
| `planet_name(planet)`, `planet_system(planet)`, `planet_government(planet)` | a planet's display name, system and government |
| `planet_count(system) int`, `planet_at(system, k) string` | a system's planets |
| `planet_service(planet, service) bool` | whether the player may use `"bank"`, `"trading"`, `"job board"`, `"hire crew"`, `"outfitter"` or `"shipyard"` there now: the planet has it and the player has access |
| `panel_columns(headers)`, `panel_row(cells)` | a table in the open panel, under its text: tab-separated headings, then rows. It scrolls with the mouse wheel; the first column is aligned left and cut short, the rest right. Clicking a row runs `on_panel_row` |
| `ask_number(text, token, most)` | the game's number dialog, from 1 to `most`; OK runs `on_number(token, value)`. Only from a hook the player started |
| `screen_open(title, text)` | (API 7) the panel on a full screen of its own, pushed over the planet screen as the outfitter is (`ModScreen`): the title and the table fill the left, the text and the buttons a sidebar on the right. Clicking a heading runs `on_panel_header`; Up and Down step through the rows as clicks; Escape or `panel_close` closes it; `panel_open` goes back to the planet screen's panel |
| `panel_select(row)` | (API 7) show a row of the table as chosen (`-1` for none); the screen scrolls to it |
| `panel_chart(label, values)` | (API 8) a line chart at the top of the screen's sidebar: comma-separated numbers, oldest first; up to three series share a scale, each with a line naming it and its last value |
| `offer_job(name, text) bool` | (API 8) a job on the landed planet's job board, made from `text`, the body of a mission as the game's data writes it, named `"<mod>: <name>"`. Its `on accept`, `on complete` and `on fail` set conditions the mod reads. It leaves with the other jobs on takeoff. Built by `es_offer_job` with `Mission::Instantiate` and `PlayerInfo::AddJob` |

**Shipyard stock, ship models and losses** (API 9)

| Method | |
|---|---|
| `ship_stock_on(on)` | switch shipyard stock on or off for this session: each shipyard shows a count on the hulls a mod tracks and will not sell one at 0; untracked hulls stay unlimited. Not saved, and loading a pilot turns it off: call it from `on_enter`, which runs on every landing (before the planet screen and its shipyard can be used, also for a pilot loaded on a planet) and on the first step after loading in flight |
| `ship_stock(planet, model) int` | a model's count at a planet; -1 when untracked (unlimited) or a name is unknown. Saved with the pilot (`ship stock`), and readable whether or not stock is on |
| `set_ship_stock(planet, model, n)` | set the count; `n < 0` untracks. The shipyard lowers it for each hull bought there (after any used hulls the player sold there). A hull sold there raises it only while stock is on and the shipyard sells and tracks that model; otherwise it joins the used hulls in stock until takeoff |
| `ship_in_stock(model) int` | the used hulls of this model (by its base model) the player sold to the landed planet's shipyard, for sale until takeoff; 0 when not landed or for an unknown model |
| `ship_order_note(planet, model, text)` | what the shipyard says after "This ship is out of stock." in place of "New hulls are on order; check back in a few days." (`""` removes it; not saved) |
| `shipyard_count(planet) int`, `shipyard_model(planet, k) string` | the models a planet's shipyards sell, its own and the ones its conditions open (as the planet screen gathers them), by true name, sorted |
| `model_name(model)`, `model_cost(model) int`, `model_category(model)`, `model_licenses(model)` | a model's display name, full new price (hull and outfits at full price: what a shipyard charges for a new one, `PlayerInfo::NewShipCost`, and exactly what `buy_ship` charges), category, and licenses (comma-separated, as in the data; `""` for none). Models are named by true name: a key of the game's ships, a stock model or a named variant |
| `buy_ship(model, name) bool` | only from a hook the player started: deliver a new ship of this model at the planet the player is landed on, through `PlayerInfo::DeliverShip`, for `model_cost`, named `name` or a random name for `""`. No shop is touched: not the shelf stock, the used hulls or outfits in stock, nor their depreciation records. It sells no licenses: false when the player lacks one, is not landed, cannot pay, or the model is unknown |
| `losses() int`, `loss_model(k)`, `loss_government(k)`, `loss_by_player(k) bool` | the ships destroyed in the player's system since the last engine step whose hooks ran, each ship once (up to 4096), for that step's `on_day`, `on_enter` and `on_step` (0 elsewhere): the stock model's true name (a variant answers its base model), the government it belonged to, and whether the player destroyed it (the actor is one of the player's ships, or fire of the player's government). The player's own ships are included, with the player's government and `loss_by_player` false unless the player's fire did it |

Stock lives in `PlayerInfo` (`ShipStock`, `SetShipStock`, ...) and is shown
and enforced by `ShipyardPanel`; see `PLAN-shipyard-stock.md`. The losses come
from the `ShipEvent::DESTROY` events (`CollectLosses`), the same events that
count `player_kills`. `Engine::Step` hands every step's events to
`ModHarness::CollectEvents`, also when it runs no hooks (paused, the map or a
dialog over the flight view, the step of landing), so none are lost; the
losses are emptied after the next step whose hooks run, and dropped when
another pilot is loaded.

**Integrated outfits** are a game feature mods switch on: `Ship` keeps a count
of integrated outfits per outfit, saved with the ship as
`integrated "<outfit>" <count>` with a `reduction <sum of 1 - scale>` child. An integrated outfit stays
installed (a weapon keeps its hardpoint and shows as usual), but the outfitter
cannot uninstall, sell, store or move it (`Ship::RemovableCount`), mission
actions cannot take it, boarding cannot plunder it, and it cannot be
jettisoned. Its mass and the outfit space it takes up are scaled by `scale`,
each outfit's savings rounded to whole numbers as the game's masses and spaces
are. Weapon and engine capacity, cargo space, and its gun port or turret
mount stay taken: `Ship::IntegrationSavings`, applied in
`Ship::FinishLoading` and `Ship::Integrate`. Ammunition, and anything an
installed outfit stores or fires as ammunition, cannot be integrated: its
count changes in flight. A game without this feature reads such a save with
the outfits installed as usual, removable, and at full mass.

The game also provides two read-only conditions that missions can test:
`"mod loaders"` is how many mod loaders the game opened (formerly `"dado harness"`),
and `"mods loaded"` is how many mods they loaded (formerly `"dado mods loaded"`).

### Persistence

The game saves the pilot, not the mods. What lasts:

* **The player's conditions.** Keep a mod's state in them, with
  `set_condition()`. They are saved with the pilot.
* **`change()` edits.** They are saved with the pilot as events and applied
  again when it loads.
* **Reputations** set with `set_reputation()`, which the game saves as it
  does any reputation.
* **Shipyard stock counts** set with `set_ship_stock()` (API 9). The switch
  that makes shipyards use them, `ship_stock_on()`, and the order notes are
  not saved.

What does not last: spawned ships, map overlays, the planet button and panels.
The mod rebuilds them from its conditions, in `on_enter` (which runs again on
landing, after taking off and after loading another pilot) and `on_day`.


## Performance

A call from a mod into the game is cheap: about 40 ns for a number, 70 ns with
a string argument, against 28 ns for a call that stays inside the script
(measured on 2026-10-27 in an aarch64 Linux VM with the harness and a stub
game); the shim adds one indirect call. What costs is work the game does
inside a call, and what a mod does itself. The game caches lookups for one
run of hooks, and times every hook from the `hook_timing` brackets (it logs
slow hooks and each mod's share of the frame at exit); see the game's
`docs/modding-api.md`.

Per call into a mod the loader takes a lock twice (the watchdog) and calls
`hook_timing` twice. Each mod's engine costs well under a megabyte.

## Tests

```sh
ctest --test-dir build                  # = tools/dado-mods.sh test, plus the header check
tools/dado-mods.sh test                 # ESDADO_LIB=<library> to test another build
tools/dado-mods.sh examples             # rebuild the examples and the in-game test's scripts
tests/ingame/run.sh <endless-sky executable> [<game repository>]
```

* **`test`** builds `tests/fake_host.cpp`, a stand-in game: it fills an
  `EsHost` table over a few fake ships, a small galaxy, planets, shipyards
  and a fleet, `dlopen`s the built loader as the game does and calls
  `es_loader_init`, then hands `load_mods` the sources in
  `tests/sources/` (a resources folder, a plugin holding every example and
  test mod, built into its `scripts/`, a `Zipped.zip` folder and a later
  plugin that overrides a mod), and drives the hooks as the game would: steps
  in flight, new days, jumps, landing, planet buttons, panels, screens, the
  outfitter, dialogs. Then it checks what the mods did. Mod-scoped calls in
  the fake act for the mod of the open `hook_timing` bracket, as in the game,
  so every "lands under the mod's name" check is a check of mod identity. It
  covers:
  - `es_loader_init`: declining an old game, a short or holed host table and
    a small `EsLoader`; writing nothing past its table; exporting nothing but
    `es_loader_init`;
  - the example (`examples/hull_regen`) and the adversarial mods in
    `tests/mods`: one throws, one passes bad ship indices, one does not extend
    `es.Mod`, one claims API 999; the API probes `api2_probe` ... `api9_probe`,
    which call every method and record what they saw in conditions;
  - `scripts/` discovery: name order, a later source replacing a mod, a
    `.zip` source skipped, hidden files, folders and other files ignored, a
    mod that does not compile;
  - plain JavaScript mods on the global `Mod`, `es.Mod` and `MOD_API`
    (`every`, `player_ships`, `log`), that the globals are read-only, and that
    one mod's globals do not reach another;
  - the watchdog: an endless `on_step`, one that catches the stop and spins
    on, an endless `on_load` and a module whose top level never ends are each
    stopped and switched off, their brackets closed, while the other mods'
    hooks run on in the same step and the next;
  - that loading each mod is bracketed as its `"load"`, every bracket was
    closed, never nested, and that no mod-scoped call came outside one.
  - Then, twice (`fake_host --watchdog`, with load/hook limits of 2000/250 ms
    and 300/1000 ms), the mods in `tests/sources-watchdog`: an endless
    `api_version`, a getter and a `Proxy` trap the hook check runs, an endless
    `on_load` and a queued job, each armed right after a longer deadline, and
    an endless first `on_step` after the last load. Each must stop within the
    limit plus 200 ms; a finalizer left pending must not run at shutdown.
* **The in-game test** `"Dado mods - Hull regen example"`
  (`tests/ingame/tests_dado_mods.txt`) flies the real game. `tests/ingame/run.sh`
  runs the game with a temporary resources folder that links everything in the
  game's repository but `plugins/` and `modloaders/` (so the mods and loaders
  installed there stay out of it), copies the game's
  `tests/integration/config` to a temporary folder, adds the
  plugin "Dado mod tests" (`tests/ingame/plugin`, the test, and the mods in
  `tests/ingame/scripts` as its `scripts/`), puts the loader in its
  `modloaders`, and runs the game's integration-test runner (`--test`) on it,
  under `xvfb-run` on a headless Linux. A test mod halves the flagship's hull,
  and the test asserts that a loader is installed, that the mods loaded and
  that the example repairs the hull.

## Changing the API

The game owns the API. To add a function:

1. In the game: add it to the end of `EsHost` in `source/modding/es_api.h`
   (bumping `ES_API_VERSION` for a release that adds to the API) and fill it
   in `ModHarness.cpp`'s host table.
2. Here: `tools/sync-api.sh` copies the header (and fails, so you notice).
   The build forwards the new function automatically (the shim is generated).
3. Declare it in the `foreign` block in `harness/host.dado` as `es_<field>`,
   with a `host_*` wrapper that checks its arguments. A mod-scoped call takes
   no mod argument: the game knows the mod from the bracket. The wrapper needs
   its own name because a `Game` method of the same name would win over it.
4. Add the method to `harness/Game.dados`, with a doc comment (the SDK's
   editor docs come from it).
5. Implement it in `tests/fake_host.cpp` (and, if mod-scoped, a `Scoped_`
   forward in `MakeHost`), with a probe in `tests/mods/`.
6. Raise `MOD_API` in `sdk/es/version.dado`, noting what it added. The harness
   reads the same constant.
7. Run `tools/dado-mods.sh sdk` and `examples`, `ctest`, and commit the
   regenerated `sdk/es/game.dado` and `.js` files. Then sync the SDK: `npm run
   sync` in `endless-sky-mod-sdk` (next to this repository).

**The API only grows.** Never remove a method or a hook, and never change what
one takes or answers: a loader runs every mod built for its version or an
earlier one, and refuses only newer ones.

A new hook needs a field at the end of `EsLoader` in the game, a default in
`sdk/es/Mod.dados` and in `probe.js`'s global `Mod`, a number in
`harness/harness.dado` (`run`, `hook_name`) and in `src/loader.c`
(`HOOK_NAMES`) with an entry that calls `RunHook`, and driving in
`tests/fake_host.cpp`. Run a hook only if the mod has the method: a mod built
for an earlier API bundles an `es.Mod` without it.

## A larger example

A separate project, "Diplomacy" (es-diplomacy), is a mod built on this API that
uses every API 2 feature: it reads the galaxy and its defense fleets, changes
system governments with `change()`, spawns tagged fleets and counts the
player's kills, draws lines and markers on the map, and runs its own planet
button and panels. It keeps its state in conditions and rebuilds the rest in
`on_enter` and `on_day`.

## Dado notes (as of 1.0.0-rc.8)

* `dado build` does not build libraries, so the harness is built with
  `dadoc --package --library --emit=c|h` and Dado's `tools/quickjs/build.sh`.
* `dadoc --emit=h` writes no `extern "C"` guard; only `src/loader.c` (C)
  includes it.
* `dadoc --library` needs `--target=<triple>`: without it the emitted C
  assumes BSD's `arc4random_buf` and does not link on Linux.
* dadoc marks every `export` visible (`DADO_EXPORT`). The library exports
  `es_loader_init` alone: a version script on ELF targets (`src/exports.map`),
  and `-DDADO_EXPORT=__attribute__((used))` for `esmod.c` on macOS, where
  zig's linker has no `-exported_symbol`.
* `#script_stop` ends the whole engine it stops (its heap is freed), so a
  watchdog that stops one mod needs one engine per mod; that is why every mod
  has its own VM.
* An inner class inside a `.dado` class block crashes `dadoc` ("a class block's
  node is one of its file's items"). `harness.dado` keeps its class a top-level
  private class block.
* A `.dados` header cannot be `private`, so classes meant to stay out of the
  SDK are `private class X:` blocks in `.dado` files.
* `const` inside a class is not built yet; use a field.
* A script loaded with `Script.load` may import nothing but the runtime, so a
  mod cannot import `es.Mod` from the loader. A DadoScript mod therefore
  bundles its own copy of `es.Mod` and of the runtime parts it uses, which is
  why the build goes through `--emit=js-package` and esbuild. A failure thrown
  by that copy reaches the harness with its code in the text (`error 70: …`).
  Plain JavaScript mods use the global `Mod` instead (see "The sandbox"); the
  import resolver is left as Dado wrote it.
* The emitted C works out its heap alignment from `long double`, which is 8
  bytes on Apple ARM. The heap then refuses the engine's 16-byte requests, and
  the harness fails with "script: no memory for a VM". `tools/fix-max-align.cmake`
  pins it to 16 after `dadoc` runs; see HANDOFF.md.
* The engine is built with `tools/quickjs/build.sh --extra "-fPIC -fvisibility=hidden"`,
  so it can go into a shared library and none of its symbols leak.
