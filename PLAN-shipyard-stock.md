# Plan: shipyards with stock (Mod API 9 + Corporations supply chain)

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
the user to test in the game. C3, C4, C6, C7 and C8 are next; see "Task C
progress" at the end of Task C. Before starting, read
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

**Done: C1, C2, C5** (2026-10-27). Not done: C3 (NPC demand), C4 (losses),
C6 (military tenders), C7 (player orders), C8 (map). Each has a marked slot
in the code (below).

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
