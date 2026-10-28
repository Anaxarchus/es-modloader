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
"Task C progress". C7 (player orders) moves to M2. Before starting, read
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
