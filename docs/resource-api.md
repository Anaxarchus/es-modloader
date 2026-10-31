# Resource API: create and update for every resource

Design for one uniform way for mods to **create** and **update** every resource the game has: definitions (ships, outfits, governments, planets, systems, galaxies, missions, …) and assets (images, sounds, music, shaders). It fits into the API 13 op space of [api11-spec.md](api11-spec.md) and [api11-migration.md](api11-migration.md). It replaces the API 11 calls `define`, `define_outfit_variant`, `define_ship_variant` and `defined`, and also `change` (`APPLY_EVENT`).

Delete stays out of scope (see section 7). Live objects (ships in flight, accepted missions, the player) keep their typed actions: creating one of those has side effects that a generic verb would hide.

Written 2026-10-29 against `argosy` `564e81730`. Engine facts are cited by file and function.

---

## 1. The model

Every resource is identified by **(kind, name)**. `kind` is the data-file root keyword (`outfit`, `ship`, `system`, …) or an asset kind (`sprite`, `sound`, `music`, `shader`). `name` is the true name, or for assets the path-like name the engine already uses (`ship/kestrel`, `weapon/laser`).

Three verbs:

| Verb | Meaning | Fails when |
|---|---|---|
| `CREATE` | Make a resource that does not exist yet | The name exists (in game data, a plugin, or another mod's resource) |
| `UPDATE` + `PATCH` | Apply changes on top of the current resource, using the kind's own data-file merge rules (`add`, `remove`, overwrite), exactly as a plugin's `event` or a second definition would | The resource does not exist, or belongs to another mod (section 5) |
| `UPDATE` + `REPLACE` | Throw the current contents away and load the given ones, keeping the object's address | Same as `PATCH`; also refused for kinds whose identity cannot survive a reset (section 3) |

**One input format for definitions: data-file text.** That is what every class's `Load` already reads, what plugins already write, and what saves already store. No per-field schema is needed, and a field upstream adds is creatable and updatable without any package change. One request may hold several root nodes. They are applied in dependency order (section 4), so a ship and the outfits it installs can arrive together, as `define` allows today.

**Assets take bytes or a path, plus a role per part.** A sprite has frames, `@2x` frames and swizzle masks. A shader has a vertex and a fragment part, each for GL and GLES. The path form names a file inside the calling mod's own plugin folder, read with `Files::Read` (zips work), so a mod can ship assets with no byte copying.

**Scope** says how long a write lasts. It is a field of every request.

| Scope | Lasts | Stored | Applies to |
|---|---|---|---|
| `PILOT` | With the pilot, across saves and loads | In the pilot file: event `changes` for universe kinds; `runtime definitions` for the rest | That pilot only |
| `GLOBAL` | Until the mod deletes its generated plugin | In a **generated plugin**, `<config>/plugins/~generated/<mod>/` (`plugin.txt`, `data/`, `images/`, `sounds/`, `shaders/`), loaded at every start like any plugin | Every pilot; hot-loaded now |
| `SESSION` | Until the game quits, or until the next pilot for definitions | Nowhere | This run |

The generated plugin is the key move for assets and global definitions. **At startup there is nothing new to build**: the engine loads it through the same paths as any plugin (images by `SpriteLoadManager`, sounds by `Audio::LoadSounds`, shaders by `GameData::LoadShaders`, data by `UniverseObjects`). Only the hot load during play is new code. It also fixes an ordering problem the runtime-only design has: a pilot that loads before the mods start (Argosy's `LoadRecent` at launch) already finds the sprites its saved runtime outfits name.

Assets support `GLOBAL` and `SESSION` only. A per-pilot asset can be had by giving the asset a pilot-specific name.

---

## 2. Op shapes

Codes come from the free action block (460–549). The migration doc already proposes 460–464 for outfit give/take/replace and reactivation, so these take 470–473. All are core-layer writes: applied directly, `EsWriteOut` out (spec 6.1).

```c
enum { ES_RES_CREATE = 0, ES_RES_PATCH = 1, ES_RES_REPLACE = 2 };
enum { ES_SCOPE_PILOT = 0, ES_SCOPE_GLOBAL = 1, ES_SCOPE_SESSION = 2 };

typedef struct EsResPart {           /* one part of an asset */
	EsStr    role;                   /* "frame", "frame@2x", "mask", "mask@2x", "vertex", "fragment", "vertex.gles", "fragment.gles", "audio", "audio~" (looping) */
	uint32_t index;                  /* frame number; 0 otherwise */
	uint32_t format;                 /* ES_FMT_PNG, JPG, AVIF, WAV, MP3, FLAC, GLSL; 0 = from the path's extension */
	EsStr    path;                   /* inside the caller's plugin, or "" */
	EsSpan   bytes;                  /* stride 1, when path is "" */
} EsResPart;

typedef struct EsResWriteIn {        /* RESOURCE_WRITE, 470 */
	EsHeader h;
	uint32_t mode;                   /* ES_RES_* */
	uint32_t scope;                  /* ES_SCOPE_* */
	uint32_t kind;                   /* ES_KIND_*, or 0 for "data text, kinds from its root nodes" */
	uint32_t flags;                  /* ES_RESF_PROPAGATE (section 3), ES_RESF_DRY_RUN */
	EsStr    name;                   /* assets, and a single-node REPLACE; "" for data text */
	EsStr    text;                   /* data-file text: one or more root nodes */
	uint32_t part_count, _pad;
	ES_PTR(const EsResPart) parts;   /* assets */
	EsStr    meta;                   /* asset options as data text, e.g. "no reduction", "frame rate 10", "scale 0.5" */
} EsResWriteIn;

typedef struct EsResWriteOut {
	EsHeader h;
	int32_t  status;                 /* ES_OK, ES_PENDING (assets that decode in the background), ES_REJECTED, ES_CONFLICT, ... */
	uint32_t applied;                /* root nodes or parts applied */
	EsHandle result;                 /* the first resource written */
	EsHandle pending;                /* when ES_PENDING */
	EsStr    diagnostics;            /* the engine's own warnings for this text: every PrintTrace, captured (section 6) */
} EsResWriteOut;
```

The other three ops:

- **`RESOURCE_ORIGIN` 471**: `(kind, name)` → `{origin, owner mod, scope}`. Origin is game data, plugin, generated plugin or runtime. This replaces `defined`.
- **`RESOURCE_SOURCE` 472**: the text a mod-written resource was made from, the base and the changes, as the save holds it. This lets a mod update it with `PATCH` without keeping its own copy.
- **`GENERATED_PLUGIN` 473**: inspect, or clear, the caller's generated plugin. This is how a mod uninstalls cleanly.

`ES_RESF_DRY_RUN` parses, validates and returns diagnostics without applying anything. It is useful in development tooling.

**Variants.** `define_outfit_variant(name, base, changes)` becomes `CREATE` with text `outfit "<name>"` plus a child `base "<base>"`. The package resolves `base` by copying the base object first. `define_ship_variant` uses the game's own `ship "<base>" "<name>"` syntax, unchanged.

---

## 3. Every kind: how create and update work

**The rule that holds the design together: an object never moves.**
- Every `Set<T>` hands out pointers that the rest of the engine keeps (`Set.h`: `Get` returns `&data[name]` into a `std::map`).
- `CREATE` is `Set::Get(name)` followed by `Load`.
- `REPLACE` is assignment from a fresh object, at the same address, followed by `Load`.
- Nothing is ever erased. Upstream's own `GameData::Revert` erases event-made universe objects on a pilot change, so their handles take a generation bump then (section 6).

**Instances are copies.** Updating a definition changes the definition. Things already made from it keep their own copy, exactly as when a plugin event changes a fleet:
- ships already built from a model;
- missions already accepted, which save themselves in full (`Mission::Save`);
- an NPC's ships.

The one exception that matters is outfits, below.

### Universe kinds (upstream events can already change them)

`fleet`, `galaxy`, `government`, `outfitter`, `planet`, `shipyard`, `system`, `news`, `substitutions`, `wormhole`, plus `link`/`unlink` (`GameEvent.cpp`, `DEFINITION_NODES`; `UniverseObjects::Change`).

- **`CREATE`/`PATCH`, `PILOT` scope:** exactly an event. `PlayerInfo::AddChanges`. Saved in the pilot's `changes` block, replayed on load. **No new engine code.** This is today's `change`.
- **`REPLACE`:** allowed for all except `government`. `Government`'s constructor takes `id = nextID++` (`Government.cpp:141`), and politics and attitude tables are indexed by that id, so assigning a fresh object would change its identity. Governments get `PATCH` only.
- **`GLOBAL` scope:** append the nodes to the generated plugin's data file, and apply them now as an event. **Catch:** `GameData::Revert` resets these kinds to `defaultSystems` and friends, the copies taken at `FinishLoading`, on every pilot change. A global change applied only to the live sets would vanish on the next load until restart. **Engine change R2:** apply global changes to the default sets too.
- **Derived state:** upstream's event path already recomputes neighbours (`GameData::UpdateSystems`).
- **Guards:** none beyond the spec's (in flight, defer to `PanelFrame`, spec 6.1).

### Other definition kinds (no event path upstream)

`outfit`, `ship` (model), `mission`, `conversation`, `effect`, `hazard`, `minable`, `phrase`, `person`, `formation`, `start`, `event` (a definition to schedule later), `interface`, `color`, `swizzle`, `trade` (commodities), `category`, `rating`, `landing message`, `star`, `tip`/`help`, `message`, `message category`, `gamerules preset`.

- **Mechanism:** generalise `RuntimeDefinitions` (API 11) from two kinds to all of these. It keeps an ordered record `{mod, kind, name, scope, mode, text}`, saves it in the pilot's `runtime definitions` block before anything that names it, and replays it on load. `GLOBAL` scope writes the generated plugin instead.
- **`REPLACE`** needs a per-class reset. Most classes are safe to assign from `T()`. The friend access already in `Outfit`, `Ship` and `Weapon` (`RuntimeDefinitionsDetail`) becomes the single place that does it.
- **Per-kind derived state and guards:**

| Kind | After a write | Guard |
|---|---|---|
| `outfit` | If it has a jump range: recompute neighbours (API 11 already does this). **Every ship that carries it caches the sum of its outfits**: `Ship::FinishLoading` sets `attributes = baseAttributes` and then adds each outfit (`Ship.cpp:1090-1099`). An outfit update changes nothing on existing ships unless they are recomputed | `UPDATE` without `ES_RESF_PROPAGATE` changes only future ships. With it, every live ship carrying the outfit is recomputed (the player's, parked, in system, stock models): **engine change R3**, a `Ship::RecomputeAttributes()`. Landed or paused only |
| `ship` | `Ship::FinishLoading(true)` on the model; variants of it are not reloaded | Existing ships are copies |
| `mission` | None. The engine offers missions by iterating `GameData::Missions()` (`PlayerInfo.cpp:2635-2680`), so a created mission is offered by the normal rules on the next offer pass | Accepted missions are copies |
| `conversation` | None | **Refused while a `ConversationPanel` is on the UI stack.** It holds `const Conversation &` (`ConversationPanel.h:124`), and `REPLACE` would change it under the reader |
| `interface` | None. Panels fetch it by name each draw (`BankPanel.cpp:74`, …) | Writes happen between frames, so they are safe |
| `person`, `phrase`, `effect`, `hazard`, `minable`, `formation` | None | Persons are also reverted on pilot change (`GameData::Revert`), so they behave as universe kinds there |
| `start`, `gamerules preset` | None | Only meaningful before a pilot exists; allowed, documented as affecting new pilots |
| `trade` | Commodity list order changes the trading panel | `PATCH` only |
| `event` | Defining is harmless. Scheduling one stays the action `APPLY_EVENT`/`SCHEDULE_EVENT` | |

### Assets

| Kind | Create | Update | Engine change |
|---|---|---|---|
| `sprite` | Build an `ImageSet` from the parts, decode with `ImageSet::Load` **on the task queue** (it is written for worker threads), then `ImageSet::Upload(SpriteSet::Modify(name))` on the main thread. Returns `ES_PENDING`, resolved when uploaded. Ship and asteroid sprites need collision masks: `MaskManager::SetMasks`, then `RegisterScale` + `ScaleMasks` | `Sprite::Unload`, then the same. **Deferred sprites** (landscapes, thumbnails, stellar objects) are dropped by `SpriteLoadManager::CullOldImages` and reloaded from the paths it recorded at start, so an update must also replace that record, or the old image comes back | **R4**: `SpriteLoadManager` gains a way to register or replace an `ImageSet` after start, and `MaskManager` a way to rescale one sprite |
| `sound` | `Audio::LoadSounds` already loads a source folder's `sounds/` in its own thread. Point it at the generated plugin, or a session folder. `ES_PENDING` | Replacing a `Sound`'s buffer while the audio thread plays it is a data race | **R5**: `Audio::Replace(name, path)` under the audio mutex, or "create only, never update" |
| `music` | `Music::Init(sources)` only adds paths to its catalogue (`Music.cpp:38-56`), so it can be called again with one new source | Same call: a later path for a name wins. A track already playing keeps playing the old one | None |
| `shader` | Pointless on its own: nothing in the engine looks a shader up by a name a mod could choose. Each drawing class fetches its own fixed one (`SpriteShader::Init`: `Shaders().Get("sprite")`, and so on) | `Shader::Load` compiles a new program, but every drawing class caches uniform and attribute locations once, in its `Init` (`SpriteShader.cpp:56-72`). Swapping the program needs those re-read, and the replacement must keep the same interface. GL and GLES need separate sources (`GameData::LoadShaders` picks `.gl`/`.gles`) | **R6**: split each `XShader::Init` (9 classes, plus `RenderBuffer`) into one-time setup and a re-bind of locations; compile and link check before swapping; keep the old program on failure. **R7** (only for *new* shaders): a mod drawing capability (a custom-draw widget or HUD layer in the UI kit) that can name a shader. Without R7, `CREATE` for shaders is refused |
| `font` | Out of scope: the engine has exactly two fixed fonts (`FONT_14_NAME`, `FONT_18_NAME`) | | |

---

## 4. Order inside one request

The root nodes of one `text` are sorted before they are applied, so that references resolve:

1. `color`, `swizzle`, `category`, `trade`, `rating`
2. `effect`, `outfit` (outfits may name effects)
3. `ship` (models install outfits), `formation`
4. `government`, `galaxy`
5. `system`, then `planet`, `wormhole`, `link`/`unlink`
6. `fleet` (names governments and ships), `hazard`, `minable`, `outfitter`, `shipyard`
7. `phrase`, `news`, `person`, `conversation`, `event`, `mission`
8. `interface`, `start`, `gamerules preset`, the rest

Within a step, nodes keep the order they were written in. A reference to a name that does not exist yet still works: `Set::Get` makes a placeholder, which is how the engine resolves forward references at load. The diagnostics then say "placeholder: \<kind\> \<name\> is not defined", from the same check as `GameData::CheckReferences`.

**One request is all or nothing.** The package parses everything, and runs `REPLACE` resets into scratch copies, before it touches any `Set`. Universe kinds go through a single `AddChanges`. Partial failure is therefore limited to a node whose `Load` warns, which is reported, not rolled back: upstream's `Load` functions never fail, they only warn.

---

## 5. Ownership and conflicts

- **A created resource belongs to the mod that created it**, and is recorded with it in `RuntimeDefinitions` or in the generated plugin.
- **`UPDATE` of a resource another mod owns** is refused (`ES_CONFLICT`). Mods coordinate through the bus or routed calls, or the owner exposes an op.
- **`UPDATE` of game-data or plugin resources** (a balance mod changing the Energy Blaster) is allowed, in `PATCH` mode, by any mod. That is what plugins do today with a second definition or an event. Two mods patching the same resource apply in resolved mod order (spec 7.3), and the conflict is logged.
- **`CREATE` of a name that exists** is refused. API 11's rule stays: the same text again from the same mod is a no-op that succeeds, so `on_load` can define unconditionally.
- **Generated plugins** are named `~generated/<mod>`, with a dependency on the mod's own plugin. If the mod's plugin is removed, the generated one stays (plugins are data). The Mods screen lists it, and `GENERATED_PLUGIN` clear removes it.

---

## 6. Engine-side mechanics

- **Threads.** Every write runs inside a hook, on the main thread, with the calculation thread paused, as every write in the spec does. Asset decoding is the exception: it runs on the task queue, and the upload happens at the next frame call.
- **Diagnostics.** `DataNode::PrintTrace` goes through `Logger`. For the duration of one request, the package installs a capture with `Logger::SetLogCallback` (`Logger.h:52`), chained to the previous callback, and returns the lines in `EsResWriteOut.diagnostics`. Mods then see "Skipping unrecognized attribute" for their own text instead of hunting for it in the log.
- **Handles.** Definitions keep generation 1, keyed by address (spec 3.3). Kinds that `GameData::Revert` resets (universe kinds, `person`) get their slots' generations bumped on a pilot change, because an object an event made for the last pilot may have been erased.
- **Caches.** A write invalidates the record caches for its kind: Argosy's per-run `Caches` today, the caching layer's epochs later.
- **Shops.** An open outfitter or shipyard lists what is new only when it is reopened (already true for API 11). The package can close and reopen nothing, so this stays documented.

---

## 7. Why not delete

Deletion would break the one invariant everything relies on.
- Pointers to definitions live everywhere: ships hold their outfits and model, missions hold conversations, systems hold planets.
- The game's own sets never erase during play.
- Saves name resources by true name, and a save naming a deleted one loads with placeholders.

What mods actually need is covered by:
- `PATCH` to make something unavailable: drop it from shops, mark a system `inaccessible`, hide a planet;
- `GENERATED_PLUGIN` clear for uninstalling;
- `PILOT`-scope definitions disappearing with the pilot;
- the existing actions for live objects (remove a ship, abort a mission).

---

## 8. Cost

| Item | Size |
|---|---|
| `RESOURCE_WRITE` for universe kinds, `PILOT` scope (event path) | Small: today's `es_change`, generalised |
| `RuntimeDefinitions` generalised to ~25 kinds, with `REPLACE` resets | Medium: one reset and one finish step per kind; most are one line |
| Generated plugins (writing, `plugin.txt`, startup works for free) | Small |
| R2: global changes survive `Revert` | Small engine change (`GameData`) |
| R3: `Ship::RecomputeAttributes`, `PROPAGATE` | Small engine change (`Ship`); walking every ship is package code |
| R4: sprite hot load and replace | Medium: `SpriteLoadManager`, `MaskManager` |
| R5: sound replace | Small, or skip (create only) |
| R6: shader replace | Medium: 10 drawing classes |
| R7: mod drawing, so new shaders are usable | Large: a new capability in the UI kit. Postpone |

**Suggested order:**
1. Data kinds in `PILOT` scope. This replaces API 11's four calls and `change`, and unblocks everything the current mods do.
2. `GLOBAL` scope and generated plugins.
3. Sprites, then sounds and music.
4. Shader replace.
5. Shader create with R7, if a mod ever needs it.
