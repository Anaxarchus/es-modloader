# Moving Argosy to the api11-spec design

Companion to [api11-spec.md](api11-spec.md). It compares the spec with what Argosy actually ships today (`endless-sky` branch `argosy` at `564e81730`, mod API 11, plus the unmerged `api12` branch), and lays out how to get from one to the other without breaking the four mods along the way.

Written 2026-10-29.

---

## 1. Where Argosy is today

**Shape of the ABI.** Two append-only function tables in `source/modding/es_api.h`:

- `EsHost`: 133 C function pointers the game offers (`ship_hull(i)`, `planet_government(name)`, `panel_row(cells)`, …). API 12 (branch) adds 6 more.
- `EsLoader`: 17 entries a loader fills (`load_mods`, `step`, `day`, `enter`, `planet_button`, `panel`, `panel_row`, `panel_header`, `can_outfitter`, `outfitter`, `confirm`, `number`, `save`, `pilot_loaded`, `notification`, `shutdown`).
- Versioning by `size` prefix plus `ES_HOST_HAS`, and `api_has("call:<field>")` as a feature registry.

**Identity.** The loader says who is running: `hook_timing(mod, hook, 1/0)`. The game believes the first loader that claims a name (`ModLoaders::BeginHook`). Mod-scoped calls act for "the last begin".

**Objects.** Ships in the system are indices into a per-step snapshot. The player's ships are UUID strings. Everything else is a true-name string. A returned string lives until the next host call (`Return()` keeps one `std::string`).

**Where the code is.**

| File | Lines | Role |
|---|---|---|
| `source/ModHarness.{h,cpp}` | 129 + 4032 | Everything: the context, observers, every `es_*` call, the UI panels and screens, map overlays, buttons, timing, and the facade the engine calls |
| `source/modding/ModLoaders.{h,cpp}` | | Finds `modloaders/*.{dylib,so,dll}`, `es_loader_init`, bracket ownership |
| `source/modding/ModBus.{h,cpp}` | | The notification bus (the spec's 8.1 is lifted from it almost exactly) |
| `source/modding/ModState.{h,cpp}` | | Mod data, ship and outfit stock, saved inside the pilot file |
| `source/modding/RuntimeDefinitions.{h,cpp}` | | API 11 runtime outfits and ships, saved with the pilot |
| `source/modding/ModApi.h` | 41 | **Untracked.** A stub of the spec's facade (`EngineFrame`, `PanelFrame`), not yet used |

**Upstream footprint.** 29 upstream source files touched outside `source/modding`. In the spec's terms, Argosy is not Level 0. It has already **adopted** most of Appendix A, and more:

| Spec step | In Argosy? | Where |
|---|---|---|
| A1 `mod` nodes in data | No | — |
| A2 mod data in the pilot file, save hook | **Yes** | `PlayerInfo::Save/Load/Clear` → `ModHarness::Saving`, `ModState` |
| A3 explicit lifecycle | **Yes** (no CLI kill switch) | `GameLoadingPanel` → `ModHarness::Init`; `main.cpp` `EndMods` guard |
| A4 hull and shield setters | **Yes** | `Entity.h` `friend ModHarness` |
| A5 definition accessors | **Partly** | `Fleet::Variants`, `Planet::DefenseFleets`, `System::BasePrice` |
| A6 planet-screen slot | **Yes** | `PlanetPanel` button and swapped-in content panel |
| A7 shop slots | **Outfitter only** | `OutfitterPanel` buttons, `can_outfitter`, selected ships |
| A8 map overlays | **Yes** | `MapPanel`, `MapDetailPanel` |
| A9 HUD and keys | No | — |
| A10 job board | **Yes** | `PlayerInfo::AddJob` |
| A11 menu, plugin list | No (the `mod loaders` / `mods loaded` conditions instead) | — |
| A12 event emissions | No | — |
| A13 gameplay features | **Yes** | ship stock and order notes (`ShipyardPanel`), outfit stock (`OutfitterPanel`), `PlayerInfo::DeliverShip`, outfit integration (`Ship`, `BoardingPanel`, `GameAction`), used hulls (patch) |
| *Not in the spec* | **Yes** | API 11: runtime definitions (`friend` in `Outfit`, `Ship`, `Weapon`), outfit give/take/replace, ship reactivation. API 12: installed outfits, weapon stats, fleet ship location |

**The engine call sites.** `Engine::Step` calls `CollectEvents` every frame and `Step` when flying. `Engine::Place` calls `ShipsReplaced`. `PlanetPanel` calls `Landed`. `MainPanel.cpp` is **not** touched: there is no `PanelFrame` yet.

---

## 2. What the spec changes, concept by concept

| Concept | Argosy now | Spec | Size of change |
|---|---|---|---|
| ABI | Two growing function tables | One `es_call(address, op, in, out)` over POD structs with `EsHeader{size, version}` | Total rewrite of the header; the semantics underneath mostly survive |
| Who runs a hook | Loader brackets itself with `hook_timing`; game trusts the first claim on a name | Game opens every bracket itself and calls the mod's `dispatch(address, op, …)` | **Biggest semantic change.** `ModLoaders`' ownership, `CallScope`, `BeginHook`/`EndHook` go away |
| What a mod is | A name a loader mentions | A registry entry with an address, descriptors, ops, deps | New `ModRegistry` |
| Where native code lives | `resources/modloaders/`, `<config>/modloaders/` | Inside plugins, declared by `<plugin>/mod.txt`, copied to `native-cache/<sha256>/` | New `ModDescriptors` and `ModNative`; release packaging changes |
| Script mods | Invisible to the game; Dado runs them all behind one table | Dado registers each one in `HOOK_DISCOVER` (`REGISTER_MOD`, `dispatch = NULL`) | Dado's per-hook probing (`esmod_has`) moves to registration |
| Hook presence | Game calls every loader's entry; the loader probes each mod | Game calls only mods that registered the hook op | Cheaper per step |
| Order | Loaders by file name, mods by loader; bus by mod name | Kahn over `plugin.txt` + `mod.txt` deps, name tie-break | New sort; bus switches to resolved order |
| Ships | Index into this step's snapshot | `EsHandle` (type, generation, slot), `weak_ptr` slots | New `ModHandles`. Argosy's `tagged` map of `weak_ptr` is the seed |
| Definitions | True-name strings | Handles via `FIND`; records carry the name as `key` | Bindings can keep accepting names |
| Reads | ~100 scalar getters | ~24 typed records + `ATTRS` + list ops; Tier 1 later | Fill functions are mostly the bodies of today's `es_*` getters |
| Returned strings | Valid until the next call | Valid until the hook returns (per-hook arena) | Removes the `Return()` trap |
| Writes | Each setter checks its own context ad hoc (`context->ui`, `landing`, `outfitterShips`, `saving`) | `SET`/`ADD`/… over property ids, actions with typed args, a context mask per op in `ModOps` | The scattered checks become one table |
| UI | `panel_open/button/columns/row/select/chart`, `screen_open`, `confirm`, `ask_number`; `ModPanel`/`ModScreen` | `UI_SHOW` widget trees, `UI_UPDATE`, `HOOK_UI` | The renderers survive; the API in front of them is new |
| Callbacks | One `EsLoader` entry per UI event | `HOOK_UI {slot, instance, widget, action, value}`; `HOOK_QUERY` for `can_outfitter` | Collapses 8 entries into 2 hooks |
| Capabilities | `api_has("call:…")`, feature names | `LOOKUP(kind, name)`, `LIST_IDS` | Same idea, typed |
| Persistence | `ModState` inside the pilot file (A2) | Sidecar at L0, pilot file with A2 | **Keep A2.** The sidecar exists only to avoid touching `PlayerInfo` |
| Lifecycle | Explicit init and shutdown (A3) | Lazy start, `atexit` at L0; explicit with A3 | **Keep A3** |
| Caching | A per-run `Caches` struct already exists | Core caches nothing; caching is a layer | Keep the per-run cache as a hidden detail. The ABI allows it (lifetime is "until the hook returns") |
| Timing | Game times brackets the loader opens | Game times brackets it opens | Same tables, simpler source |

---

## 3. Decisions to make before writing code

1. **Version number.** The spec calls itself API 11, but Argosy shipped API 11 on 2026-10-28, and API 12 sits on a branch. Recommendation: merge `api12` in the old style, and make the new ABI **API 13**. Set `ES_API_MIN_VERSION` to 13 as well: the spec's `ES_API_MIN_VERSION 9` contradicts Appendix B's "no compatibility layer".
2. **How much of Level 0 to pursue.** The spec optimises for a tiny upstream footprint. Argosy already pays for 29 files, and its mods depend on most of the adopted features. Two ways forward:
   - **(a) Argosy profile (recommended).** Keep every adopted call site. Re-home it behind the `ModApi` facade, and report each one as present through `LOOKUP(feature, "adopted:…")`. The footprint shrinks only where L0 gives the same result for free, for example by moving `Landed`/`ShipsReplaced` to observation inside `EngineFrame`/`PanelFrame`.
   - **(b) Strict L0.** Drop the adopted hooks and lose the planet and outfitter buttons, map overlays, stock, integration, job offers and delivery. Corporations, Diplomacy and Outfit Integration all break. Not worth it for a fork.
3. **Gameplay features versus API.** Stock, integration, used hulls and runtime definitions are engine features. Keep them in the engine (or in `patches/`), and expose them through properties and actions, as A13 intends. They stay out of the API's core.
4. **Transition strategy.** The spec says "no compatibility layer". Agreed for the shipped product, but not for the migration itself. During the migration, keep the old `EsHost` table alive as a thin wrapper over the same internal functions as the new ops. The existing suites (`tests/modloader/*`, Dado's `fake_host` and in-game probes) then act as an oracle at each step, and get deleted at the cutover.
5. **Bundling Dado.** Spec 7.6 refuses native code from the game's resources folder. Releases should ship Dado as a **global plugin**, `resources/plugins/Dado/`. `GameData::LoadSources` loads `Files::GlobalPlugins()`, and those are not source index 0. The `fetch-modloader` action and `fork_release.yaml` change accordingly. The macOS signing step must sign the library inside the plugin. The cache copy keeps the signature.

---

## 4. File mapping

| Today | New home (spec section 17) | Notes |
|---|---|---|
| `ModHarness.h` facade | `modding/ModApi` | Finish the stub. `EngineFrame` merges `CollectEvents` + `Step`. Keep Argosy's extra entry points (`Saving`, `DrawMap`, `PlanetButtonLabel`, `OutfitterButtons`, …), each tagged with its adoption step |
| `ModHarness.cpp` `Context`, `State`, `Start`, `CheckPilot`, `SyncDay`, `lastDay`/`lastSystem` | `ModContext`, `ModObserve` | `ModState::Generation()` stays the pilot signal: it is exact, and better than the spec's condition-pinned observation |
| `ModHarness.cpp` timing (`timings`, `sectionTimings`, `frameShares`, `CallTimer`) | `ModTiming` | Unchanged logic. The bracket now comes from `ModHooks`, not `hook_timing` |
| `es_*` getters | `ModRecords` (fill functions) | One record per group, as in section 5 below |
| `es_*` setters and actions | `ModWrites` | Context checks move into `ModOps` masks |
| `tagged`, `fleetByUuid`, index snapshot | `ModHandles` | |
| `stepLosses`, `kills`, `lostShips` | `ModObserve` → `STEP_LOSSES`, `KILLS`, `TAG_STATS` | |
| `ModView`/`ModPanel`/`ModScreen`, `NumberRequest`, confirm | `ModUi`, `ModPanel`, `ModDialog` | The renderers survive. They take an `EsUiNode` tree instead of call-by-call state |
| `overlays`, `details`, `planetButtons`, `outfitterButtons` | `ModUi` slots `map.layer`, `map.detail`, `planet.button`, `outfitter.button` | All adopted, all present |
| `Features()` | `ModIds` (features) | |
| `ModLoaders` | `ModNative` + `ModRegistry` + `ModHooks` | Ownership logic deleted |
| `ModBus` | `ModBus` | Key by address; deliver in resolved order |
| `ModState` | stays; mod-data part behind `STORAGE_GET` / `SET mod.data` | Stock behind `planet.ship_stock` / `planet.outfit_stock` properties |
| `RuntimeDefinitions` | stays; behind new actions (section 5) | |
| — | `es_api.h` (new), `ModLimits.h`, `EsLayout`, `ModSha256`, `ModArena`, `ModOps`, `ModIds`, `ModDispatch`, `ModDescriptors` | New |

Moving `ModHarness.*` into `source/modding/` also shortens the upstream-merge surface to the call sites alone.

---

## 5. Every current call, mapped

Spec Appendix B maps API 10. Below are the API 10 groups it already covers, then **what it is missing**.

**Covered by spec ops as written:** ship scalars (`SHIPS_IN_SYSTEM`/`SHIP_STATE`), systems, planets, fleets (`FLEET_INFO`; the averaged stats are present in Argosy through `Fleet::Variants`), outfits (`OUTFIT_INFO`, `ATTRS`), models, shipyards, conditions, reputation and attitudes, `spawn`, `change`, park/remove, losses/kills/tag strength, trade and commodities (`MARKET.base_price` is present through `System::BasePrice`), cargo, data, bus, `api_has`, `timing_section`, `log`, `message`, map overlays, planet and outfitter buttons, `outfitter_ship*` (`OUTFITTER_SELECTION`), `offer_job`, `ship_integrate` (`INTEGRATE_OUTFIT`), `set_hull`/`set_shields` (`SET ship.hull`, present through A4), `set_ship_stock`/`set_outfit_stock`, `ship_order_note`.

**`EsLoader` entries:**

| Entry | Op |
|---|---|
| `load_mods` | `HOOK_DISCOVER {sources}` on Dado, then `HOOK_START` per mod (`on_load`) |
| `count` | Gone. The game counts registry entries in state `RUNNING`; the `mods loaded` condition reads that |
| `step`, `day`, `enter` | `HOOK_STEP`, `HOOK_DAY`, `HOOK_ENTER` |
| `planet_button`, `panel`, `panel_row`, `panel_header`, `confirm`, `number`, `outfitter` | `HOOK_UI` with `slot` + `action` (`click`, `row`, `header`, `answer`, …) |
| `can_outfitter` | `HOOK_QUERY` (runs every outfitter frame: it must be cheap, as today) |
| `save`, `pilot_loaded`, `notification`, `shutdown` | `HOOK_SAVE`, `HOOK_PILOT_LOADED`, `HOOK_NOTIFICATION`, `HOOK_SHUTDOWN` (with world access, thanks to A3) |

**Gaps: calls the spec does not cover.** Each needs an addition to the spec.

| Current call (API) | Proposed |
|---|---|
| `ship_stock_on`, `outfit_stock_on` (9, 10) | Properties `game.ship_stock_tracking`, `game.outfit_stock_tracking` (set, not saved), A13 |
| `ship_stock`, `outfit_stock` reads (9, 10) | `stock` field in `SHIPYARD_LISTING`/`OUTFITTER_LISTING`, already sketched as A13 |
| `ship_in_stock` (9, used hulls) | `used` field in `SHIPYARD_LISTING`; feature `adopted:used_hulls` (present only with the patch); `ES_UNSUPPORTED` otherwise |
| `ship_integrated_count` (5) | `integrated` field in the `SHIP_OUTFITS` entries |
| `buy_ship` (9) | `BUY_SHIP` with `mode`: `DELIVERY` (Argosy's `DeliverShip`, the default; this answers spec open question 4) or `SHIPYARD` (`PlayerInfo::BuyShip`) |
| `outfit_give(outfit, n, "cargo"/"storage")` (11) | **Conflict:** the spec's `GIVE_OUTFIT` 458 *installs* on a ship. Give it a `where` enum: `INSTALLED` (needs a ship), `CARGO`, `STORAGE` |
| `outfit_take(outfit, n, from)` (11) | New `TAKE_OUTFIT` 460: `from` = `CARGO`, `STORAGE`, `ANY`; context any with a world, not S |
| `ship_replace_outfit` (11) | New `REPLACE_OUTFIT` 461: `{ship, from, to, count}` → count; L U, not O |
| `define` (11) | New `DEFINE` 462: `{text}` → count; saved with the pilot (`RuntimeDefinitions`) |
| `define_outfit_variant`, `define_ship_variant` (11) | New `DEFINE_VARIANT` 463: `{kind, name, base, changes}` |
| `defined(kind, name)` (11) | `origin` field (`DATA`, `RUNTIME`) in `OUTFIT_INFO`/`MODEL_INFO`, plus `FIND` answering `ES_NOT_FOUND` for stale ones |
| `ship_reactivate(i, gov, personality)` (11) | New `REACTIVATE_SHIP` 464, F only |
| `ship_distance`, `ship_x`, `ship_y` (11) | `ShipState`: `x`, `y` already there; append `distance` (to the flagship, -1 when absent) |
| `ship_energy_fraction`, `ship_fuel_fraction` (10) | Drop: computable from `ShipState` levels and maxima |
| `ship_outfit_kinds`, `ship_outfit_at` (12) | `SHIP_OUTFITS` 311 (already in the spec) |
| `outfit_weapon_attribute(outfit, key)` (12) | `ATTRS` with a selector `ES_ATTRS_WEAPON`: about 100 string keys with derived values (range, damage including submunitions). A string-keyed map, exactly what `ATTRS` is for |
| `fleet_ship_planet`, `fleet_ship_system` (12) | `FleetShip.system`/`.planet` (already in the spec) |
| `player_kills(prefix)` (2) | `KILLS {prefix}` + `RESET_KILLS {prefix}`. Today's read-and-reset becomes two calls; Dado's `Game` can keep the old method |
| Panels in the planet content area (6, 7) | Slot `planet.panel` (A6): today's `ModPanel` swapped in by `PlanetPanel`. The spec's `mod.panel` is a pushed window, which is different |
| `system_name()` (1, display name) | `SystemInfo.display_name` |

Codes 460–464 sit in the spec's free action block. The IDs are only a suggestion until the header is written.

**Behaviour changes worth taking from the spec:**

- `APPLY_EVENT` in flight. Argosy's `es_change` calls `PlayerInfo::AddEvent` immediately, even in flight. The spec defers it to `PanelFrame`. Decide whether the deferral is needed (and add the `MainPanel::Step` call), or document that the immediate apply is safe.
- Context masks. Today "a hook the player started" is `context->ui != nullptr`, checked by hand in each call. Map the context fields onto spec contexts: `ui` → U, `landing` → L, `outfitterShips` → O, `saving` → S, `newShips` → F. Most of the context checks in `ModHarness.cpp` then become one table.

---

## 6. Migration phases

Each phase ends with the existing tests green. That is the point of keeping the old table until phase 5.

**Phase 0: paper (a few days).**
- Renumber the spec to API 13. Fix the errata in section 7 below. Add the section 5 gaps.
- Add an "Argosy profile" appendix: which adoption steps this build provides.
- Merge `api12`.

**Phase 1: restructure, no ABI change (about 1–2 weeks).**
- Split `ModHarness.cpp` into the `source/modding/` files of section 4.
- Make `ModApi` the facade, and keep `ModHarness` as a forwarding shim only until the call sites are renamed.
- Each `es_*` function becomes a one-line wrapper over an internal function in `ModRecords`/`ModWrites`.
- *Check:* `tests/modloader/run.sh`, `api11/run.sh`, `api12/run.sh`, Dado's `fake_host` and `tests/ingame/*` all pass unchanged.

**Phase 2: the new ABI beside the old (about 4–5 weeks).**
- Write the new `es_api.h` (move the old one to `es_api_v1.h` for now), then `ModArena`, `ModHandles`, `ModOps`/`ModIds`, `EsLayout` and `ModDispatch`.
- Implement each op by calling the same internal functions as the phase 1 wrappers. Both ABIs then share one implementation, and each new op can be checked against its old call.
- Add the spec's conformance and table-sync unit tests (20.1).

**Phase 3: registry and native loading (about 3–4 weeks).**
- Write `ModDescriptors` (`<plugin>/mod.txt`), `ModRegistry` (both sorts, `EsDepResult`, withdraw), `ModNative` (cache copy, sha256, `es_mod_init`) and `ModHooks` (game-owned brackets, `ES_STOPPED`).
- The legacy `modloaders/` path keeps running in parallel.
- *Check:* the spec's test library (20.2) loads from a test plugin, registers a sub-mod in `HOOK_DISCOVER`, and gets hooks in resolved order.

**Phase 4: port Dado (es-modloader; about 2–3 weeks).**
- Export `es_mod_init` and add `mod.txt`.
- In `HOOK_DISCOVER`, scan `scripts/*.js` and call `REGISTER_MOD` per mod, with its hooks taken from the class's methods (today's probe, moved to load time).
- Dispatch by address. Drop `hook_timing`. Return `ES_STOPPED` from the watchdog.
- Rewrite `harness/Game.dados` over the ops, but **keep the JS-facing method names**: `game.hull(i)` reads a `SHIPS_IN_SYSTEM` array cached for the hook, and `game.planet_government(name)` does `FIND` then `PLANET_INFO`. es-mods and the SDK typings then barely change, and their tests (`fake-game.js`) keep working. Add record-returning methods beside them for new code.
- Replace the generated host shim with Dado's `foreign` import of `es_api.h`.
- *Check:* all four mods (corporations, diplomacy, outfit_integration, shoal) run in-game on the new path, and the API 11 e2e test passes.

**Phase 5: cut over (about 1 week).**
- Delete `ModLoaders`, `EsHost`/`EsLoader`, the `es_*` wrappers, `es_api_v1.h`, the `modloaders/` folders and `tests/modloader/api*`.
- Ship Dado as `resources/plugins/Dado/`. Update `fetch-modloader`, `fork_release.yaml`, `docs/modding-api.md` and `ARGOSY.md`.

**Phase 6: layers, as needed.** Events (cheap: the observers already exist), queued writes, Tier 1, settings, routed calls.

**Note on the UI kit.** The UI kit is not optional for Argosy. All four mods open panels or screens, and three use map overlays, so `UI_SHOW` and `HOOK_UI` (with `mod.screen`, `planet.panel`, `dialog`, `map.*`, `planet.button`, `outfitter.button`) belong in phases 2–4, not phase 6. The renderers already exist. The new work is the widget-tree format and diffing it into the existing `ModPanel`/`ModScreen` state.

Rough total to cutover: 12–16 weeks. That is about the spec's 10–13-week core, plus the UI kit, minus what Argosy's existing code gives for free.

---

## 7. Errata in api11-spec.md found along the way

1. **Version collision.** "API 11" is taken (section 3.1). `ES_API_MIN_VERSION 9` contradicts Appendix B.
2. **Function pointers are not 8 bytes.** `EsBoot.es_call` and `EsModReg.dispatch` are bare `EsCallFn` fields. On 32-bit Windows they are 4 bytes, against the rule in 3.2 that every pointer occupies 8 bytes, so the layouts differ by platform. Wrap them in an `ES_PTR`-style union, or a `uint64_t` holder plus a cast macro.
3. **`EsShipState` size.** The fields listed in 5.6 add up to 200 bytes, not 176. `hull` sits at offset 120, not the 96 used as the example in 13.1. (The record is "abridged", but the static-assert examples should agree with it.)
4. **Wrong cross-reference.** 6.6 refers to "section 6.3" for name tie-breaks; that is 7.3.
5. **Leftover name.** 7.5 says "the v2 ABI has no bracket ops".
6. **Not a hook name.** The Diplomacy `mod.txt` example lists `planet_button` under `hooks`. A planet button is a `HOOK_UI` slot, not a hook.
7. **`GIVE_OUTFIT`** (install on a ship) clashes with Argosy's `outfit_give` (to cargo or storage). See section 5.
8. **Bundled native code.** Section 14 and 7.6 never say where *bundled* native code goes. State that global plugins (`resources/plugins/`) are allowed and only `resources/data` is refused.
9. **Missing calls.** Appendix B has no rows for the API 11 and 12 calls (section 5 above).

---

## 8. Open questions for the author

- Defer `APPLY_EVENT` in flight, as the spec does, or keep Argosy's immediate apply? (The first means adding the `MainPanel::Step` call.)
- Keep `Landed`/`ShipsReplaced` as call sites, or observe landing and take-off in `EngineFrame` as the spec does? Observation saves two upstream call sites, but is one frame late.
- Should the stock and integration features keep being core engine changes, or move into `patches/` like used hulls, with the API reporting them through `LOOKUP(feature)`?
- Is `ModState` (in the pilot file) the final word on persistence? If so, delete spec section 11's sidecar from the Argosy profile entirely.
