# Plan: shipyards with stock (Mod API 9 + Corporations supply chain)

**Where the mod lives (2026-10-27):** the canonical source of the Corporations
mod (and of Diplomacy and Outfit Integration) is now the `es-mods` repository,
`es-mods/mods/corporations/`, which vendors the SDK pieces it needs and releases
the mods (`tools/release.sh`). The commands below work there unchanged (run them
from `es-mods` instead of `endless-sky-mod-sdk`); the SDK's `mods/corporations/`
is a copy. This file is kept byte-identical in `es-mods/mods/corporations/HANDOFF.md`
and `es-modloader/PLAN-shipyard-stock.md`.

Status: **Task A done** (2026-10-27, uncommitted): the engine side, in
`PlayerInfo` (`ShipStockEnabled`/`SetShipStockEnabled`, `ShipStock`,
`SetShipStock`, `AddShipStock`, `ShipOrderNote`/`SetShipOrderNote`, the
`ship stock` save block) and `ShipyardPanel`, plus the colours
`shop out of stock` / `shop out of stock tile` in `data/_ui/interfaces.txt`.
Also a ship "in stock" list (sold hulls, like the outfitter's used outfits; see
Task A). Syntax-checked with g++ only; the game has not been built with it yet.
`ShipOrderNote` is the hook for B/C: text that replaces "New hulls are on
order; check back in a few days." for one model at one planet (not saved).
**Task B done** (2026-10-27, uncommitted): mod API 9, with every call in the
table below plus `ship_order_note`, `ship_in_stock`, `map_label` and
`map_ring`, revised after review; tested against the
harness's fake game and the SDK's FakeGame (see `modding/HANDOFF.md`, "Mod API
9", for the decisions). **Task C, first part done** (2026-10-27): C1 (hull
table), C2 (inventory) and C5 (civilian restocks), with tests, a balance run
and QuickJS timing; revised after an independent review (same day: reload
revision, safe deploy, cache test, compact restock records, human shipyards
only, delisted models); deployed to `endless-sky/plugins/Corporations` for
the user to test in the game. **Milestone M1 done** (2026-10-27, uncommitted,
deployed to `endless-sky/plugins/Corporations`): the five quick wins from the
design survey plus C3/C4 (the losses economy), C6 (military tenders), C8 (the
map and its layers) and news with causes and spaceport news; see "M1" after
"Task C progress". **Milestone M2 done** (2026-10-27, built in a copy of
`es-mods`, merged after the M1 release, not deployed): sector balance,
convoys, builder standing and C7 player orders, commodity crises, sabotage
and espionage jobs, and guarded API 10 use; see "M2" after "M1".
**Milestone M3 done** (2026-10-28, in a workspace copy on top of M2, not
merged or deployed): chief executives, board power, shorts and tips,
Diplomacy sanctions and the shortfall, the player's company, refits; see
"M3" after "M2". Before starting, read
`es-modloader/HANDOFF.md` (API 5–9 history; the game's `modding/` folder it
mentions became the `es-modloader` repository on 2026-10-27),
`es-modloader/README.md`, and AGENTS.md and CLAUDE.md in
`endless-sky-mod-sdk/`.

Uncommitted work already in the tree (API 8 and Corporations) must stay as it is.
Nothing has been committed; commit only when the user asks.

## 1. What the user wants (decisions already made)

1. **Stock replaces infinite shipyards.** A shipyard lists every ship it sells, with
   a count. You can't buy a ship whose count is 0, and buying one lowers the count.
2. **Ships stay only at the shipyards that already sell them.** Use the planet's
   existing `Sale<Ship>`; no new shipyard listings.
3. **Scarcity does not change prices** (for now).
4. **Civilian human hulls are IP owned by a canonical shipbuilder** (Lionheart,
   Tarazed, Betelgeuse, Southbound, Megaparsec, Syndicated, and so on). When a
   shipyard runs low, it orders restocks from the IP owner and waits for delivery.
   Lead time depends on the owner's load and health.
5. **Military hulls work differently.** They are issued through government
   procurement **contracts that any shipbuilder can bid on** ("kind of like real
   life"). Military stock comes from those contract deliveries. No single company
   owns a military hull.
6. **Merchant losses are simulated.** There is a baseline loss rate per region,
   raised by piracy and Diplomacy wars. Losses the player **witnessed or caused**
   are added on top. Losses drive demand: shipyards sell ships to NPCs over time,
   faster when ships are being destroyed often.
7. **Player orders when out of stock** are allowed **only at the home planet of the
   corporation that owns the hull**. Use a deposit now and pay the rest on delivery.
   Military hulls cannot be ordered.
8. **The world map lights up the canonical companies' home systems**: a bright ring
   plus a label. Invented companies keep the existing quiet ring.
9. Player-owned corporations and an upgrade outfitter are **deferred**; don't build
   them.
10. **Selling a ship sells the hull to the shipyard and the outfits to the
    outfitter.** The player is paid the normal depreciated value of both, as
    before. The outfits go into the outfitter's existing "in stock" list
    (cleared at takeoff); "Sell Hull" still puts them in storage. The hull is
    restored to its base model and listed in this shipyard, through a ship "in
    stock" list that mirrors the outfitter's (this applies with or without a mod).

## 2. Dev environment setup

The user works on macOS with three repos side by side: `endless-sky/` (the
game, with its native mod API), `es-modloader/` (the Dado loader, a library
the game loads from `modloaders/`) and `endless-sky-mod-sdk/` (the SDK and
mods). A Linux VM works the same way. (Before 2026-10-27 the loader was the
game's `modding/` folder, built in with `-dado` presets; the steps below are
the current ones.)

1. **Dado toolchain** (1.0.0-rc.8 or later):
   `curl -fsSL https://raw.githubusercontent.com/dadolangcom/Dado/main/install.sh | sh`
   - It installs to `~/dado`, with `dado` and `dadoc` linked in `~/.local/bin`.
     Add that folder to PATH.
   - Check with `dado where`, which prints `root=` and `collections=`.
2. **Node 20+** (`brew install node`, or a distro package), then
   `cd endless-sky-mod-sdk && npm install`. That brings in esbuild 0.25.12 and
   TypeScript, and links `js/` as the `es` package.
3. **C/C++ toolchain plus CMake** for the game: the normal Endless Sky prerequisites
   (SDL2, libpng, libjpeg-turbo, libmad, OpenAL, glew, minizip, uuid).
   - On Debian/Ubuntu: `sudo apt install cmake ninja-build g++ libsdl2-dev
     libpng-dev libjpeg-dev libgl1-mesa-dev libglew-dev libopenal-dev
     libmad0-dev uuid-dev libminizip-dev`.
   - On macOS, use the vcpkg-based presets, as in the repo's docs.
4. **Build the game** as usual (its own presets, e.g. `cmake --preset linux`;
   no Dado option), then **the loader**, and install it:
   ```sh
   cd es-modloader
   ./build-mac.sh                     # macOS; Linux: cmake -B build -G Ninja && cmake --build build
   cd ../endless-sky-mod-sdk
   npm run install-loader -- --to ../endless-sky/modloaders
   ```
   - The loader's first configure builds Dado's patched QuickJS into `~/.cache/dado-quickjs`.
   - Debug game builds (NDEBUG not set) print each mod's hook timing and frame share,
     plus the `ES_CALL_TIMER` per-call profile. Use them to check performance.
5. **Loader loop**, which needs no game build:
   ```sh
   cd es-modloader
   tools/dado-mods.sh sdk                # regenerate sdk/es/game.dado
   ctest --test-dir build                # fake host + every test mod
   tools/dado-mods.sh examples           # rebuild committed example .js
   ```
6. **SDK loop:**
   ```sh
   cd endless-sky-mod-sdk
   npm run sync                          # pulls the API from ../es-modloader
   npm test                              # 37 tests incl. mods/corporations/test
   npm run check -- mods/corporations    # 600 steps against FakeGame
   npm run deploy -- mods/corporations --to ../endless-sky/plugins
                                         # without --to it goes to the user's plugins
                                         # folder (~/Library/Application Support/argosy/plugins).
                                         # It copies over the installed plugin in place, then
                                         # removes files the build no longer has (warning if it can't).
   node mods/corporations/tools/balance.mjs   # long simulation, prints yearly stats
   node mods/corporations/tools/make-hulls.mjs ../endless-sky/data    # regenerate src/Hulls.dados
   node mods/corporations/tools/make-galaxy.mjs ../endless-sky/data   # regenerate test/galaxy.json
   qjs --std -m mods/corporations/tools/qjs-time.mjs . 5000 [buy]     # on_day in QuickJS
   ```
7. **Gotchas:**
   - The user's folders may forbid deletes. If `rm` fails, copy over files instead,
     or ask for delete permission.
   - The rules in DadoScript (summarised at the end) cost the most time.

## 3. Work breakdown

### Task A: engine, per-planet ship stock (`source/`)

**Data (PlayerInfo).** Stock is saved with the pilot, so it lives in PlayerInfo
next to `modData`.

- Add these members:
  - `bool shipStockEnabled = false;`, which is not saved. A mod switches it on in
    `prepare`/`on_load` every session, so the game behaves exactly as before
    without the mod.
  - `std::map<const Planet *, std::map<const Ship *, int>> shipStock;`
- Add the API: `ShipStockEnabled()`, `SetShipStockEnabled(bool)`,
  `ShipStock(planet, model) -> int` (-1 means "untracked"), `SetShipStock(...)`,
  and `AddShipStock(planet, model, delta)`.
- **Untracked means unlimited**, so a planet the mod has never seeded still works.
- Save block:
  ```
  "ship stock"
  	"<planet true name>"
  		"<ship model true name>" <count>
  ```
  - Load it in `PlayerInfo::Load` next to `mod data`.
  - Skip planets or models that no longer exist, as `stock` does.

**ShipyardPanel:**

- `DrawItem` (line 107): after `DrawShip`, when stock is on and the count is not
  -1, draw the count on the tile.
  - Format: "3 in stock" in `medium`, or "out of stock" in a warning colour.
  - Draw it bottom-centre, and dim the tile when the count is 0.
  - `ShopPanel::DrawShip` is at ShopPanel.cpp:232 and draws the name; put the count
    one line below it.
- `CanDoBuyButton` (333):
  - If the count is 0, return the message "This ship is out of stock. New hulls are
    on order; check back in a few days."
  - If the mod has registered an order hook for this hull here, mention ordering.
  - Also clamp: if the quantity field asks for more than the count, return
    "Only N in stock."
- `DoBuyButton` (376): clamp `modifier` to the count.
- `BuyShip` (474): after each successful `player.BuyShip`, call
  `player.AddShipStock(planet, selectedShip, -1)`.
  - Do it here, **not** in `PlayerInfo::BuyShip`. The mod's `buy_ship` API (task B)
    reuses `PlayerInfo::BuyShip` for delivered orders and must not consume shelf
    stock.
- `SellShip`:
  - When stock is on and this shipyard sells that model, add 1 per hull sold.
  - Selling with outfits stored still returns the hull. Ship variants count as
    their base model: use `ship->TrueModelName()` → `GameData::Ships().Get`.
- Details pane (`DrawDetails`, 128): show "In stock: N" under the name. Optional.
- Leave `OutfitterPanel` alone; outfit stock is out of scope.

**Ship "in stock" (done, works without a mod).** The counterpart of the
outfitter's used-outfit stock:

- `PlayerInfo::shipInStock` (`std::map<const Ship *, int>`, base models),
  `ShipInStock(model)` / `AddShipInStock(model, n)`. Cleared at takeoff next to
  `stock.clear()` (the shared `stockDepreciation` is reset there already).
  Saved as `"ship in stock"` / `"<model>" <count>`, only when not empty, because
  you can save while landed; invalid models are dropped in `ValidateLoad`.
- Selling a ship (either button) restores the hull to its base model
  (`TrueModelName()`) and, only if the ship really left the fleet:
  - if this shipyard sells that model and a mod tracks it here, adds 1 to the
    tracked shelf count (permanent; not also counted as in stock);
  - otherwise (tracking off, model untracked, or not sold here) adds 1 to
    `shipInStock`, which disappears at takeoff like sold outfits.
- `ShipyardPanel` lists a model if the shipyard sells it **or** it is in stock,
  so used hulls show in any shipyard and category. Available = tracked count
  (or unlimited) + in stock; quantity buys are clamped to it.
- A purchase takes a used hull first, then the shelf. That matches the price:
  `PlayerInfo::BuyShip` charges `stockDepreciation.Value(*model)`, which prices
  the oldest (cheapest) recorded hull first, and `SellShip` already put the
  sold hull's record there. Default outfits are priced the same way: used ones
  the player sold here at their depreciated value, missing ones at full price.
  So stripping, selling and buying back nets zero, as in the vanilla game.
- Labels (tile / details): "N in stock" / "In stock: N", "N in stock (U used)",
  "U used in stock" / "In stock: U used" (untracked or not sold here), and
  "out of stock" (dimmed tile).

**Not affected:** mission-gifted ships (`GiftShip`) and `AddStockShip` from events.
Check `grep -n "BuyShip(" source/*.cpp` for other callers.

### Task B: Mod API 9 (`modding/`)

**Done.** As built: `ship_stock_on(on)`, `ship_stock`, `set_ship_stock`,
`ship_order_note(planet, model, text)`, `shipyard_count`/`shipyard_model`
(permanent and conditional shipyards, sorted), `model_name`/`model_cost`/
`model_category`/`model_licenses`, `buy_ship(model, name)` (player hooks only;
sells no licenses: false unless the player holds them all; charges exactly
`model_cost`, the full new price, through `PlayerInfo::DeliverShip`, and
touches no shop: not the shelf, the used hulls, the outfit stock or their
depreciation), `losses` and `loss_model` (the base model)/`loss_government`/
`loss_by_player` (kept from steps whose hooks do not run, such as a pause or
a dialog, until the next step whose hooks run), `ship_in_stock(model)` (used
hulls at the landed planet), `map_label(system, text, r, g, b)` (a marker's
label without the ring) and `map_ring(system, scale, r, g, b)` (a ring
`scale` × a marker's, clamped to 0.5–3: use 1.5 for C's home systems, with
`map_label` for the name, which is drawn below the largest ring).
The stock switch: call `ship_stock_on(true)` from `on_enter`, which
`ModHarness::Landed` runs from the planet screen's constructor, before its
shipyard can open.

Follow the usual chain: `es_host.h` → `ModHarness.cpp` → `fake_game.cpp` →
`host.dado` → `Game.dados` (with doc comments) → `entry.dado` export →
`version.dado` `MOD_API = 9`. Then `dado-mods.sh sdk` / `test` / `examples`.

**Stock switch on load.** `PlayerInfo::Load()` and `Clear()` reset
`shipStockEnabled` to false, so the mod must turn it on again after every pilot
load. The harness must make sure that happens before a shipyard can open when
the pilot is loaded while landed: run the mod's load/prepare path from
`ModHarness::Landed` (the PlanetPanel path) too, not only from the Step hooks.
Task A also left `PlayerInfo::SetShipOrderNote(planet, model, text)` (not
saved) for the out-of-stock message; wrap it, e.g. as `ship_order_note`.
Read access to the used hulls in stock is `ship_in_stock(model)` (done).

New calls:

| call | meaning |
|---|---|
| `ship_stock_on(on bool)` | switch stock tracking on for this session |
| `ship_stock(planet, model) int` | count, -1 if untracked |
| `set_ship_stock(planet, model, n)` | set the count; n < 0 untracks |
| `shipyard_count(planet) int`, `shipyard_model(planet, k) string` | the planet's `Sale<Ship>` (true names, sorted) |
| `model_name(model) string`, `model_cost(model) int`, `model_category(model) string`, `model_licenses(model) string` (comma list) | catalogue facts |
| `buy_ship(model, name) bool` | charge the full new price (exactly `model_cost`) and add the ship at the landed planet, through `PlayerInfo::DeliverShip`. Use it for delivered orders; it touches no shop (shelf stock, used hulls, outfit stock, depreciation). Player hooks only. |
| `losses() int`, `loss_model(k) string`, `loss_government(k) string`, `loss_by_player(k) bool` | ships destroyed in the player's system since the last step |

**Losses feed.**
- Collect destroyed ships in `Engine` / `AI` ship events: `ShipEvent::DESTROY` with
  actor and target.
- Push them into a per-step vector in ModHarness, cleared at the end of
  `EndStepTiming`.
- `loss_by_player` is true when the actor is the player or the player's escort.
- Count each ship once: a ship can receive DESTROY more than once.

**Caching.** The `shipyard_*` calls walk the planet's Sale every time. Cache them per
`Context`, as with fleets, and clear the cache in `ForgetWorld`.

**Testing.**
- Add `TestApi9` in `fake_game.cpp` and a probe mod `modding/test/mods/api9_probe/`.
- Update the README API table, the HANDOFF entry, and the SDK:
  - `npm run sync`
  - `js/fake-game.js` / `.d.ts`: add stock map, shipyards, losses, and `buy_ship`
    recording purchases.
  - `tools/esmod.mjs` check must feed some losses.
  - Update GUIDE/README to API 9.

### Task C: Corporations mod (`endless-sky-mod-sdk/mods/corporations/`)

1. **Hull table**: a new `src/Hulls.dados`, generated by
   `tools/make-hulls.mjs` from the game's `data/human/ships.txt` (and variants).
   - Store per model: owner company id or `military`, base cost, and category.
   - **Ownership comes from the description.** 52 of the 87 human models name a
     builder (Lionheart 11, Tarazed 8, Betelgeuse 8, Southbound 8, Navy 8,
     Megaparsec 6, Syndicated 3).
   - Assign the other 35 by hand (Marauder variants, Arrow, Boxwing, Bulk Freighter,
     Bulwark, ...). Pirate Marauder conversions could go to an invented
     "Kestrel Refits"-style owner, or to Southbound. Make a judgement call and
     list it in the HANDOFF.
   - **A hull is military** if its description names the Navy, or it needs a
     `Navy`/`Militia` license (check `licenses` in the data). Military hulls have
     no owner.
   - **Check:** every ship that any human shipyard sells is in the table.
2. **Inventory.** Per (shipyard planet, model), store a count and a target.
   - The target depends on hull class: about 4 for shuttles and freighters, 2 for
     warships, and 1 for capital hulls.
   - Seed counts at the target on the first run, then call `set_ship_stock` for
     every pair in `prepare`. The mod's state is the source of truth.
   - Read back `ship_stock` in `on_day` to see the player's purchases.
   - Encode this as a new record line in `Market.encode/decode` (e.g. `s|planet|model|count|onorder`).
3. **NPC sales (demand).** Each day, each listed model sells with probability
   `base × regional loss multiplier`.
   - The regional multiplier comes from the last 30 days of losses in systems
     within 3 jumps; use `Galaxy` BFS.
   - Revenue goes to the IP owner's profit (a small royalty), for military hulls
     too, through whichever company built them.
4. **Losses.**
   - Baseline per region, raised by Diplomacy war state (read via `data`/conditions
     if Diplomacy is installed) and by pirate presence (`tag strengths` or
     government in the system).
   - Add the witnessed ones from the `losses()` feed. Losses the player caused
     count double toward local demand.
   - The News tab can report big loss spikes.
5. **Civilian restocks.**
   - When count + on-order < target, the shipyard places an order with the IP
     owner.
   - It is a `Contract` with `kind=restock`, no bidding, awarded to the owner.
   - Lead time = base by class × (1 + owner's backlog / capacity) × health factor.
   - Delivery raises the count. The owner earns `cost × margin` as contract
     profit, so share prices react to hull demand.
   - Canonical owners never fail, so restocks always arrive eventually.
6. **Military procurement.**
   - When military stock across a government's shipyards drops below target, that
     government issues **one tender** for N hulls of a model.
   - The government is the planet's government: Republic for Navy hulls, Free
     Worlds for theirs, and so on.
   - Any shipbuilding-sector company, canon or invented, may bid. Reuse the
     existing contract bidding in `Market.dados`.
   - **Bid = price and delivery time**, from the company's capacity, backlog and
     health. Invented companies can win and can fail to deliver if they go
     bankrupt; the tender is then re-issued.
   - The winner delivers to the shipyards in order of shortage.
   - Show tenders and awards in the Contracts tab with a "military" tag.
7. **Player orders.**
   - On the exchange screen, or a small panel offered only at a canon shipbuilder's
     home planet (the `Names.dados` homes, which need a planet for each), add an
     **Orders** tab listing that company's hulls.
   - Order flow:
     1. Ordering takes a deposit (20%, via `ask_number` for quantity 1–3).
     2. The order sits ahead of shipyard restocks in the owner's queue.
     3. When it is ready, a message appears on landing there: pay the rest, then
        `buy_ship(model, "")`, and credit the deposit back first so the full
        price nets correctly.
   - **Cancelling refunds half the deposit.**
   - Military hulls are never listed.
8. **Map.** In `draw_map`, canon home systems get a bright ring, about 1.5× the
   radius, and the company's short name as a label. Invented companies keep the
   quiet ring.
   - Done in task B: `map_ring(system, 1.5, r, g, b)` plus
     `map_label(system, text, r, g, b)`.
9. **Tests and timing.**
   - Extend `test/world.mjs` with shipyards and hulls. Use `make-galaxy.mjs` to add
     each planet's shipyard list to `galaxy.json`.
   - **Test that:**
     - stock never goes negative;
     - restocks arrive;
     - military tenders get bids from more than one company;
     - orders work only at home planets;
     - the deposit math is right;
     - save→load round trips.
   - Run `balance.mjs` over 5,000 days and log stockouts per year.
   - Target: `on_day` average under about 4 ms in QuickJS (it is about 3.0 ms now).
     The encoded state is about 73 KB; keep it under about 120 KB.
10. **Ship it.**
    - Run `npm test`, `npm run check -- mods/corporations`, and
      `npm run deploy -- mods/corporations`.
    - Set `plugin.txt` to mod API 9.
    - Update HANDOFF.md and the design doc's status section. The Docs artifact is
      "Corporations & Stock Exchange — Design Proposal".

### Task C progress

**Done: C1, C2, C5** (2026-10-27); C3, C4, C6 and C8 in M1 (next section,
which supersedes the C3 TODOs and numbers below). Not done: C7 (player
orders, M2).

**C1, the hull table.** `tools/make-hulls.mjs <data>` writes `src/Hulls.dados`
(and `test/models.json` for FakeGame) from `data/human/ships.txt`,
`kestrel.txt` and `marauders.txt`: 109 models (variants included, because
shipyards sell some by their variant name, e.g. "Kestrel (More Weapons)").
Per model: owner (a canonical company's name from `Names.dados`, or
`military`), full new price (hull + outfits, what `model_cost` answers),
category, and hull class. Shared parsing is in `tools/es-data.mjs`.
- **Ownership rules, in order:** (1) military if a `Navy*` or `Militia`
  license is needed, or the description names the Navy and no builder;
  (2) a variant or pirate refit belongs to its base hull's owner;
  (3) the first builder its description names; (4) the hand table `HAND`.
  The build stops on a model with no owner, an owner that is not canonical,
  a stale hand entry, or a model a human shipyard sells that is not in the
  table (35 human shipyard planets, 451 planet/model pairs, all covered).
- **Owners (109):** Megaparsec Incorporated 19, Betelgeuse Shipyards 16,
  military 15, Tarazed Corporation 15, Lionheart Industries 14, Southbound
  Shipyards 13, Syndicated Shipyards 13, Syndicated Systems 2 (Barb,
  Vanguard: the description names it), Gemini Shipyards 1, Tycho Crater
  Shipyards 1. (Counts include variants and the 30 Marauder models.)
- **Military (15):** Auxiliary (+ Cargo, Transport), Carrier, Cruiser,
  Frigate, Gunboat, Rainmaker, Lance, Combat Drone, Surveillance Drone,
  Dropship (Navy), Dreadnought and Skein (Militia license: Free Worlds),
  Monitor (by hand: commissioned by the Navy; its text names Betelgeuse only
  as a government).
- **Judgement calls (hand table, `HAND` in make-hulls.mjs):**
  - Syndicate designs that name no builder go to Syndicated Shipyards: Arrow,
    Bulk Freighter, Container Transport, Freighter, Star Barge, Protector,
    Mining Drone, Class C Freighter (not sold anywhere).
  - Hauler, Hauler II, Hauler III → Southbound (it builds the Hauler pods
    Nest/Roost and sells all three); Boxwing → Southbound (built around the
    Hauler's Type F pod).
  - Flivver → Lionheart (Lionheart Basics); Saber → Lionheart (Deep
    caravan-era design). Star Queen → Betelgeuse (Betelgeuse Advanced).
  - Hogshead → Tycho Crater Shipyards (its builder went bankrupt; Tycho
    Crater is the shipyard that sells it). Enforcer → Gemini Shipyards
    (legacy, unsold; Gemini otherwise owns nothing). Jackal is Betelgeuse's
    by its own text (its maker was absorbed by Betelgeuse).
  - **Pirate refits follow the base hull** rather than a new invented owner,
    so that no new canonical company is needed and the 15-company canon
    stays as it is: Modified Argosy, Cutthroat, Bulwark → Southbound;
    Mammoth, Scrapper → Betelgeuse; Nighthawk → Tarazed; Valkyrie →
    Lionheart; every "Marauder X" → the owner of X.
  - No canonical builder was missing from `Names.dados`, so no company was
    added. Megaparsec Incorporated keeps its consumer-goods sector; owning
    hulls does not depend on sector.
- **Hull classes and targets** (`targets`, `lead_days` in Hulls):
  CIVIL (transports, freighters, utility, liners) 4 hulls, 12 days;
  LIGHT (interceptors, fighters, drones) 3, 10 days;
  WARSHIP (light/medium/heavy warships) 2, 20 days;
  CAPITAL (anything costing 8 million or more) 1, 45 days.

**C2, inventory.** `Shelf` (one per planet and model) holds count, target
(from the class; not saved) and on-order. `Galaxy.yards` lists the planets
in human systems with a shipyard (`shipyard_count > 0`), as the session
began: the same 35 planets `make-galaxy`/`make-hulls` cover. **Only those are
stocked**; any other shipyard (alien, or a human colony in alien space such as
Greenwater) stays untracked, so unlimited, even if it sells a human hull.
Shelves are seeded at their targets for a new market or an old save (no
`s|` records). On landing (`sync_shelves`) a new listing (from an event)
gets a shelf, and a model the shipyard no longer lists loses its shelf, its
running restocks cancelled (LAPSED, the owner's yards freed, nothing paid).
Models the table does not know stay untracked.
- **Push only the landed planet.** The engine reads a count only at the
  planet the player is landed on (its shipyard, and hulls sold there) and
  saves the counts with the pilot, so on each landing `on_enter` calls
  `ship_stock_on(true)` and `set_ship_stock` for that planet's shelves only
  (about 15 calls, not 451), plus `ship_order_note` on empty shelves ("New
  hulls are on order from X; due in about N days.", or "Military hulls are
  supplied through government procurement" for military ones). `on_day`
  pushes again if a day passes while landed.
- **Purchases are read back** from the planet last pushed (`stock_planet`,
  saved as `y|planet`), in `on_day` and `on_enter`: lower = bought, higher
  = sold back (counted as `player_bought`/`player_sold`). After the player
  has left, that planet is read back once and then forgotten, since a
  delivery to it would otherwise be read against the game's stale count
  and look like a purchase (a bug caught by the restock test). A game count
  of -1 (untracked) leaves the mod's count alone.
- **Saving:** one record per planet, `s|planet|model,count,onorder|...`
  (35 records, 5.9 KB); each planet's record is cached and re-encoded only
  when one of its shelves changes (`Market.touch`; change counts only
  through `set_count`/`touch`). A test compares every day's encode with an
  uncached one (it fails if `touch` is removed from `order_restock` or
  `deliver_restock`). Counts are clamped to 0 or more on decode and before
  `set_ship_stock` (a negative count would untrack the shelf).
- **Reloading the same pilot:** every save bumps `rev` in storage
  (`set_data("rev", n)`). `prepare`, which every hook calls (`on_load` runs
  only once a session), reads the market again when `world` *or* `rev`
  differs from what is in memory, so an older snapshot of the same pilot is
  not overlaid by the discarded timeline (phantom sell-backs, restocks
  pushed from it, days simulated twice). Tested by saving while landed,
  buying, simulating 40 days, and restoring the save.
- **Military shelves** are stocked and read back but never restocked:
  `Market.restock` skips them at a `Task C6` comment, and `order_note`
  has a C6 comment for tender dates.

**C5, civilian restocks.** Each day (`Market.restock`, in `step` right after
`run_contracts`; the C3/C4 demand slot is a comment just before it), a
shelf with count + on-order < target orders the difference from the hull's
owner: a `Contract` with `kind = RESTOCK` (3), client = the planet, plus
new fields `model` and `units` (old 21-field lines still decode). No bidding:
it is RUNNING at once, won by the owner.
- **Lead time** = `lead_days[class] × (1 + owner.load / owner.capacity) ×
  health`, health = 1 + 0.5 × (1 − reliability) + 0.25 if not LISTED;
  at least 3 days.
- **Money:** on delivery the count rises and the owner books
  `RESTOCK_MARGIN` (0.12) × `model_cost` × units as cash and revenue, so
  it reaches earnings reports and the share price. While building, a
  restock takes `restock_load[class]` (0.15, 0.1, 0.3, 0.8) × units of
  the owner's capacity, which is the backlog in the formula.
- **Never fails:** `deliver` sends restocks to `deliver_restock`. Breakups
  leave restocks with the owner; jobs are not offered for them; a bankrupt
  owner (impossible for canon) drops them and the shelf orders again.
- **Contracts tab:** restocks are left out of the contract lists and shown
  as one row per owner ("Shipyard restocks | Ships | N shipyards | value |
  X hulls on order, Y delivered: Owner"); clicking it chooses the owner,
  whose sidebar adds "Hull restocks: X on order for shipyards, Y delivered
  lately." Done restocks are pruned after 10 days (other contracts 60).
- **Saved compactly** as `r|id|planet|model|units|status|winner|start|ends|price`
  (about 60 bytes, against about 155 for a full contract line); the rest
  (load, days, budget) is derived on decode. The price is rounded to whole
  credits when ordered so a reload is exact. `hauled()` skips restocks.

**Tests** (`test/corporations.test.mjs`, 9 new; the review added: reloading
an earlier save, the shelf-cache check, human-shipyards-only plus delisting
plus negative-count clamping): every shipyard model is in
the table; seeding, landing push and `ship_stock_on` in `on_enter`; a
purchase → restock → delivery, never negative, owner paid, sold-back hull;
military shelves not restocked; save→load keeps counts and on-order, old
saves are seeded; the Contracts tab sums per owner. `test/galaxy.json` now
carries each planet's `shipyard` list (from `make-galaxy.mjs`, which now
uses `es-data.mjs`); `test/world.mjs` passes `models.json` to FakeGame.
`npm test` 37/37, `npm run check` (all mods), `npm run typecheck` pass.

**Balance** (`tools/balance.mjs 5000`; a player lands at a random shipyard
every 3 days and buys 1–2 hulls, about 180 a year, far more than a real
player): per year about 20 shelves run out, about 1,200–1,400 civilian
empty shelf-days (4–9 empty at worst), about 165 restocks and 170 hulls
delivered, 11–17 hulls on order at year end, average lead 32–44 days.
Military empty shelf-days grow every year (up to about 9,000), as expected
until C6. Without purchases the market plays out exactly as before
(restocks use no random numbers).

**Timing and size** (QuickJS, `tools/qjs-time.mjs`, 5000 days): `on_day`
3.06 ms before → 3.00 ms after the review fixes (3.15 ms with the buying
player); state 93 KB → 100 KB at day 5000 (113 KB with the buying player).
Of that 113 KB, restocks are 0.8 KB (14 records) and shelves 5.9 KB; the
rest is ordinary contracts (51 KB) and companies (49 KB), larger because
that world keeps more of both. Compacting those lines (fewer float digits)
is the next lever if C3 needs room. The plan's 3.0 ms
/ 73 KB were from an earlier day count. Encoding the state every day is
two thirds of `on_day`; with C3's NPC demand (many more restocks) watch the
120 KB line.

**Open issues / TODO for C3 (economics, from the review; not retuned yet):**
- Restock load bypasses the capacity check: `order_restock` adds
  `restock_load × units` to the owner's load with no `load ≤ capacity`
  test, so a builder can sit over capacity (and then loses ordinary bids,
  and `deliver` would add the over-capacity failure chance if restocks
  could fail).
- Canon builders shrink when idle: in the 5000-day balance with the buying
  player, Betelgeuse ends at capacity 3.6 and Lionheart at 3.3 (from 14 and
  11), with loads 2.3 and 2.1, so lead times run 1.6× base and more. The
  report logic cuts 8% a report below 35% utilisation and does not count
  restock revenue as a reason to keep yards.
- `RESTOCK_MARGIN` 0.12: about 170 restocked hulls a year already rival a
  builder's contract earnings; with C3's NPC sales (hundreds a year) it
  must come down, or restock revenue must replace part of the sector-0
  contract demand.
- A planet that gains a shipyard during a session is stocked from the next
  session (Galaxy is read once a session).
- Not seen in the real game yet: the counts on shipyard tiles, the order
  notes, and an old save being seeded.

**Next (C3, C4, C6, C7, C8):** NPC sales go in `step` before `restock`
(lower counts through `set_count`); losses feed them; military tenders
replace the C6 skip in `restock` and fill `order_note`; player orders use
`Contract` RESTOCK-like contracts ahead of restocks in the owner's queue;
the map rings use `Names.canon_homes`.

### M1 (2026-10-27)

The user approved every suggestion of the design survey; M1 is the five quick
wins plus C3/C4, C6, C8 and news. M2 and M3 come in later sessions (below).
Built and tested on a copy of `es-mods`, then copied into
`es-mods/mods/corporations/` and deployed. Built against Mod API 9 (the copy
keeps the API 9 SDK; `es-mods`' SDK is at API 10 now, uncommitted), with
guarded API 10 paths (see "Review fixes" at the end of this section).

**New files:** `src/Losses.dados` (the losses economy), `src/MapView.dados`
(the map and its layers), `src/Press.dados` (spaceport news),
`tools/make-news.mjs` (writes `data/corporations.txt`), `tools/probe.mjs`
(the survey's strategy probe, now with arguments and risk figures),
`test/m1.test.mjs` (15 tests). `tools/balance.mjs` now prints NPC sales,
military shelf-days and the longest empty military shelf, tenders, hull
income against all earnings, every shipbuilder's capacity at years 5, 10 and
14, and the largest state; `balance.mjs 5000 3 nobuy` runs without the player.

**Quick win 1, saving.** The game writes the pilot file only while landed (at
takeoff, before the day the takeoff starts; on quitting on a planet; when the
load screen opens on one; a mission's autosave is a separate file). So the
market is saved on every landing (`on_enter`, which also pushes shelf counts)
and after every trade (`on_number`), and in flight only every `SAVE_EVERY`
(10) days or on a day that touched the player's credits (`Market.must_save`:
dividends, buyouts, bankruptcies). A main save therefore always holds the
market as it is. Loading a mission's autosave taken in flight replays the
days since the last save from the saved random state: identical except the
witnessed losses and the war's day-by-day state in those days (tested: save,
fly 7 days, load, replay = same market; autosave 4 days behind replays to the
same market). The first change after a save bumps `rev` in storage (cheap),
and `prepare` also re-reads when the market in memory is dirty and ahead of
the game's day, so an earlier save is never overlaid. On a game with API 10's
`on_save` the market is saved there instead (Review fixes, 10).

**Quick win 2, prices and buyouts.** An announced bid gaps the target to
`DEAL_GAP` (0.92) of the offer; at completion a bid fails `BID_FAIL` (33%;
45% for a company for sale): financing, regulators, the target's board, and
the price falls back to 0.88–0.98 of where it stood (×0.85 for sale). Noise
halved and moved into a persistent per-company **mood** (log offset on fair
value, fading with half-life about 170 days), so noise and price-only news
(scandal, new chief, tender award) last instead of reverting on a timetable;
the price closes 20% of its gap a day. Reports and cycle changes move the
price at once by 0.8 of the change in fair value (no post-report drift); the
digest replaces the old surprise jump. Fair value now rests on **normal
earnings** (`Company.norm`, an average each report moves 8%) at 15% and on
capacity × the sector's earnings per capacity at 85%; the growth flip
(1.15/0.9) is gone; one soft floor at half of (yards − half the debt) for
profit and loss alike (before: cash, which swings with every contract,
was in it, and loss-makers had a higher floor than small earners). Luck bias
narrowed to 55%/45%; cycle multiples compressed (1.15 … 0.8); dividends pay
on the four-report average, payout 15–40%.

**Quick win 3 and C6, military tenders.** Each day a government whose military
shelves of a model fall short (one more each while urgent) tenders for the gap
less its open and running tenders (a gap of one waits for an empty shelf
unless urgent); at most 6 hulls a tender. The government is the planet's
(live `planet_government`), so any government, including a new rebel one, can
tender; a tender is a `Contract` of kind `TENDER` (4) open 5 days (2 urgent)
to every listed shipbuilder with spare capacity, wherever it is. `award`
weighs price against delivery days (`delivery_days`: faster with spare yards,
slower busy or unhealthy; `DAYS_WEIGHT` 0.5). Award: news with bids and the
runner-up, a mood lift up to 8%, the winner's earnings cause. An invented
winner can fail on delivery (the usual reliability roll) or by bankruptcy;
the tender is then issued again the next day. Delivery fills the
government's shelves of the model most short first. No bidder twice: the
government's own yards build at half speed (`government_build`), so a Navy
shelf is never empty for good. Urgency (`URGENT_DAYS` 30): a war, or a war
event (a new war, a capture, a flotilla destroyed, from Diplomacy's
statistics). Notes on empty military shelves give the tender's state and due
date (`Fmt.date`). Contracts tab: tenders first, tagged "(military)", with
the closing date and the bidders before award.

**Several wars, new governments.** `Market.war_pairs` reads the wars
(today the one `diplomacy: war a/b` pair; Diplomacy is moving to several wars
and rebel governments: read the new per-war conditions there and name new
factions in `government_name`). Everything else takes any number of wars
(`wars`, `at_war`, `enemies`) between any governments. `Market.war_event`
is the hook for API 10's bus (`diplomacy.war`, `.peace`, `.capture`,
`.battle`, `.siege`).

**Shipyards that change.** Every 30 days every planet in human space is
checked as a landing checks its own: new listings get shelves (Diplomacy's
Navy Advanced shipyard on Luna becomes a Republic military yard), cleared
ones lose theirs (Geminus until "geminus rebuilt"), and a shipyard that
opened during the session is stocked from then on (no longer next session).

**Quick win 4, canon builders.** Utilisation is the average load since the
last report (restocks and tenders included); a canonical company does not
shrink while profitable, nor below half its founding capacity; the canon
+0.02 bid margin is gone; new listings draw a sector by work share,
busyness and fewness (before: always the busiest, i.e. shipbuilding).
`RESTOCK_MARGIN` went to 0.01, not the survey's 0.06: with C3's NPC sales
the hull volume rose about five-fold, and at 0.06 hull income was
three-quarters of all corporate earnings, which inflated shipbuilders' value
until value-share antitrust broke the canon builders up again and again
(each breakup a new invented shipbuilder). At 0.01 (+ `ROYALTY` 0.004 on NPC
sales) hull income is about 30% of earnings.

**Quick win 5 and news.** Reports fold into one "Earnings:" line a day: up to
three notable companies, each "beats" or "misses" its last report with both
figures and its cause ("after winning the Republic tender for 2 Cruisers",
"on hull sales near Alnitak", "after a fire at its works", "while X bids for
it"); the rest counted. News lines carry tags (`day|text|tags`: `s`
shipyards, `w` war, `c<id>`); the News heading cycles All / Yours /
Shipyards / War, and a line chooses its company. **Spaceport news**
(`Press`): every `game.change` is an unnamed event whose changes the pilot
keeps for good, so canonical companies' items (tender, fire, beats) and loss
spikes per shipyard system are written in the plugin's data
(`data/corporations.txt`, 84 items), each shown while
`"corporations: news <key>" >= "days since epoch"`: posting is one
`set_condition` to its last day and it hides itself, with no pilot growth.
Invented companies' items use 4 slots given place and text by a change, at
most one in 10 days (about 250 bytes each, about 9 KB a pilot-year at most).
At most 8 show at once, 20 days each.

**C3/C4, losses.** `Losses`: one region per stocked shipyard system (35), the
human systems within 3 jumps (BFS cached by Galaxy). Daily losses per system:
1 base, +2 pirate system / +0.6 next to one, +0.8 in a warring government's
space / +2 on its front, +20 at a Diplomacy raid (a third next to it), +8 at
a war flotilla, +4 per witnessed loss (×2 if the player did it; `on_step`
buffers the `losses()` feed, which is there only in its step). Heat is a
30-day exponential window, split by cause; the loss index is heat over a
quiet region's (1). NPC sales: per shipyard per day one draw with the summed
chance of its stocked shelves (`npc_rate` by class, military halved) × the
index (clamped 0.5–4); a witnessed loss is replaced at once from the nearest
stocked shelf of its model within 3 jumps (always if the player destroyed it,
else half the time). The owner (military: the model's last tender builder)
earns `ROYALTY`. Legible: loss index and cause in each shipyard system's map
panel and the losses layer; news on spikes (index ≥ 2.5 and 1.6× its steady
level, once in 45 days a region; spaceport item too); an owner's sidebar
names the regions driving its demand. Restocks merge: one running restock
per shelf takes on new orders.

**C8, map.** Canon homes: `map_ring(system, 1.5)` in gold plus `map_label`
with the short name (`Names.canon_short`); invented: the quiet marker. Layers
on the exchange's new Map tab, kept in pilot data `layers`: shortages,
restocks and tenders in flight (lines builder → shipyard), regional losses,
holdings. At most 200 calls a draw (`MapView.BUDGET`; tested with every layer
on and every shelf empty: under 200).

**State size.** Finished contracts are saved short (`d|`, a third of a
line); companies gone a month or more drop their price history and reports.

**Numbers (before → after).** Probe, 4000 days, four seeds after:
- buyout bought on announcement, 7 days: +27.5% (40/40 completed, worst
  +10%) → −1.2% average (−4.8% … +3.7%), 22–42% of bids lose, worst −26%;
- buying the bottom 5% of the 60-day range, 30 days: +26.3% against +6.3%
  random → +2.3 … +3.7% against +0.4 … +0.8% (half of those buys lose; sd
  15–20%, random 13–17%): a residual edge of about 2.5 points, mostly
  companies on their value floor recovering;
- mean |30-day move| 34% → 9–11%; payers' yield 12.3% → about 4%.
Builders (balance, buying player; capacity at years 5 / 10 / 14), before:
Betelgeuse 2.8 / 4.9 / 3.6, Lionheart 4.8 / 2.9 / 3.3, Southbound
13.5 / 15.5 / 6.1, Tarazed 3.2 / 16.3 / 24.9, Gemini 8.3 / 2.8 / 2.8,
Syndicated 23.7 / 7.6 / 8.8, Tycho 41.2 / 2.9 / 11.9; largest invented
Pellucid 30.5; 19 shipbuilders. After: Betelgeuse 25.2 / 15.2 / 19.0,
Lionheart 29.6 / 15.9 / 13.4, Southbound 28.6 / 27.1 / 36.7, Tarazed
27.4 / 29.0 / 29.2, Gemini 27.8 / 26.7 / 6.0 (its floor; it owns one unsold
hull), Syndicated 23.4 / 29.4 / 37.0, Tycho 5.6 / 7.6 / 35.4; largest
invented 22.6 / 30.2 / 17.9; 14 shipbuilders. Without the player: canon
16–46 at year 14 (Gemini 5.9), largest invented 17.5.
Empty military shelf-days a year: 293 … 9,259 growing → 46 … 364, longest a
military shelf sits empty 26–130 days (it was never refilled before). Civil
empty shelf-days rose (about 1,300 → 3,500 a year) with about 750 NPC sales a
year; average lead 29–40 days. Tenders 8–22 a year, 0–3 failed.
QuickJS `on_day` (5000 days): 3.06 → 1.79 ms; with the buying player
3.25 → 1.59 ms. State at day 5000: 100 → 88 KB (largest seen 109 KB);
with the buying player 108 → 110 KB (largest 112 KB). V8 test run: largest
saved 111 KB; 500 saves in 5000 days.

**Tests.** `npm test` 41/41 (m1.test.mjs 15: save cadence ×3, buyout gap
and failures, tenders ×3, losses ×2, map, digest and filter, spaceport news,
several wars and a rebel government, shipyards changing at run time ×2; the
long test now also checks military shelves are never empty over 150 days,
saves not daily, state under 120 KB, at most 8 news items, canon builders
keep their yards, no "profit; shares fall" lines). Mutation-checked: no price
gap → the buyout test fails; no `rev` bump → the save/load test fails; no
shelf delivery → two tender tests fail; player kills not doubled → the
witnessed-loss test fails. `npm run check -- mods/corporations`,
`npm run typecheck` pass.

**Not seen in the game yet (in-game checklist):**
1. The game's log on load shows no data errors for `data/corporations.txt`
   (news items with `to show "…" >= "days since epoch"`; not parsed by a game
   build here, there is no Linux build).
2. The map: gold rings and short labels on canon homes; the Map tab switches
   layers and they survive a save and load; a shipyard system's panel shows
   "Loss index".
3. A Navy hull bought to 0 at Geminus, Prime, Ada or Luna: the next day the
   Contracts tab shows a "(military)" tender with bidders; after award, the
   shipyard's note names the builder and a due date; the hull comes back.
4. The News heading filters; an "Earnings:" line a day.
5. Spaceport news near a canon home after its tender win or fire.
6. Destroying a Shuttle near Sol lowers a Shuttle shelf at Earth or Luna.
7. With Diplomacy at war: war news, more tenders, higher loss indexes on the
   front; with a raid near a shipyard, a loss spike.
8. Save on a planet, fly a few days, load: the market is the save's.

**What M2 needs.**
- *Convoys:* restocks and tender deliveries travel from the builder's home
  to the shipyard (the orders layer already draws the lines); losses along
  the route (Losses regions) delay or destroy them; jobs to escort them
  (`offer_job`, as parts jobs). Needs a per-contract route and a loss roll
  per day from the regions it crosses.
- *Builder standing and C7 orders:* the player's standing with a builder
  (from orders, escorts, holdings) and the C7 Orders tab at canon homes
  (deposit, queue ahead of restocks, `buy_ship` on delivery). `Contract`
  RESTOCK already carries model/units; add a client "player".
- *Commodity crises:* the losses index and wars could drive the game's
  commodity prices (API 10 `trade_price`), and shortages of parts raise
  builders' costs.
- *Sabotage:* player actions against a company (needs a mission template and
  a cause on the target, like `Company.note`).

**What M3 needs.** Executives (named, with traits, on `Company`), board power
from the player's holdings (MAX_HOLDING 20% today), tips and shorts (a short
position type in `holdings` and margin rules), Diplomacy sanctions (per-war
conditions; `war_event` and the tender eligibility filter are the places),
the player charter (a player company: deferred in §1), refits (API 10 outfit
stock).

**Blocked on API 10 or Diplomacy.** Used when present (guarded): `on_save`,
the bus (`diplomacy.*`). Not used yet: bus payloads (undocumented; each event
counts for every running war), `on_pilot_loaded` (could replace the `rev` and
day checks), `trade_price` (commodity crises), outfit stock (refits), ship
parking. Diplomacy: its per-war and per-minor conditions (`war_pairs` reads a
guess, `diplomacy: wars` + `diplomacy: war <k> a/b`, falling back to
`war a/b`; `faction_governments` names factions 1..3), and a published
captured-system list so captures raise losses where they happen.

#### Review fixes (2026-10-27, after an independent review)

1. **Revisions never repeat.** `rev` is `"<n>.<session>"`: n is a high-water
   mark for the game session (never reset on load), the session token is
   drawn once (`Math.random`). Two save histories of a pilot reached the same
   number before (snapshot S rev 13 → buy ×3 → S1 rev 16; load S → buy →
   rev 16; load S1 kept the wrong market). Test from the reviewer's `rev.mjs`.
2. **Safety mechanisms tested, each mutation-checked** (the test fails when
   it is removed): `must_save` (a dividend before an in-flight autosave is not
   paid twice on replay, `div.mjs`); open and running tenders subtracted from
   the gap (at most one open tender per government and model, a growing gap
   is added to it, `grow_tender`; under 80 tenders a year with a player buying
   Navy hulls every 4 days, 57 measured); witnessed losses cleared (a single
   loss's heat fades to under 20% in 60 days); spaceport items not re-posted
   while showing; and the revision fix.
3. **Autosave gaps closed:** a settled parts job and every `game.change` set
   `must_save`. Spaceport items carry the day they happened, so a reload that
   simulates several days at once posts them exactly as the first time.
4. **Diplomacy:** human space (`Galaxy`) is every system reachable over the
   lanes from the human governments' systems without entering an alien one
   (`Galaxy.alien`, matched by name prefix), so a rebel-held system keeps its
   shelves, region and lanes, and uninhabited systems inside human space link
   it; the flotilla scan reads every side and slot up to 16 × 6, a raid by
   kind (2) and a war flotilla by kind (0) whoever's it is; ordinary
   contracts come from any government (pirates aside) holding human systems
   with a bank, weighed by the square root of their count (`read_clients`);
   `war_pairs` as above.
5. **Tender deliveries** go only to the government's own shipyards that still
   list the model (checked on delivery; a delisted shelf is dropped), each hull
   to the shelf shortest of its target, never past it (one past while urgent);
   hulls with nowhere to go stay with the government.
6. **Conditions leave the save:** spaceport-news conditions go to 0 after their
   window; parts-job conditions (`hauling`/`delivered`/`late`) go to 0 once
   settled, and the contract is kept in `jobs_done` (saved `j|`) so the job is
   not offered again.
7. **Military royalties:** the builder of each military model's latest tender
   is kept in `builders` (saved `b|`), not looked up in pruned contracts.
8. **Antitrust:** canonical companies are reviewed only for their capacity
   share, over 50% (or twice an even split), never for value: canon
   shipbuilder breakups 4–20 per 5000 days → 0 on three seeds; all breakups
   3–5 per 5000 days (non-shipbuilders: Megaparsec, Polymath, Lovelace, and
   invented ones). Shipbuilding is still about 82–86% of the exchange's value
   (as before M1): it earns about 30k a report per unit of capacity while
   mining, freight, security, engines and electronics run near or below zero
   (small companies reach few of the contracts issued across human space, so
   many lapse). Not tuned here; an M2 item (contract reach, or sector demand).
9. **Nits:** dead growth-tilt code and `Galaxy.powers` removed; the stale C6
   comment fixed; one gold ring a system (Sol had two), a label per company.
   **Spaceport news is seldom seen:** the game picks one item at random among
   all that match a spaceport, vanilla ones included
   (`SpaceportPanel::PickNews`). So each item is also told once as a message
   ("Spaceport news: …") when the player lands within 2 jumps of it while it
   shows.
10. **Mod API 10, guarded:** this release still builds against API 9. When
    the game object has `has` (checked with `Reflect.has`, so an API 9 game is
    safe) and `has("on_save")`, the market is saved in `on_save` only and the
    cadence and landing saves are off; with `has("notify")` the mod listens for
    `diplomacy.*` and `on_notification` calls `Market.war_event` for every
    running war. Tested with a FakeGame given `has`/`listen`.

**Numbers after the review fixes.** Probe (3 seeds): buyout −0.5 … −2.0%
(31–35% lose, worst −26%); 60-day low +1.5 … +3.2% against random +0.2 …
+1.3% (44–51% lose). Balance with the buying player: canon builders at year
14: Southbound 45.0, Syndicated 30.7, Gemini 27.6, Lionheart 19.1, Tarazed
15.3, Betelgeuse 13.4, Tycho 5.9 (its floor: it owns one hull); largest
invented 22.9; 13 shipbuilders; military empty shelf-days 2,068 in 14 years,
longest 84 days; 206 tenders, 2 failed. QuickJS `on_day`: 1.95 ms (1.70 ms
with the buying player). State largest 92 KB (111 KB without the player).
`npm test` 53/53.

### M2 (2026-10-27): captains and convoys

Built against the SDK's mod API 10, running on API 9: `min_api()` is 9 and
every API 10 call is behind `game.has()` (itself checked with `Reflect.has`).
New files: `src/Convoys.dados`, `src/Crises.dados`, `src/Crisis.dados`,
`src/Orders.dados`, `src/Covert.dados`, `src/Standing.dados`, `src/Trade.dados`
(generated by `make-galaxy.mjs`, which also adds each system's `trade` to
`test/galaxy.json`), `test/m2.test.mjs` (20 tests), `README.md` (the
conditions and bus notifications other mods can rely on).

**0. Sector balance.** Shipbuilding was 78–87% of the exchange's value; the
other sectors earned near or below zero. Three causes, three fixes:
- *Subcontracts lapsed.* A shipyard's parts subcontract had a budget of 12% of
  the parent's price, less than the work cost, so two thirds lapsed (outfits,
  engines, electronics: 4,400 of 7,900 issued). Their budget now pays for the
  work (`subcontract`).
- *Contracts out of reach.* `LOCAL_SHARE` (60%) of planets' contracts go to a
  bank planet within reach of a company of the sector, drawn by capacity
  (`planet_near`); a contract offered again reaches `REISSUE_REACH` (4) jumps
  further.
- *No demand of their own.* `drivers` issues work that follows from the
  market: mining from shipbuilders' load (ore for the slips) and the cycle;
  engines, electronics and outfits from the value of hulls delivered (parts and
  refits); freight from hulls delivered; security from regions' loss index over
  1 (patrols); each convoy puts out a security escort and a freight contract
  (`issue_derived`). A crisis multiplies its sector's demand and budgets
  (`sector_boost`, 1.3) so its rivals profit.
- Sector weights moved from ships (0.26 → 0.19) to the others; fewer, larger
  contracts (`CONTRACTS_A_DAY` 5.2 → 3.6, loads 0.7–4.3) keep the state small.
- *Revenue is booked a day at a time* (`run_contracts`, `booked_gap`): reports
  swung with which payments (30% on award, 70% on delivery) fell in their
  month, which made small sectors' earnings per capacity (`sector_rate`) jump
  and fall back, and prices with them: once the other sectors earned, buying
  60-day lows returned +9 to +12% in 30 days against +1 to +3% random. Booking
  revenue as the work is done (cash unchanged) took that away.

Sector value shares (balance, buying player; years 5 / 10 / 14):
before M2 ships 87 / 85 / 78% (nobuy, year 14: 85%); after, four worlds
(`start=0, 777, 4242, 9001`): ships 58–63 / 41–52 / 33–45%; without the
player 53–63 / 39–53 / 27–44%. A typical year 14: ships 39, outfits 11,
engines 2, electronics 7, consumer 8, mining 4, freight 12, security 17.
Months in profit (of 166, sum of the sector's latest reports): before ships
164, outfits 94, engines 57, electronics 75, consumer 102, mining 71, freight
71, security 65; after ships 161–165, outfits 149–160, engines 78–148,
electronics 150–158, consumer 138–160, mining 122–152, freight 115–161,
security 151–163. Engines is the thinnest (one canonical company and few
contracts). Mean |30-day price move| 9–11% (M1) → about 6% (8–9% after the
review fixes, below).

**1. Convoys** (`Convoys`). When a restock of 2+ hulls (or 8M credits), a
military tender, or a ships contract of 2M+ is finished and its destination is
a war zone (its government at war), a pirate system or next to one, or loses
ships (index 1.5+), its hulls leave the builder's home as a convoy: the
contract stays RUNNING with `convoy = 1` and `depart`, its yards freed, one
jump a day along `Galaxy.route` (BFS path). Each day under way it is lost
with chance `RISK` (0.6%) × `Losses.system_index` (the highest region index
holding that system: pirates, the war, Diplomacy raids and flotillas, ships
lost lately), halved while a security company holds its escort contract.
Arrival delivers as before. A loss: a restock fails (the shelf orders again
the next day), a tender fails and is issued again, a contract fails as on a
failed delivery; the builder pays 3% of the hulls' value (a tender 25% of its
price), loses 0.05 reliability and 3% of its price, the news names the place,
the ships count as raid losses there (`Losses.convoy_loss`: the region's
shipyards then sell faster), `corporations.convoy_lost` goes on the bus.
Saved in the contract (`k|` fields 24–25; `r|` fields 10–11 when under way).
- *Jobs:* on landing, an escort job on a lawful board in a system the convoy
  has still to cross (`npc accompany save`, the convoy's own civilian hulls or
  two Freighters, `on destroy` → lost); on a pirate or pirate-adjacent board
  within 4 jumps, an intercept job paid by the builder's strongest rival
  (`npc kill`, `staying timid target marked` in a system ahead of it, `cargo
  settings` with Equipment/Industrial/Metal to plunder, `on kill` pays and
  fails the mission, as vanilla bounties do). While the player holds either,
  the convoy waits (no loss rolls). Conditions (README): `corporations: convoy
  <id>` 1/2, `… safe` (delivered at once: early), `… lost`, `… failed`
  (the convoy goes on unescorted); cleared once read.
- *No ships unless the player takes a job*: the mission's NPCs are the convoy.
- About 80 convoys a year in peace (10–12% lost), about 200 at war.

**2. Standing and orders (C7)** (`Standing`, `Orders`). Standing with any
company is the condition `corporations: standing <id>` (canonical ids 1–15
in Names order; -100..100): escort +6, parts job +2, relief cargo +3, plans
stolen for it +8; intercepting its convoy -15 (+5 with the rival who paid),
an escorted convoy lost -2, an escort abandoned -1, sabotage or spying -8
(-25 more if caught). Holding shares adds up to +10 while held.
- *Orders:* at the home of a canonical company owning civilian designs (Prime,
  Valhalla, Zug, Foundry, Wayfarer, Luna, Earth, Hephaestus; Geminus for the
  legacy Enforcer), the exchange shows an Orders tab (the planet button is
  "Orders" where there is no bank): base civilian models only (no variants,
  no Marauder refits, never military). Order → `ask_number` 1–3 → `confirm`
  with the sums → the 20% deposit is taken; an ORDER contract (kind 5, saved
  `o|`) takes builder capacity; its lead counts only other orders (queued
  ahead of restocks) × health × (1 − 0.3 × standing/100). At standing 60+ the
  price is 3% lower, at most 150k a hull, which spends 15 standing a hull: a
  new ship sells back at full value, so a free discount would be money for
  nothing. When ready the player is told; landing there says so and opening
  the exchange asks to pay the rest (`confirm`): per hull the deposit and
  discount are credited back, then `buy_ship(model, "")` charges
  `model_cost`, so the player pays exactly the remainder; a refused purchase
  is undone and the rest waits. Cancelling refunds half the deposit; the
  builder keeps half and earns 3% of the price on delivery. At most 3 open
  orders. The empty-shelf note at the builder's home mentions ordering.
  Not built: selling an order on to an NPC (optional).

**3. Commodity crises** (`Crises`, `Crisis`, saved `e|`). Each day, with
chance 0.0006 × the companies in Shipbuilding, Outfits, Electronics,
Consumer goods and Mining, one has a strike, accident or recall (at most 2 at
once, 8 a year): its loss and a 7–14% share drop, `sector_boost`, and its home
system's and neighbours' data prices for the sector's commodities ×1.35–1.7
for 10–30 days (Mining: Metal, Heavy Metals; Consumer: Food, Clothing, Luxury
Goods; Electronics: Electronics; Shipbuilding and Outfits: Equipment,
Industrial), as one `game.change` (`system "X"\n\ttrade "Food" N`, all
systems in one body) and one more at the end writing back exactly the prices
before, which come from `trade_base_price` (API 10) or `Trade` (the game's
data). A system and commodity another crisis raised is skipped, so a restore
never writes back a raised price. Relief: planets 1–4 jumps away offer a job
carrying the commodity to the company's home; delivering it
(`corporations: relief <id>`) ends the crisis at once. Measured: 5.3–6.6
crises a year, 10.4–13 price events a year, about 280 bytes each: under 3 KB
of pilot file a year (spaceport news changes add about 2 KB, as in M1).

**4. Sabotage and espionage** (`Covert`, saved `v|`). For a player standing
-10 or less with the target or 20+ with a sponsor in its sector, one job a
landing: steal plans (`stopover` at the target's home, then the sponsor's;
the sponsor's efficiency improves) or, against a shipbuilder bidding on or
building a tender, sabotage (its reliability -0.15: it scores worse in
`award` and fails more in `deliver_tender`). On completion 25% (sabotage
35%) are caught: a scandal in the news, a fine (twice the pay; 4× and 2.9× after the review fixes),
-25 standing with the target and -10 with the sponsor, whose shares slip.
The target notes the cause (`Company.note`) either way.

**5. API 10, guarded.** `on_save` (as in M1); `trade_base_price` for crises
(`Market.api_trade`); the bus: posts `corporations.tender_awarded`,
`.tender_delivered`, `.tender_failed`, `.bankrupt`, `.crisis`, `.convoy_lost`
with JSON payloads (README), queued in `Market.bus` and posted after the day
and after landing, at most 32 a day; still listens to `diplomacy.*`;
`timing_section` "market", "convoys", "losses", "crises" in each day.

**State.** Floats are rounded at the end of each day (`Market.tidy`: whole
credits, 4–5 decimals elsewhere; the market in memory is exactly what is
saved, so replays still match), price history is saved as deltas (`d…`), and
finished contracts are kept 30 days (60 before). Largest state (QuickJS
runs, 5000 days): 115 → 84 KB, buying player 113 → 92 KB; at war with a
buying player 102 KB. QuickJS `on_day` (5000
days): 1.95 → 2.56 ms; buying player 1.72 → 2.42 ms; at war, buying, 2.99 ms.

**Degenerate strategies checked.** Probe (3 worlds): buyout arbitrage −0.2 …
−2.8% (27–36% lose); buying 60-day lows −0.8 … −1.7% against random +0.3 …
+1.2%. Intercepting a builder the player holds shares in, has an order with,
or stands at 40+ with is not offered (`may_intercept`). Order discounts are
capped and paid for in standing; cancelling loses half the deposit.

**Tests.** `npm test` 74/74 (m2.test.mjs 20: convoy travel and save, escort
waits then delivers early with standing, intercept loses the convoy with
penalty, standing and re-order, failed job resumes, job bodies on lawful and
pirate boards, intercept eligibility, standing conditions and parts jobs,
orders only at homes and never military, deposit/cancel/ready/`buy_ship`
netting, refused delivery undone and discounts, the order note, crises on
API 9 and API 10 restored exactly with overlap and relief, relief jobs,
covert jobs caught and sabotage, bus posts and timing sections on API 10,
none on API 9, a bankruptcy on the bus, and the sector balance over 5000
days). Existing tests adapted: Earth offers Orders (Megaparsec's home), the
bankless test uses Mars (Luna is Tycho's home), two M1 tests look for their
news line as it comes and skip a crisis day. Mutation-checked: convoy
conditions not cleared, restore writing the raised price, no credit back
before `buy_ship`, a convoy not waiting for the player's job, an overlapping
crisis raising a price again: each fails tests.

#### M2 review fixes (2026-10-28, after an independent review)

Also in the mount's M1 before its release (Part B), and so in this tree:
- **Loader 0.1.0:** `api_version()` 9 and `min_api()` 9 (built with the API 10
  SDK, `api_version` would answer 10, which loader 0.1.0 refuses).
- **Diplomacy's documented conditions** (its README): `war_pairs` reads
  `diplomacy: wars` and `war <k> a`/`b`; `government_name` knows its 23
  sides (4 the pirates, 6–20 the rebel governments; 5, 13, 17, 21–23 none);
  the flotilla scan reads sides 1..23, slots 1..4, stopping at a side's first
  empty slot. With the bus, `Market.diplomacy_event` reads the payloads:
  `diplomacy.war` names the governments, `.capture` and `.battle` place losses
  at their system (`Losses.battle`: battle losses by strength lost, a
  capture half a raid), `.rising` makes both urgent; battles add no news (they
  come daily); `read_wars` then leaves events to the bus. A payload without
  the fields counts for every war, as before.

M2 fixes:
1. **Job texts checked by the game's parser.** `"cargo settings"` was written
   unquoted, so the game read the key `cargo` and skipped it in every
   intercept job. Now `tools/validate-jobs.mjs [game binary] [resources]
   [rounds]` collects every kind of job text (parts, escort, intercept,
   relief, covert plans and sabotage) from a run against FakeGame, writes them
   into a temporary plugin as the loader wraps them, runs the game with
   `--parse-assets` on a temporary config folder and prints what errors.txt
   says about them (exit 1 on any warning, or a kind not seen). 129 texts, 0
   warnings (with the old key: 25 warnings in 120 texts).
2. **A held job freezes the convoy:** each day the player holds an escort or
   intercept, its departure moves a day later, so it waits where it is;
   dropping the job lets it go on from there. Dropping an intercept costs 3
   standing with the rival who paid (an escort 1 with the builder).
3. **Covert jobs are saved when offered:** landing offers its jobs before the
   landing save, and a covert offer marks the market changed; posting job n
   clears any `covert n` conditions left over. (The other offers keep no
   state.) Also fixed: the one-offer-a-day check read the pay field.
4. **No hull out of nothing:** the escort's NPC reports a loss `on kill`
   (destroyed or captured; the game runs `on destroy` only when none was
   captured); the intercept always meets two Freighters (the reward is their
   cargo), never the restock's own hulls.
5. **Covert fines are collected:** what the player's credits cover is taken,
   the rest is owed (`Market.owed`, saved in `z|`) and paid first out of
   whatever the market pays them (dividends, sales, refunds) and out of what
   their credits gained between days (job pay); the exchange shows it. Fines
   are 4× the pay for plans (caught 25%) and 2.9× for sabotage (35%): even
   in money on average, the standing with the sponsor bought with standing
   with the target. Sabotage now carries illegal cargo (`tampered parts`,
   `illegal`, a passenger): a customs scan fines.
6. **Momentum removed:** buying at a 60-day high returned +2.2–2.9% in 30
   days against +0.1–0.6% otherwise. The cause was the price closing only
   20% of its gap to fair value a day (`PRICE_PULL`): it lagged a rising
   fair value, so a stock at its high went on rising (the smoothed accrual
   was not it: anticipating earnings made it worse). `PRICE_PULL` is now 1
   (the price is its target each day) and the noise is about doubled
   (`sigma_by_kind` 0.011 / 0.0165 / 0.033). Measured (`probe.mjs`, which
   now also buys highs; `scratch/mom.mjs`, 3 worlds): highs +0.2 … +0.8%,
   lows −0.1 … +0.8%, others +0.3 … +0.5%; buyout arbitrage −0.0 … −3.4%;
   mean |30-day move| 8.1–8.7%.
7. **Security no longer booms:** patrols count only a region's loss index
   over `PATROL_FROM` (1.5; near pirates alone 34 of 35 regions sat over 1),
   and a convoy's escort and freight contracts are a quarter the size (0.04
   and 0.03 a jump-unit, 4 + jumps days). Security peaks at 10–18% of value
   (4 worlds) instead of 23–30%. With less security work, the sector weights
   moved again: ships 0.15 (0.19 before), engines 0.09, electronics 0.12,
   consumer 0.14, mining 0.09.

Nits: an API 9 test with a game that has no API 10 name at all (a Proxy, as
the reviewer's `api9.mjs`); a convoy remembers its `origin`, so a contract
handed to another company keeps its place on the route (`k|` field 26, `r|`
field 12); a convoy dropped while the player holds a job on it (a shelf
delisted, a builder bankrupt) has its job's conditions cleared daily for 45
days (`Market.convoy_orphans`, saved in `z|`); crisis restores undo only
their own delta on API 10 (the price now less the crisis's rise, at least 1:
another mod's change meanwhile, such as Diplomacy's occupation damage, stays),
and write the game's data price back on API 9, which cannot read the price
now (README).

Numbers after the fixes. Sector value shares (balance, 4 worlds, years 5 / 10
/ 14): with the buying player ships 39–50 / 41–49 / 32–40%, without 46–61 /
31–39 / 29–43%; at 9000 days 26–31% from year 18 on. Every sector in profit
in 117–165 of 166 months (engines 124–153, mining 74–155). QuickJS `on_day`
2.55 ms (buying 2.46, at war 2.74); largest state 87 KB (buying 89, at war
95). `npm test` 80/80 (m2.test.mjs 25); mutation-checked additionally: the
convoy not holding its place, orphaned jobs not cleared, a restore writing
the old price over another mod's, an unpaid fine forgotten.

**In-game checklist (M2).**
1. The job bodies parse cleanly (checked with `tools/validate-jobs.mjs`
   against a Linux build); in the game, an escort's `on kill` and an
   intercept's `on kill … fail` behave as in vanilla bounty jobs.
2. Near a pirate yard (Buccaneer Bay, Freedom, Haven, Smuggler's Den...),
   escort jobs on lawful boards along a convoy's route, intercept jobs on
   pirate boards; escorting one delivers it on arrival and standing shows in
   the builder's sidebar.
3. At Zug (or Prime, Valhalla, Earth...): the Orders button/tab, an order
   with deposit, its readiness message, the pay-the-rest dialog on opening the
   exchange, the new ship in the shipyard, credits down by exactly the price.
4. A crisis line in the news: the trading panel's prices around the company's
   home are up, and back exactly at its end (or after relief cargo).
5. With standing below -10 with a company, a covert job; being caught fines.
6. On an API 10 game: the timing report shows market, convoys, losses and
   crises; another mod listening to `corporations.*` hears tenders.

**What M3 needs.**
- *Executives:* named, with traits, on `Company` (a field list and a line in
  its encode); crises and scandals (Covert) are natural places for them to be
  fired or blamed; `Company.note` already carries causes.
- *Board power:* the player's holdings (MAX_HOLDING 20%) giving votes:
  dividends, buyouts (`complete_buyout`'s board-rejects reason), a seat that
  shows the sidebar's numbers early.
- *Tips and shorts:* a short position type in `holdings` and margin rules;
  covert jobs and crises are the insider information tips would sell (a crisis
  is decided the day it starts; a tip would have to come before it).
- *Diplomacy sanctions:* per-war conditions (`war_pairs` still reads a guess),
  `war_event` and the tender eligibility filter in `award`; convoys could be
  refused passage through a sanctioning government's systems (`Galaxy.route`
  avoiding them).
- *The player charter:* a player company (deferred in §1) bidding like any
  other; orders and standing are its customer side already.
- *Refits:* API 10 outfit stock; the parts demand (`drivers`) could stock
  outfitters near shipyards.
- Selling an order on to an NPC (C7 optional), convoy positions on the map
  (the orders layer draws only builder → shipyard lines).

### M3 (2026-10-28): the boardroom

Built on M2 (`corp-m3.patch` applies on top of `corp-m2.patch`). `api_version`
and `min_api` stay 9; API 10 features are guarded with `game.has` and degrade on
API 9. New files: `src/Executives.dados`, `Board.dados`, `Shorts.dados`,
`Tips.dados`, `Sanctions.dados`, `Charter.dados`, `Refits.dados`, `Outfits.dados`
(generated by `tools/make-outfits.mjs` from the game's outfitters),
`test/m3.test.mjs` (19 tests). A new timing section, `boardroom`.

**1. Chief executives** (`Executives`). Every company has a chief (Names'
first and last names) with a trait: aggressive (bids 4 points lower, buys
rivals with 1.05× the price in hand instead of 1.3×, payout ×0.7), prudent
(bids 3 points higher, repays debt only above 240 days of upkeep, payout ×1.5,
never buys a rival, luck +5 points), visionary (efficiency drifts ±2% a report,
−0.4% on average; price 1.5× as volatile), crooked (books 3% more revenue at
each report, luck −15 points, a scandal at 0.07% a day: price −12…22%,
reliability −0.08, fired). Fired after two losing reports in a row (180+ days in
office); the fired go to a pool of 8 (`a|`), which companies hire from first
(70%); else a rival's chief may be poached (25%), else a newcomer. The old
"new chief executive" turn now names the new chief and pools the old one. News,
the sidebar ("Chief executive: … (trait), since …") and the tip and covert jobs
name chiefs. Company lines gain 12 fields (old saves get a chief from the
company's id, no dice).

**2. Board power** (`Board`). By the player's share of a company: 5% votes
on a pending bid (block it: −10 standing with the suitor, +10 scrutiny; demand
10% more: the suitor walks away 40% of the time, otherwise raises and has the
votes); 10% sets the payout (5% / 25% / 60%: high costs 0.03 reliability, low
3% of the price) and directs bidding for 60 days (aggressive: 5 points lower
margins, −0.04 reliability; conservative: 5 points higher, −2% price); 20%
sells the stake to the suitor at its offer +5% (+15 scrutiny). A suitor
without the votes of a 5% holder fails 15 points more often (`approved`).
`MAX_HOLDING` 0.20 → 0.35; crossing 20% and 30% is disclosed (+10 scrutiny).
Scrutiny (`corporations: scrutiny`, fades a point every 3 days) fines at 60:
50k + 2% of the player's holdings (owed if they can't pay), then −40.

**3. Shorts and tips** (`Shorts`, `Tips`). Shorts: margin 50% of the value,
the lender's fee 0.04% a day (×5 while in trouble), dividends owed, a margin
call past 80% of the margin, a buyout closes them at the offer, a bankruptcy
or nationalisation at the payout; at most 10% of a company short; none of a
company held, of the player's own, or (exploit found by the probe: shorting
companies already distressed returned +14…23% in 30 days) of one in trouble.
Saved `q|`. Tips: earnings one-offs (25% of reports, ±0.6–1.5× normal
earnings, the price moves 6% of the surprise's size, capped at 10%) decided 10
days before the report (Company.surprise); crises decided 10 days ahead
(`crisis_plan`, `f|`); an open tender's winner arranged when a tip on it is
offered (`tender_fixed`). Tip jobs (35% of bank landings within 3 jumps of the
company, not the market's dice: a deterministic hash, so a landing replayed
after a load does not change the market) carry an envelope; the completion
dialog reveals the tip. Trading the company after it (buy, sell, short,
cover) is fined 25% of the time at 15% of the value traded both ways (at
least 25k), −10 standing, +20 scrutiny. Saved `t|`.

**4. Sanctions** (`Sanctions`, with Diplomacy's README conditions). At war, a
government's tenders and contracts take no bidder whose home its enemy holds
(`embargoed`, in `award`); `diplomacy: member`'s shares in its enemies'
companies are frozen (no buy, sell, short or votes) and half their dividends
withheld. A captured home (Company.home_gov, checked daily): price −20%,
reliability −0.05; canon and the player's company get a state loan; others are
nationalised 30% of the time (status 5 NATIONALISED: holders get 60% of the
price, shorts closed there, contracts released, bus
`corporations.nationalised`). Blockade runs: within 1–4 jumps of a system
under siege (a war flotilla at its goal, read by Losses), a job with illegal
cargo (`blockade supplies`, scan fine); delivered: standing +3 with companies
there, news. Shortfall: `corporations: shortfall <side>` (0–100, the missing
share of the side's military shelves' targets) and `corporations.shortfall`
on the bus when it moves 5 points; Diplomacy M2 (`$HOME/dip-m2`) reads both
(its new flotillas weaker by shortfall × 40%). Diplomacy is not edited.

**5. The player's company** (`Charter`). 2M at a bank founds a freight or
security company (half is its cash), owner 1, private (not traded, not a
target, no antitrust). Capacity: on API 10 (`ship_parking`) ships assigned are
parked (capacity = price / 1.5M, at most 6, half for an ill-suited kind); one
the player unparks or loses leaves the next day; while private, a ship can be
sold to it for good (`call:ship_remove`, it pays 50% of the price from its
cash, the capacity is worth nothing on dissolving: no laundering a worn ship
at a new ship's price); on API 9, capacity bought at 1.5M a unit. Margin
policy ±4 points; a hired chief (300k, chosen trait). IPO: new shares so the
market holds 60%, sold at 90% of fair value, the money is the company's; then
rivals may bid and the player defends with votes (40% ≥ 5%). Dissolving (while
private, or 90%+) unparks the ships and pays the player their share of cash −
debt + half the bought capacity; the 35% cap keeps a listed company from being
bought back and stripped of its IPO cash. A company that fails or is taken
over hands its parked ships to `charter_returns`, unparked the next time the
player opens the exchange (unparking needs a player hook).

**6. Refits** (`Refits`, `Outfits`). The outfitter's "Refit" button (API 5:
`outfitter_button`, `can_outfitter`, `confirm`, `ship_integrate`, as Outfit
Integration does): an outfit built into the hull keeps 80% of its mass and
space. Canon makers' lines are their outfitters (Deep Sky, Lovelace, Delta V,
Syndicate, Kraz) where those are sold; other Outfits / Engines / Electronics
companies refit weapons / engines / systems and power within 2 jumps of home.
The fee is 15% of the outfit's cost × (2 − reliability), ×1.5 while
distressed, and is the supplier's revenue; a supplier for sale, gone or in a
crisis offers none. On API 10 (`outfit_stock`) a canon maker in crisis or
distress leaves its line at 1 in stock at its planets (set back to untracked
once it recovers; `outfit_limited`).

**Numbers.** QuickJS `on_day` (5000 days): M2 2.55 → 2.79 ms; buying 2.46 →
2.54; at war, buying 2.74 → 2.94; slowest day 10.4 ms. Largest state 87 → 91
KB (buying 89 → 93, at war 95 → 103). Sector weights: ships 0.15 → 0.13 (traits
raised shipbuilders' share): year-14 ships share 32–50% (mean 41) with the
buying player, 33–47% (mean 39) without, four worlds; at 9000 days 24–47%
from year 10. Every sector in profit in 78–164 of 166 months. Probe (three
worlds): buyout arbitrage −1.7 … +2.0%; 60-day lows / highs / random within a
point of each other; mean |30-day move| 9.1–9.4%. Shorts 30 days: random −3.6
… −3.9%, at highs −3.6 … −4.6%, at lows −3.3 … −4.3%. Perfect tips (an oracle
trading every one): earnings +6.5 … +7.3% gross, −1.0 … −0.2% after the
expected fine; crises +6.0 … +9.9% gross, −1.5 … +2.4% net (55–58 trades,
a gamble); arranged tenders −1.4 … −2.2% gross. Board "demand more" with a 5%
stake bought after a bid: −14.6 … −17.0% (the stake's price impact).
`validate-jobs.mjs`: 179 job texts (tips and blockade runs added), 0 warnings.

**Tests.** `npm test` 99/99 (m3.test.mjs 19: chiefs and saves, trait effects
on margins, buyouts, window dressing, scandals and luck, firing and the pool;
every board action and its threshold and cost, unwon votes, the scrutiny fine,
disclosure, the board through the exchange; the short lifecycle; tips: a
one-off revealed and fined, crises and an arranged tender; embargo and frozen
shares; captures (rescue, nationalisation); the shortfall condition and bus
post; blockade runs; the charter on API 10 (found, assign/park, bid and earn,
IPO, takeover defence, unparked ship leaves; dissolve returns ships, ship sold,
a failed company's ships returned) and API 9 (bought capacity, margins, a
chief); refits (buy, apply, supplier failure) and API 10 outfit stock; exploit
guards). Existing tests adapted: the Exchange's buttons now include "Company"
and "Short", the buy cap test uses `MAX_HOLDING`, a spaceport-news test looks
for a news change (crises change trade prices too). Mutation-checked: block
does nothing, no margin calls, frozen dividends untaxed, dissolve keeps ships
parked, insider fine not charged, arranged tender ignored: each fails a test.

#### M3 review fixes (2026-10-28, after an independent review)

Bugs:
1. **The IPO no longer prints money.** Fair value of the player's company
   counts only capacity that cannot be taken back (`Charter.firm`: the office,
   capacity bought, ships sold to it), so assigned (parked) ships are not sold
   to the market; an IPO needs 4 reports. The reviewer's loop (charter, assign
   4 Bulk Freighters, IPO, sell the 40%, take the ships back: +20.4M) now loses
   money. Selling all of one's own company makes it the market's (owner 0),
   sends its ships back and frees the charter; a takeover or bankruptcy of it
   sends its parked ships back first (`Charter.release`), never to the buyer.
2. **Delivery-day trades count:** `Tips.traded` treats a delivered tip
   (`corporations: tip n` = 1) as revealed at once. A crisis tip's fine is
   30% of the value traded (earnings and tenders 15%): perfect crisis tips
   now net −6 … −7%, earnings tips −0.4 … 0%.
3. **`outfit_limited` survives saving:** keys are `planet~outfit` (the `|` of
   the `g|` record split them before); a round-trip test.
4. **Board actions don't repeat:** a payout change once a report and only when
   the level changes; one direction at a time.
5. **The suitor no longer pays twice** for a stake the player sold it
   (`Company.suitor_stake`, taken off the deal's cost).

Risks: no shorts of a company whose home is under siege or changed hands in
the last 60 days (`Company.captured`); a ship is sold to the player's company
only if it can pay in full, and the confirm names the amount; API 10 outfit
trims cover only the outfits the maker alone sells (never another maker's,
never ammunition) and are set only when they change (a purchase is not
refilled on landing); chiefs are fired after three losing reports adding up
to more than 60 days of upkeep, once a year in office at the soonest (firings
in 5000 days about 500 → 147, plus about 40 scandals); a board-set payout
outlives a new chief while the player keeps the seat; the player's company's
crooked chief can have a scandal. Nits: a tip offered on a planet is offered
again after a load there (records keep the planet and day); a frozen holder
does not count as votes withheld; a side with no shelves left gets shortfall
0. `validate-jobs.mjs` finds the game and resources in the usual places
(`~/esroot`, `../endless-sky`, `~/mnt/endless-sky`) or says what it tried;
the tests fail loudly without `dadoc` (`CORP_ALLOW_SKIP=1` to skip).

Numbers after the fixes. Sector weights: ships 0.13 → 0.10, mining and
freight 0.11, engines 0.11. Ships share at year 14 (4 worlds): 34–44% with the
buying player, 36–43% without. QuickJS `on_day` 2.53 ms (buying 2.43, at war
2.86, at war on API 10 2.66), slowest 8.6 ms; largest state 82 / 84 / 103 KB.
Probe (3 worlds): buyout arbitrage −0.5 … +4.7% (n ≈ 30 each, noise),
lows / highs / random within about a point, mean |30-day move| 9.1–9.4%,
shorts −3.5 … −4.4%, board "demand more" −9.5 … −11.3%. Reviewer's scripts:
`spam.mjs` (payout and direction spam) moves the price only by the purchase,
`sabot.mjs` and `blockshort.mjs` lose money, `replay3.mjs` byte-identical on
API 9 and API 10, in peace and at war. `npm test` 105/105 (m3.test.mjs 25);
also mutation-checked: IPO pricing parked ships, delivery-day trades not
counted, the suitor paying twice, the outfit key separator.

**For after playtesting:** Corporations tenders only for hulls whose
government sells military models, which in practice is the Republic (only
Navy hulls are military in the hull table), so Diplomacy saw the Republic
boosted almost permanently by `corporations.tender_awarded` (Diplomacy now
caps that on its side). Should the Free Worlds and the Syndicate tender for
warships of their own (Free Worlds-built hulls, Syndicate designs)? Not
changed in M3.

**In-game checklist (M3).**
1. The exchange's sidebar names each company's chief; firing and scandal news.
2. Buy 5–10% of a company with a bid pending: Block bid / Demand more; at 10%
   Payout and Direct bids; the regulator's attention in the summary.
3. Short a company, watch the fee and a margin call; a buyout closes it.
4. A tip job's dialog, then the event it named; trading on it may be fined.
5. With Diplomacy at war and a membership: frozen shares, embargoed tenders,
   blockade runs near sieges, `corporations: shortfall <side>` changing.
6. Charter a company at a bank, assign a ship (parked), watch it win work, IPO.
7. The outfitter's Refit button near Rust (Kraz) on a ship with a Beam Laser.

**What later work needs.** Selling an order on to an NPC (C7 optional); convoy
positions on the map; the player's company in more sectors and with its own
contracts tab; executives with careers across many companies (the pool keeps
8); short interest visible in the market table.

## 4. Suggested order and done criteria

A → B → C(1, 2, 5) → test in game → C(3, 4, 6, 7, 8) → balance → docs.

**The user tests in the real game.** Ask them to confirm:

- counts on shipyard tiles;
- the buy button blocked at 0;
- restocks arriving after a few days;
- a military tender in the Contracts tab;
- ordering at a canon builder's home planet (see `Names.dados`), and not elsewhere;
- home systems lit on the map.

These have **not yet been seen in the real game** (from API 8) and are worth checking:

- job text through the mission parser (`offer_job`);
- `panel_chart` rendering;
- the `ModScreen` layout at small window sizes.

## 5. DadoScript reminders

These cost time before:

- One class per file.
- `for cond:` is the while loop.
- No `<` on strings: use `code_point_at` or the `alphabetical` helper in Exchange.
- `ready` is a reserved hook name; the mod uses `prepare`.
- Every file that uses `es.Game` needs `import "imports:sdk/es"`.
- `bool b = x` instead of `bool(x)`.
- Use `s[a..<b]`, not `slice`.
- Math goes through `globalThis.Math.*` assigned to a typed variable.
- `int` parameters to the host must be whole numbers.
- Pilot state lives in storage (`data`/`set_data`) or conditions, never in globals
  that outlive a load.
- Spawn only in `on_enter`; open panels only from player hooks.
