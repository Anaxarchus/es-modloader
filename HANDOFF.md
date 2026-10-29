# Handoff notes: the Dado loader for Endless Sky

These notes are for picking this work up cold. They cover where things are, how
to build and test, what has been tried, and the traps that already cost time.
[README.md](README.md) is the reference for the loader, the harness and the
mod API; read it next. This file is the working log around it. Entries before
"The split" describe the harness as it was inside the game (`modding/` in the
game's repository); paths there are the old ones.

Last updated 2026-10-28 (mod API 11).

## Mod API 11 (2026-10-28)

Runtime outfits and ships, outfit transfer and waking ships, for the endgame
outfitter and material-to-currency mods. The game's side is on Argosy's `api11`
branch (`docs/modding-api.md`, "Mod API 11"; its C test loader and integration
test in `tests/modloader/api11`); README.md has the mod side.

* **Calls** (all optional here, after `ESDADO_MIN_HOST_API`): `define`,
  `define_outfit_variant`, `define_ship_variant`, `defined`,
  `ship_replace_outfit`, `outfit_take`, `outfit_give` (mod-scoped), and
  `ship_distance`, `ship_x`, `ship_y`, `ship_reactivate`. `host.dado` clamps
  counts (below 1 answers 0 without calling the game) and checks ship indices;
  `ship_distance` answers -1 on an older game (`es_has_ship_distance`). The
  two variant calls and `ship_reactivate` answer bool to mods; the rest int or
  float as the C API. No new hook.
* **Engine behaviour to know** (the game's notes): `ship_reactivate` always
  drops the `derelict` flag; `ship_replace_outfit` needs the ship at the
  player's planet; `outfit_give`/`ship_replace_outfit` refuse maps and
  licenses; an open outfitter or shipyard lists new definitions only when
  reopened.
* **Tests**: `tests/mods/api11_probe` and `TestApi11` in `fake_host.cpp`
  (whose host keeps runtime definitions with the game's refusal rules,
  cargo/storage outfits, ship positions and reactivation), and the probe's
  "old game" path under `--api9-host`.

## Mod API 10 (2026-10-28): loader 0.2.0

Added for the Corporations features and from the API design survey. The game's
`docs/modding-api.md` ("Mod API 10") has the game side; README.md the mod side.

* **Hooks** `on_save` (the game's new `EsLoader.save`, called first thing in
  `PlayerInfo::Save(DataWriter &)`, so mod data written there lands in that
  save), `on_pilot_loaded` (`EsLoader.pilot_loaded`, from `CheckPilot` when
  `ModState::Generation()` moved on: after `load_mods`, before any
  day/enter/step for the pilot) and `on_notification` (`EsLoader.notification`).
* **Calls**: `trade_price`, `trade_base_price` (the engine keeps no pre-event
  price; the base is recovered from price and supply), `commodity_count`,
  `commodity_name`, `cargo`, `ship_park`, `ship_remove`, `ship_parked`
  (player-started hooks only, landed; remove not from the outfitter),
  `outfit_stock_on`, `outfit_stock`, `set_outfit_stock` (OutfitterPanel
  enforces it through two `ModState` helpers; 18 upstream lines), the bus
  (`notify`, `listen`, `unlisten`; the game's `source/modding/ModBus`),
  `has` (`api_has`, the game's `Features()` registry), `timing_section`,
  `energy_fraction`, `fuel_fraction`. `energy(i)`/`fuel(i)` were documented as
  fractions but are absolute; the docs now say so.
* **Older games.** The loader runs on an API 9 game: `es_loader_init` checks
  `version >= ESDADO_MIN_HOST_API` (9, a CMake setting), and the generated shim
  treats every `EsHost` field after the "Mod API 9" heading as optional
  (`es_has_<field>()`, forwards that answer 0/""). `host.dado` answers -1 for
  the calls whose "unknown" is -1. It fills `save`, `pilot_loaded` and
  `notification` only when the game reserved room (it copies `min(size)`).
  Tested by `fake_host --api9-host`.
* **Dispatch by name.** `HOOK_NAMES`, the hook bits and `run()`'s numbered
  chain are gone. `loader.c` interns hook names (`HookId`), remembers per mod
  whether it has each (asked at load for `KNOWN_HOOKS`, under the load's
  bracket and watchdog; any other name on its first call, under its own), and
  calls `esmod_call_int/str` or `esmod_call` (JSON arguments, `JsonStrings`)
  by id; the harness (`probe.js` `name_hook`, `invoke_*`) runs
  `mod[name](game, ...)`. Failure wording comes from the C side's `mode`.
  Measured: the generic int path cost ~10% more per mod and step than the
  numbered one (540 vs 490 ns), mostly the int conversion of the answer
  (dropped for the int path) and the extra JS call, so `on_step` has a direct
  fast path (`esmod_call_step`): 8.3 us per step for 20 mods, against 9.9 us
  with 0.1.0's numbered dispatch (README, "Performance").
* **Version gate.** `Mod.min_api()` (default 1): the harness refuses a mod
  only when `min_api() > MOD_API`. A mod with no `min_api` (built before API
  10) is checked by `api_version()` as before, so nothing that loaded before
  is refused now, and a mod rebuilt with a newer SDK runs on this loader
  unless it says it needs more. `tests/mods/wrong_api` now says min_api 999;
  `future_sdk` and `sources/Test Mods/scripts/legacy_future.js` cover both
  sides; the watchdog's `api_spin.js` spins in `min_api` now.
* **Tests**: `api10_probe`, `api10_pong`, `future_sdk`, `TestApi10` and
  `--api9-host` in `fake_host.cpp` (whose host has a small bus that follows
  the game's `ModBus`). The game's `tests/modloader` tests the real bus across
  two C loaders, an API 9 C loader, and the `Features()` registry.

Review fixes (2026-10-28): the game's bus caps the bytes waiting at 4 MiB
(counting what a cut-off drain holds back); timing section names are capped
at 32 a mod (the rest "(other)") and refuse control characters;
`trade_base_price` reads a new `System::BasePrice` (exact also right after an
event); `ship_remove` refuses ships with mission cargo or passengers, and
`ship_park` refuses the outfitter's hooks too; maps and licenses are never
outfit-stock tracked; the fractions answer 0 with no capacity; the on_save
docs name the real autosave (a mission marked `autosave`), say an in-flight
on_save has no ship snapshot and that its notifications are lost on a pilot
switch or quit. Here: a `min_api()` that is no whole number is logged and
taken as 1 (`tests/sources/Test Mods/scripts/odd_min_api.js`).

Verified on 2026-10-28 in the VM: `tools/dado-mods.sh test` (main, API 9
host, both watchdog runs PASSED); the game built with gcc 13 and `-Werror`
(plain and with `patches/apply.sh apply`), its unit tests, the changed files
with zig clang for Linux and Windows x64/x86, SDL2/SDL3, with and without
`NDEBUG`; the SDK's `npm test`, `check` and `typecheck`. Not done: running it
in the real game (the VM cannot), the macOS dylib.

## Releasing (2026-10-27)

`tools/release.sh <version> [--publish] [--allow-dirty] [--skip-tests]
[--no-universal] [--targets ...] [--repo OWNER/REPO]` builds, checks, tests,
packages and publishes a GitHub release from the Mac (or Linux); see README.md,
Releasing. Pieces:

* `tools/zig-linux.cmake`: Linux with zig, glibc pinned by `ZIG_TARGET`
  (`x86_64-linux-gnu.2.28`). Trap: clang prints the triple for `-dumpmachine`
  with a glibc suffix and then *fails*, which broke Dado's engine build; the
  wrapper in `zig-toolchain.cmake` answers `-dumpmachine` itself for those
  targets.
* zig links its own runtime's DWARF into ELF and PE libraries (6.9 MB instead of
  1.3 MB, with build paths in it), so `-Wl,-S` now applies to every Release
  build, not only macOS. Release builds are stripped of debug information.
* `LOADER_VERSION` (CMake cache, default the project version) sets
  `ESDADO_VERSION`, the "Dado loader <version>" name.
* `tools/release.py`: `inspect` parses Mach-O (and fat), ELF and PE itself
  (exports, minos, GLIBC_ versions, NEEDED, DLL imports, ad-hoc signature,
  version string), since the Mac has no llvm-nm or readelf by default; `lipo`
  writes a fat Mach-O when neither `lipo` nor `llvm-lipo` is there; `pack`
  writes reproducible zip/tar.gz; `sums` replaces sha256sum/shasum.
* Engine cache: Dado keys the QuickJS build by the compiler wrapper's path,
  which is in the build folder, so the script always builds in the same
  `build-release/<target>/` (cleaned each time) to hit the cache.
* zig's Mach-O linker lists `__dso_handle` and `__mh_dylib_header` in the
  export trie; the check allows those two.

Checked in the VM (Linux aarch64, zig 0.16.0) with `tools/release.sh 0.1.0-test
--allow-dirty`: all five targets build and pass every check (arm64 dylib minos
11.0, x86_64 10.15; both .so need only GLIBC_2.17; the DLL imports KERNEL32 and
the UCRT `api-ms-win-crt-*` DLLs only); the universal dylib was made by
`release.py lipo` (`file`: "Mach-O universal binary with 2 architectures"); the
linux-aarch64 build passed the fake-host test; and a second run gave
byte-identical libraries and archives. Not tried: running it on the Mac
itself (zig targeting macOS from a macOS host, Apple's `lipo`), and `--publish`.
The repository has no LICENSE yet; the script warns and ships without one.

## The split (2026-10-27): the loader is its own repository

The modding work was split in three steps:

1. **The game owns a native mod API** (done before this): `source/modding/es_api.h`
   (`EsHost`, the game's 103 functions; `EsLoader`, what a loader offers;
   `es_loader_init`), `source/modding/ModLoaders.cpp` (opens every shared
   library in `<resources>/modloaders` and `<config>/modloaders`),
   `ModHarness.cpp` (the host table, the hooks, mod identity from the
   `hook_timing` brackets, hook timing), `docs/modding-api.md` and
   `tests/modloader/`. Mod-scoped calls (22) lost their `mod` argument: the
   game knows the mod from the open bracket. The game has no Dado in it.
2. **This repository, es-modloader** (this step): the Dado harness as a
   standalone loader library, `libesdado.so` / `.dylib` / `esdado.dll`.
   Everything Dado left the game: `modding/` (harness, SDK, tools, examples,
   tests, these notes) and the in-game test (`tests_dado_mods.txt` and its
   `dado/*.js`, removed from `tests/CMakeLists.txt`). A backup of what was
   removed is in the VM at `~/modding-backup/`.
3. **The mod SDK** (`endless-sky-mod-sdk`, done 2026-10-27): retargeted at
   this repository. `npm run sync` reads `harness/Game.dados`, `sdk/es/*` and
   `include/es_api.h` from `../es-modloader` and records the commit and a hash
   in `sdk.json`; mods deploy to `plugins/<X>/scripts/`; `npm run
   install-loader` copies this library into a `modloaders` folder; and the
   SDK's headline is the one-file stub `stub/es.d.ts` (globals `Mod`,
   `MOD_API`, `es`, and `Game`) for plain JavaScript mods with no build, with
   `stub/es.js` defining the same globals for Node tests.

What changed in the harness on the way:

* **One engine per mod.** `#script_stop` ends the whole engine it stops, so
  the watchdog needed each mod in a VM of its own. `entry.dado` keeps slots
  (a VM and a `Harness` each); `harness.dado` runs one mod. Side effect: mods
  no longer share a realm (no leaking globals or prototype pollution between
  mods). Twenty engines take about 14 MB.
* **The C side is `src/loader.c`**: `es_loader_init` (checks `version >= 9`
  and every `EsHost` function the harness forwards, fills `EsLoader` within
  the game's `size`), `load_mods` (scans `<source>/scripts/*.js`, skips
  `.zip` sources, a later source replaces a mod of the same name, loads in
  name order), every hook entry, and the brackets: `hook_timing` is now
  called from C around each `esmod_call`, never from script, so a stopped
  mod cannot leave one open. The harness's `game.caller` is gone (and with it
  the spoofing hole: a mod could set `game.caller` to act as another mod).
* **The shim is generated** from `es_api.h` by `tools/gen-host-shim.cmake`:
  `es_host.h` (an `es_<field>` prototype per `EsHost` function) and
  `es_host_shim.c` (one-line forwards to the table). dadoc's `_Static_assert`s
  check `host.dado`'s declarations against it.
* **The watchdog**: 250 ms per hook, 2000 ms per mod load
  (`ES_DADO_HOOK_MS`, `ES_DADO_LOAD_MS`; 0 = off). One thread; see README,
  "The sandbox".
* **Globals for plain JavaScript mods**: `Mod`, `MOD_API` and `es`, defined
  read-only in each mod's engine before it loads (`probe.js`
  `install_globals`). Dado's import resolver is unchanged.
* **Mods live in `scripts/`**, no longer `dado/`.
* **Tests**: `tests/fake_host.cpp` (ported from `fake_game.cpp`) `dlopen`s the
  built library and fills an `EsHost`; new tests for `es_loader_init`,
  discovery, override, `.zip`, plain JS mods, realm isolation and the
  watchdog (`tests/sources/`). `tests/ingame/run.sh` runs the in-game test
  against a game build.
* **Builds**: CMake (`CMakeLists.txt`, which replaced `modding/Dado.cmake`).
  The macOS arm64 dylib cross-builds from Linux with the zig the Dado
  installer ships (`build-mac.sh`, `tools/zig-macos.cmake`); a Windows DLL
  cross-builds and links (`tools/zig-windows.cmake`) but is untried.
* **Logs** say "dado:" and the loader names itself "Dado loader 0.1.0".

Review fixes (2026-10-27, after the split):

* The watchdog is woken when a deadline earlier than the one it sleeps until
  is armed (`wd.waitUntil`): before, a 250 ms hook armed right after a 2000 ms
  load waited out the 2000 ms.
* Loading is one armed call that also computes the hook bits (`prepare`
  answers them), so a getter or `Proxy` trap behind the hook check, the
  module's top level and `api_version` are all under the watchdog, and
  bracketed as `hook_timing(mod, "load", 1/0)`. `esmod_hooks` is gone.
* `count()` answers the mods still running.
* `tests/ingame/run.sh` runs the game on a resources overlay without the
  repository's `plugins/` and `modloaders/`.
* Release dylibs are linked `-Wl,-S` and are reproducible.

Open after the split: the in-game test has not been run against the new
library (the VM cannot run the game; run `tests/ingame/run.sh` on the Mac),
nor has the dylib been loaded by the real game yet.

## The goal

Anaxarchus (the owner of this fork) writes Endless Sky mods in his own
language, Dado (https://dadolang.com, toolchain at github.com/dadolangcom/Dado).
Mods are written in DadoScript, the dialect that compiles to JavaScript (or in
plain JavaScript), and run on an embedded QuickJS-ng engine. The game exposes a
C API to native mod loaders; this loader is a Dado package transpiled to C and
linked, with the engine, into one shared library. Mods extend `es.Mod` (or the
global `Mod`), are one `.js` file each, and ship inside an ordinary plugin's
`scripts/` folder (before the split: `dado/`).

We decided on a C ABI harness, not a port of the game to Dado; the split made
that ABI the game's own, loader-neutral API.

## Where everything is

| What | Where |
| --- | --- |
| Game fork | `~/dev/GitHub/endless-sky` on the Mac. Branch `master`, based on upstream `abb41b23`. **Nothing is committed yet**: all of this work is uncommitted changes in the working tree. Ask for a branch name before committing, and push only when asked. |
| Mod SDK | `~/dev/GitHub/endless-sky-mod-sdk` (intended for github.com/Anaxarchus/endless-sky-mod-sdk; not pushed and with no commits yet). It is what modders clone. Read its README and MAINTAINING.md. |
| Diplomacy mod | `~/dev/GitHub/es-diplomacy`, a separate folder and not a git repo. This is deliberate, so a mod gets deployed into the game from somewhere else. |
| This loader | `~/dev/GitHub/es-modloader` (git, `main`; the user commits). |
| Mod API (the contract) | the game's `source/modding/es_api.h`, copied to `include/es_api.h` here (`tools/sync-api.sh`); `docs/modding-api.md` in the game |
| Loader C side | `src/loader.c`; the shim generated by `tools/gen-host-shim.cmake` |
| Harness (Dado) | `harness/`: `entry.dado` (exports, slots), `host.dado` (the `host_*` wrappers), `Game.dados` (the mod API), `harness.dado`, `probe.js` |
| Mod SDK (Dado side) | `sdk/es/`. `game.dado` is generated (`dado-mods.sh sdk`); `Mod.dados` and `version.dado` (`MOD_API = 11`) are written by hand. |
| Build glue | `CMakeLists.txt`, `build-mac.sh`, `tools/` (`dado-mods.sh`, `fix-max-align.cmake`, `gen-host-shim.cmake`, `install.sh`, `sync-api.sh`, `zig-*.cmake`) |
| Example mod | `examples/hull_regen` with the plugin in `examples/plugin` (`dado-mods.sh plugin <dir>`) |
| Tests | `tests/fake_host.cpp`, `tests/mods/*`, `tests/sources/`; the in-game test in `tests/ingame/` |
| Game hooks (in the game) | `Engine.cpp` (Step, Place), `MapPanel.cpp` (DrawMap), `PlanetPanel.cpp` (Landed, the button, key `k`), `main.cpp` (Shutdown), `PlayerInfo.cpp` (conditions `mod loaders`, `mods loaded`; formerly `dado harness`, `dado mods loaded`), `Planet.h/.cpp` (`DefenseFleets()`), `Entity.h` (friend) |

The Mac is an ARM Mac mini. Paths there are under the user's home folder (`~`).
The game's user data is in `~/Library/Application Support/argosy`. Claude's
device bridge cannot read that folder (it is a protected location), so ask the
user for log lines or files from it.

## Building and running

The game builds as plain Endless Sky (no Dado option any more). The loader:

* Mac: `./build-mac.sh` (or `cmake -B build -G Ninja && cmake --build build`),
  then `tools/install.sh` puts `libesdado.dylib` in
  `~/Library/Application Support/argosy/modloaders`.
* Linux, or the VM: `cmake -B build -G Ninja && cmake --build build`;
  `./build-mac.sh` there cross-builds the Mac dylib with zig into `build-mac/`.

Needs: `dado`/`dadoc` 1.0.0-rc.8 (in `~/.local/bin`), CMake and Ninja, a C
compiler, and esbuild (`brew install esbuild` on the Mac; the script falls back
to `npx esbuild@0.24.0`) for the mods and tests. QuickJS is built by Dado's
`tools/quickjs/build.sh` and cached in `~/.cache/dado-quickjs`.

Targets: `esdado` (the library), `install-loader`, `dado_mods` (rebuilds the
test and example `.js`), `dado_sdk`; `ctest` runs the fake-host test.

## Testing

* `ctest --test-dir build` (or `tools/dado-mods.sh test`): the loader in a
  fake host. Fast, no graphics. Also checks `include/es_api.h` against the
  game's (`tools/sync-api.sh --check`).
* `tests/ingame/run.sh <game-binary> [<game-root>]`: "Dado mods - Hull regen
  example" in the real game, with the loader installed in the test config.
* In the game: its unit and integration tests, and `tests/modloader/run.sh`
  (the loader-facing side, with a C test loader).
* Diplomacy: `test/run.sh` runs the simulation against a mock game (Node);
  `test/ingame/run.sh <game-binary> <game-root>` runs 4 real-game tests (War
  Begins, Flotilla In Person, Join And Leave, Debug Mode).

Before the split every one of these ran on Linux in Claude's VM. After it,
the fake-host test runs in the VM (aarch64 Linux); the VM cannot run the
game, so the in-game tests need the Mac.

## Diplomacy

The design is in `es-diplomacy/DESIGN.md` and the behaviour and tuning in its
README. Deploy with
`tools/deploy.sh [--debug] [--user] <game-root> [<plugin-dir>]`. `--debug` also
installs a "Diplomacy Debug" plugin. When the mod sees that plugin enabled
(`game.plugin_enabled`), it starts from day 0 without the Free Worlds campaign.
It gives the Free Worlds their wartime territory and starts a Republic–Free
Worlds war at once, launching flotillas immediately with a message for each.
It also posts a "[Diplomacy debug] Debug mode is on" message.

On the Mac, the deployed plugins are in `endless-sky/plugins/Diplomacy` and
`plugins/Diplomacy Debug`, the repo's global plugins folder, which a game run
from the build tree loads.

Once per pilot (the condition `diplomacy: debug gifts`), debug mode also
reveals the whole map with one `change()` of `visit "<system>"` lines, and adds
100M credits by writing the `credits` condition. `change()` used to refuse an
event with no data changes, which ruled out visit-only events. It now refuses
only an empty body, so this needs a game rebuilt after 2026-10-26.

Members of the Republic are issued Navy licenses by rank (Navy at Lieutenant,
Auxiliary at Captain, Cruiser at Commodore, Carrier at Admiral). During a war,
members get six kinds of faction job: courier, scout ship, scout systems,
medium warship, capital ship and warfleet. The jobs are generated by
`es-diplomacy/tools/gen-jobs.mjs`. The user's direction is "something like
Mount & Blade's system".

Added on 2026-10-26, in the evening (see the Diplomacy README for the detail):

* **Opt-in.** A pilot who finished the Free Worlds campaign is offered
  Diplomacy on landing, in the planet screen's panel. The choices are Turn on,
  Not now (for this session) and Never (`diplomacy: declined`). Accepting makes
  them a Free Worlds **Commodore**. That rank's salary is 8,900, the
  campaign's final salary, paid through the campaign's own `salary: Free
  Worlds`, so a veteran never draws two.
* **Salary curve:** 200, 600, 1,800, 3,600, 6,000, 8,900, 12,000 (the user's
  200 → 600 → 1,800 → 3,600 "etc."; the rest is Claude's extrapolation).
* **Pirate raids** (side 4, slots 1..4), **relief flotillas** (kind 1, rarer
  at war), **named commanders** with personalities (`Admirals.dados`), and a
  **sim score** (`Quality.dados`, from mod API 3's `fleet_stat`) that weights
  a daily winner roll in battles and sieges. Weaker factions field bigger
  flotillas (`Quality.fleet_scale`, `balance_target` 85%), and the Republic
  keeps an edge, as the user wants. The simulation test's mock uses real
  `fleet_stat` values captured from the game (`REAL_STATS` in
  `test/mock.mjs`), so its balance numbers mean something. Rerun the capture if
  the base fleets change.
* **The mod panel is now a planet sub-panel**, swapped into the content area
  like the bank and trading panels (the user asked for this). A mod may also
  open it from `on_enter` while landing. A panel is closed only by the planet
  screen that owns it: loading a pilot builds the new planet screen before the
  old one is destroyed.

State lives in conditions named `diplomacy: …`. Test overrides: `diplomacy: force
active`, `force war` (a*10+b), `force peace`, `force raid`, `force flotilla` (takes effect on
the next arrival).

## Fixed bug (2026-10-26): the harness did not start on the ARM Mac

The user's log:

```
script: no memory for a VM
Dado mod harness did not start (code 1).
```

So no mod ever ran on the Mac. The plugins show in the plugin list because that
list comes from the data files, not from the harness. That is why
"the mods loaded but it's the normal game".

**Cause:** a bug in the C that Dado rc.8 emits. Its runtime prelude defines
`DADO_MAX_ALIGN` as the alignment of a union of `long double`, `void *` and
`long long`. On Apple ARM, `long double` is 8 bytes, so that comes out as 8.
`script.create` asks the heap for `mem.MAX_ALIGN`, which is 16, and the
emitted heap (`dado_rt__heap`) refuses any alignment above `DADO_MAX_ALIGN`, so
every allocation fails. You can check this anywhere with clang:
`--target=arm64-apple-macos11` gives `offsetof(probe, t) == 8`; x86_64 macOS,
aarch64 Linux and x86_64 Linux all give 16.

**Workaround in this repo:** `tools/fix-max-align.cmake` runs after `dadoc`
(from `Dado.cmake`; `dado-mods.sh` does the same with `sed`). It pins the
define to 16, which is what malloc guarantees on every platform the game
supports. Once Dado emits a correct value, the pattern is gone and the step
does nothing. **This should be fixed in Dado itself:** use 16, or `max_align_t`
together with the knowledge that macOS malloc is 16-aligned, or take
`mem.MAX_ALIGN`. The compiler's source is not in the public Dado repo, so the
fix is the user's to make.

**Status:** fixed. After a rebuild, Diplomacy ran on the Mac (the user saw it
working on 2026-10-26).

## The mod SDK (2026-10-26)

The separate repository `endless-sky-mod-sdk` lets people write mods without
the game's source, in DadoScript, JavaScript or TypeScript. It needs Node 18 or
newer (and `dadoc` for DadoScript). It provides:

* `imports/sdk/es/` and `dado.json`. The Dado language server resolves
  `import "imports:sdk/es"` from a project's `imports/` folder, which was
  verified with `dado-lsp`: no diagnostics, and a typo in a Game method is
  flagged. Hover shows only names, not doc comments; that is a dado-lsp
  limitation.
* `js/es.js` (the JavaScript `es.Mod`), `js/es.d.ts` (generated types) and
  `js/fake-game.js` (`FakeGame`, for tests). `npm install` links them as the
  package `es` in `node_modules`.
* `tools/esmod.mjs`, run as `npm run new | build | check | deploy | package`.
  A mod folder (`plugin.txt`, `data/`, `src/`) builds into
  `dist/<Plugin Name>/{plugin.txt,data/,dado/<id>.js}`, which can be dropped
  into `plugins/`. `package` zips it.
* `tools/sync.mjs` (`npm run sync -- <game repo>`) regenerates the SDK from
  `harness/Game.dados`, `sdk/es/Mod.dados` and `version.dado`, and checks
  `es.js` and `FakeGame` against them. **After changing the API here, run it
  there.** It needs every Game method documented, one line per signature.

Facts found by probing the real game, which the SDK relies on:

* The script engine has `print`, `println`, `queueMicrotask` and `performance`.
  It has no `console`, `setTimeout`, `structuredClone`, `Intl`, `URL`,
  `TextEncoder`, `fetch`, `process` or `require`. ES2023 array methods work.
* A Game call with the wrong type throws "`esmod.host_x`'s parameter `v`
  takes an int, and was given a float". A ship index out of range answers ""
  or 0, and does not throw.
* A plain-JavaScript mod that exports one class (including `export default`)
  loads like a DadoScript one. Verified in the game with all three SDK
  examples.

Mod API 4 (2026-10-26, evening) added `map_detail(system, title, text, r, g, b)`:
a section of the map's side panel, drawn by `ModHarness::DrawMapDetails` from
`MapDetailPanel::Draw` below the "orbits and key" box. The user found the long
marker labels cluttered: Diplomacy's markers are now only `Free Worlds flotilla
(small)` and the rest is in the side panel.

Mod API 5 (2026-10-27) added the outfitter button (`outfitter_button`;
hooks `can_outfitter`, `on_outfitter`), the player's fleet by UUID, outfit
queries, `ship_integrate` and `confirm` with the `on_confirm` hook. It is for
the "Outfit Integration" mod (`endless-sky-mod-sdk/mods/outfit_integration`):
integrating an outfit makes it permanent, 25% lighter and 25% smaller in
outfit space (savings rounded to whole numbers; the user does not want weapon
or engine capacity, cargo space or hardpoints changed)
for a fee of a quarter of its cost. The first build saved only mass; the user
reported "no weight freed" and wanted both, so `ship_integrate`'s `mass_scale`
became `scale` (API 5 was unreleased). Saves from that build (a fourth token,
the tons saved) load as the same reduction. The engine side is `Ship::Integrate`,
`IntegratedCount`/`RemovableCount` and the `integrated` save line, enforced in
`OutfitterPanel`, `BoardingPanel`, `GameAction` and `JettisonInstalled`
(README, "Integrated outfits"). The user chose: weapons may integrate and keep
their hardpoint and their place in the UI; ammunition may not; no outfit is
excluded from the mass reduction for now. Verified on 2026-10-27 in Claude's
aarch64 Linux VM: `dado-mods.sh test` (with `test/mods/api5_probe`) passes,
and every changed source passes `g++ -std=c++20 -fsyntax-only` (with SDL2,
OpenAL and GLEW headers fetched for it). The full game was not built there
(the VM has no SDL2 or cmake), so build it on the Mac.

Mod API 3 (2026-10-26) added `fleet_stat(fleet, stat)`, `system_fleet_count` and
`system_fleet`. It needed `Fleet::Variants()` in the game. The SDK is synced to
it.

## Traps already hit

* Endless Sky treats a folder as a plugin only if it has a `data`, `images`,
  `sounds` or `shaders` subfolder. A plugin that holds only `dado/` is ignored,
  so the debug plugin carries a nearly empty data file.
* In ES data text, `_` renders as underline markup, and a token containing
  quotes must be quoted with backticks.
* A `salary: X` condition is paid daily by the game itself.
* The harness starts before a pilot is loaded, so mods see an empty player
  whose date is 0. `SyncDay` treats a jump of more than 7 days, or a date that
  goes backwards, as a new pilot, and resyncs instead of catching up. Mods
  should do nothing while `game.here() == ""`. Diplomacy had activated itself
  on the menu player until this was fixed.
* `on_enter` runs after `on_day` on the step you arrive. Ships spawned on a
  takeoff or jump day are lost when the engine rebuilds its list
  (`ShipsReplaced`), so spawn from `on_enter`.
* The script VM belongs to its thread. Everything runs on the main thread.
* When staging files from the VM to the Mac: stage first, commit in a separate
  call, then compare checksums on the Mac. Doing it in one go sent stale files
  once.
* Dado quirks are listed at the end of README.md: no `extern "C"` in `--emit=h`;
  inner classes crash `dadoc`; there are no private `.dados` headers; there is
  no `const` in classes; a method named like a Dado function recurses (hence
  `host_*`); and mods bundle their own `es.Mod` (js-package plus esbuild).
* In `dado-mods.sh`, a shell function named `esbuild` shadowed the binary, so
  it is now `run_esbuild`.

## Delivered so far

* The harness, the example mod, the presets and the tests in the game repo,
  uncommitted on the Mac. A patch against `abb41b23` is
  `endless-sky-dado-harness.patch` in Claude's outputs (stale after
  2026-10-26; regenerate it with `git diff`).
* The Diplomacy mod with the simulation, in-game and debug tests, deployed in
  the Mac's `plugins/` folder.

* The user's real name was replaced with "Anaxarchus" everywhere at the
  user's request. Use Anaxarchus in copyright headers and plugin authors.
* In-game screenshots and tests load **every plugin in the game folder**. The
  Mac's `plugins/` has `Diplomacy Debug` deployed, which turns on debug mode
  and breaks three of the Diplomacy in-game tests; move it out before running
  `test/ingame/run.sh` against that folder. `Load First Savegame` loads the
  first save in the config, so clear `saves/` between screenshot runs.
* Testing in-game screens: `--test` runs headless. Add `--debug` to get a real
  window under Xvfb, wait about 45 s for loading, then `import -window root`
  captures it. Don't `pkill -f` a pattern that also matches your own shell
  command.

## Performance (2026-10-27)

The user asked whether to put a command buffer under `es.Mod` so that setters
are batched. Measured first (README, "Performance"): a call into the game is
about 40 ns, and appending a command to a script-side array is 50 ns, so a
buffer would cost more than it saves, and it would make reads after writes
stale and break the calls that answer something. Decided instead, with the
user: cache the lookups that walk a list, for one run of hooks
(`Caches` in the `Context`), fix the galaxy list that was never rebuilt after
events, and time every hook (`es_hook_timing`: slow calls logged, a summary at
shutdown). Bulk getters (one call answering a whole list) are the next step if
the timings ever show a mod reading many values each step.

### Diplomacy's on_day was slow (fixed in the game, 2026-10-27)

The user's timing summary: diplomacy on_day 102 ms average, 243 ms slowest (a
hitch on every jump with a capture). The dev build's per-call profile settled
it: `es_change` 5 calls, 327 ms, 65 ms each (Debug build). A capture is
`change()` with `system "X"` / `government "Y"`, and `PlayerInfo::AddChanges`
treated every `system` node as moving the galaxy: `GameData::UpdateSystems`
(every system's neighbors for every jump range, and every planet's
FinishLoading), rebuilding the seen systems, `CacheMissionInformation(true)`
and `RecheckStellarObjects`. None of those read a government, so
`AddChanges` now skips them when a system node only sets `government`
(`OnlyChangesGovernment` in PlayerInfo.cpp). This also speeds up the game's
own story events that hand systems over. Not yet measured in the game after
the fix: ask the user for the next Debug log.

Next in that profile, but spread thin (Debug numbers, unoptimized):
`condition` 40k calls and `system_government` 39k calls at ~2.7 us. In a
release build they cost far less; if they ever matter, Diplomacy can cache
system owners for the day (it reads them through `system_government` again
and again) and clear that on a capture.

## Mod API 6 and the Corporations mod (2026-10-27)

API 6 was added for "Corporations" (`endless-sky-mod-sdk/mods/corporations`),
a stock exchange the user asked for: about 40 companies (the 15 canonical
ones from the game's data never fail) bid for contracts; profits drive share
prices; invented companies go bankrupt or get bought; antitrust breaks up
companies that grow too large (the user's request: over max(35%, 2 / peers)
of a sector's capacity, or 15% of the exchange's value, for 60 days, canonical
companies included); the player trades at an Exchange button on every planet
with a bank. The design doc is a claude.ai Docs artifact, "Corporations &
Stock Exchange - Design Proposal".

API 6: `data`/`set_data` (per-mod text saved with the pilot in a `mod data`
block, percent-encoded by `PlayerInfo`), planets (`planet`, `planet_at`,
`planet_service`, ...), a scrolling table in the mod panel (`panel_columns`,
`panel_row`, hook `on_panel_row`), and `ask_number` with hook `on_number`
(the game's integer dialog; one pending request at a time). Tested by
`test/mods/api6_probe` in the fake game; the save encoding was round-tripped
over every byte value in Claude's VM. The panel table, the number dialog and
the save block are not yet seen in the real game: ask the user how they look.

The mod's simulation was balanced in Node over 3,000 to 8,000 days on a
human-space fixture built from the game's data (`tools/make-galaxy.mjs`):
listed companies stay 38 to 50; per year about 3.6 buyouts, 0.7
bankruptcies, 2 breakups, 2.4 listings; the largest company 12 to 16% of
the market. `tools/balance.mjs` prints a report. In QuickJS (the game's
engine) `on_day` is 2.6 ms on average, 3.6 ms at worst, half of it encoding
the 66 KB state it saves every day.

Mod API 7 (2026-10-27): the user found the exchange in the planet screen's
content area unusable (two companies visible at a time) and asked for a page
of its own like the outfitter's. `screen_open(title, text)` puts the mod's
panel on a full screen (`ModScreen` in ModHarness.cpp, pushed over the planet
screen): the table fills the left, a sidebar holds the text and buttons.
`panel_select(row)` marks a row; heading clicks run `on_panel_header`; Up and
Down step through rows; Escape closes. `ModView` is the base both views share
(table, buttons, clicks). `PanelOpen()` now means the planet screen's own
panel only. The exchange is one screen with Market, Portfolio, Contracts and
News tabs and a sortable market. Not yet seen in the real game: ask the user
how it looks (sidebar width 360, rows of 20 px).

Mod API 8 (2026-10-27): `panel_chart(label, values)` (line charts in the
screen's sidebar, drawn by `ModScreen::DrawCharts`) and `offer_job(name, text)`
(`es_offer_job` wraps the mod's mission text as `mission "<mod>: <name>"` +
`job`, loads it with `Mission`, `Instantiate`s it for the landed planet and
adds it with `PlayerInfo::AddJob`; saved missions are self-contained, and
nothing looks missions up by name, so no data definition is needed). The
Corporations mod uses them: price, index and portfolio charts; jobs carrying
parts to the companies' running contracts (completion sets
`corporations: delivered <id>`, which raises the company's reliability and
cuts its cost); also price impact for the player's trades (2% per 1% of a
company's shares), an exchange index, and turns of fortune (1 in 700 a day
per company; good ones likelier low in a company's 60-day range). Not yet
seen in the real game: the job text through the real mission parser, and the
charts. The user asked whether outfitters have stock counts: they do not
(`Sale<Outfit>` is a set; `PlayerInfo::stock` is only what the player sold).

Mod API 9 (2026-10-27, task B of `PLAN-shipyard-stock.md`) exposes task A's
shipyard stock to mods and adds what the Corporations supply chain needs:
`ship_stock_on`, `ship_stock`, `set_ship_stock`, `ship_order_note` (wraps
`PlayerInfo::SetShipOrderNote`), `shipyard_count`/`shipyard_model` (the
planet's permanent and conditional shipyards, as `PlanetPanel` gathers them,
sorted by true name; cached per `Context` in `Caches::shipyards`, cleared by
`ForgetWorld`), `model_name`/`model_cost`/`model_category`/`model_licenses`,
`buy_ship`, `losses`/`loss_model`/`loss_government`/`loss_by_player`,
`map_label` (a marker's label without its ring: `Overlay::ring`), `map_ring`
(a ring `scale` times a marker's, clamped to 0.5..3, for task C's home
systems; labels on a system start below its largest ring) and
`ship_in_stock` (the used hulls of a model at the landed planet,
`PlayerInfo::ShipInStock`). No new hook, so `entry.dado` and `harness.dado`
are unchanged. Decisions:

* **`buy_ship(model, name)`** runs only in a hook the player started
  (`context->ui`, as `confirm` and `ask_number`) and needs the player landed.
  It is a delivered order, so it goes through the new
  `PlayerInfo::DeliverShip`, not `BuyShip`: the full new price
  (`PlayerInfo::NewShipCost`, the base chassis plus each outfit at full cost,
  which is what `stockDepreciation.Value` answers with no records, i.e. the
  shipyard's price for a new hull), a fresh `depreciation.Buy` with no
  source, and nothing else: the outfit `stock`, `stockDepreciation`,
  `shipInStock` and the shelf stock are untouched. (A first version used
  `BuyShip`, which charged the used price, consumed a used hull's record
  without its listing, and took the default outfits out of the outfitter's
  stock; the review caught it.) `model_cost` answers `NewShipCost`, so task
  C's deposit math is exact. `BuyShip` is unchanged. It sells **no licenses**: the
  player must already hold every one the model needs, so a mod cannot hand out
  Navy hulls; the shipyard's license sale stays the shipyard's. An empty name
  gets a random "civilian" phrase name (`AddStockShip`). Afterwards it calls
  `UpdateCargoCapacities` (as leaving the shipyard does) and clears the fleet
  cache; the planet screen and the outfitter read the fleet every frame, so
  nothing else needs refreshing. Each purchase is logged.
* **Losses** come from the `ShipEvent::DESTROY` events `Engine::Step` hands
  `ModHarness::Step` (the previous calculation's events, before the hooks
  run), collected by `CollectLosses` after `CountKills` and cleared after
  `EndStepTiming`, so the step's `on_day`, `on_enter` and `on_step` all see
  them. Each ship counts once (`lostShips`, held by `weak_ptr` so a reused
  address is not mistaken for the same ship). Weapon hits name only the
  firing government, not the ship, so `loss_by_player` is true when the actor
  is one of the player's ships (`IsYours`) or the actor government is the
  player's, the same rule as `player_kills`. Models are the stock model's
  true name (`TrueModelName`: a variant answers its base model, as the
  shipyard's sell-back does). `Engine::Step` calls
  `ModHarness::CollectEvents` every step, before it decides whether to run
  the hooks, so losses and `player_kills` from steps without hooks (paused,
  map, hail, landing, a dialog) are kept for the next step whose hooks run
  (losses capped at 4096, dropped when `SyncDay` sees another pilot);
  `ModHarness::Step` no longer takes the events. The player's own destroyed
  ships are listed too, with the player's government.
* **The stock switch after loading.** `PlayerInfo::Load`/`Clear` turn it off.
  `ModHarness::Landed` runs from the end of `PlanetPanel`'s constructor and
  always runs `on_enter` (starting the harness first if need be), so a mod that
  calls `ship_stock_on(true)` from `on_enter` has it on before the planet
  screen, and so its shipyard, takes any input; that holds for a pilot loaded
  on a planet (`MainPanel` builds the planet screen after the load) and for a
  new pilot (`StartConditionsPanel` steps the planet screen before pushing its
  shipyard). In flight, `ShipsReplaced` makes the first step run `on_enter`.
  `on_load` runs once per session, so it is not enough on its own; the
  `ship_stock_on` doc comment says so. The harness does not switch stock on by
  itself.
* **`map_label(system, text, r, g, b)`** and **`map_ring(system, scale, r,
  g, b)`**: colours are three floats 0..1 like `map_marker`. A new call rather
  than a size on `map_marker`, because the API only grows: an existing call's
  arguments never change. Labels stack under the system below its largest
  ring.

Verified on 2026-10-27 in Claude's VM: `dado-mods.sh sdk`, `test` (PASSED,
with `test/mods/api9_probe` and `TestApi9`) and `examples` (which also built
the api8 and api9 probes into the integration-test plugin for the first time,
and moved every built mod's `api_version()` to 9); `g++ -fsyntax-only` of
`ModHarness.cpp` with and without `ES_DADO_MODS`. The game was not built.
After the review (DeliverShip, CollectEvents, map_ring, ship_in_stock) the
same checks were run again, plus `g++ -fsyntax-only` of `PlayerInfo.cpp`
and `Engine.cpp`, with the same results.
SDK: `npm run sync` (API 9, 102 Game methods), then on a copy of the SDK
(the mount refuses `dist/`) `npm test` (28 pass, including a new FakeGame
test for API 9), `npm run check` for corporations, diplomacy,
outfit_integration and every example, and `npm run typecheck`. FakeGame has
ship models, shipyard lists on Earth and Vinci, `shipStock`, `orderNotes`,
`purchases` (buy_ship charges the `credits` condition and adds to `fleet`)
and `stepLosses`; `check` reports two losses every 150 steps.

## Ideas not done

* Hot reload: mods load once per run of the game, so changing a mod needs a
  restart. `Script.load` reads the file again each time it is called, so a
  reload command is feasible.
* Show harness failures in the game (a message on first landing, or in the
  plugin list), not only in the log. This one would have saved a round trip.
* Let a host publish classes that loaded scripts may import, so that mods
  don't have to bundle `es.Mod`.
* Diplomacy: more than one war at a time, Free Worlds–Syndicate contact,
  better flotilla AI, faction missions beyond Dispatches.

## Next: shipyards with stock

See `PLAN-shipyard-stock.md`. Task A (the engine: per-planet ship
stock in `PlayerInfo`, shown and enforced in `ShipyardPanel`) is done and
syntax-checked, not yet built or played. Task B (mod API 9, above) is done and
tested against the fake game and the SDK's FakeGame. Task C (the Corporations
mod logic) is not started.
