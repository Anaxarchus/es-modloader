# Endless Sky Mod API 11: specification and implementer's guide

> **About this document.** It is guidance only. Every line of code in the repository (the game-side package, the header, the loaders, the tests) is to be written by the author, by hand. The C declarations below are the normative interface, to be typed from this text. Everything else describes responsibilities, algorithms, data structures, invariants and edge cases. Nothing here is code to paste.

**Pinned upstream.** All references to Endless Sky are to upstream `endless-sky/endless-sky` master at **`abb41b23eb4accf207714003dc41ff640a2ce61a`** (2026-10-26, "fix(mechanics): Allow disabled ships to send hails again (#12844)"). On 2026-10-28 that was also the live `refs/heads/master`. References give `file:line` **and** the function name, so they survive small drifts; when a line moves, search for the function and the quoted surrounding lines.

**How to read it.**

- **Part I** (sections 1–2): purpose, principles, and the Level 0 / adoption model.
- **Part II** (sections 3–14): the normative specification. This is the ABI, the op catalogue, and the semantics of reads, writes, registration, events, UI, persistence and trust. Implementations of the API must conform to it, whether the game-side package, a loader-mod, or a native mod.
- **Part III** (sections 15–20): the implementer's guide, a checklist to work through in order. It covers repository layout and build, the exact upstream integration points, the file-by-file plan, the map from each API feature to the upstream code that provides it, the implementation order with checkpoints, and the test plan.
- **Appendices**:
  - A: Level 0 versus adopted features, and the adoption steps.
  - B: porting the existing Dado loader, SDK and mods.
  - C: risks and open questions.

---

# Part I: Overview

## 1. Purpose and principles

The API lets native libraries ("mods") observe and change the game. One such library may be a script runtime (Dado) that hosts many script mods.

1. **One entry point.** The whole ABI is `es_call(address, op, in, out)` over plain-data (POD) structs.
   - An integer **address** selects the game (0) or a registered mod.
   - Hooks are ops the game calls on a mod's address, through the same function shape.
2. **One kind of registrant.** To the API, a "loader" is just a mod. Any mod may register further mods during startup (section 7). Native mods ship inside ordinary plugins, declared by a `mod` node in a DataNode text file (section 7.6).
3. **One header.** Ops, structs, records, properties, events, UI slots and widgets are defined in one hand-written C header, the single source of truth. Other languages build bindings from it with their own tools. The game's dispatch and discovery tables are written once next to it, and a test keeps them in sync (section 13).
4. **Main thread, engine paused.** Every hook and every `es_call` into the game happens on the main thread while the calculation thread is paused (between `Engine::Wait()` and `Engine::Go()`; section 16).
5. **Reads are views.** Reads return POD copies, safe during hooks, lazily cached and shared by all mods within a dispatch point (section 5).
6. **All state readable, writes deliberate.**
   - Every object type is readable through generic traversal ops over node trees built from the game's own serializers and public getters (Tier 1).
   - Hot paths get typed records (Tier 2).
   - Writes go only through properties the property table marks writable, and through typed actions. In the core they apply directly; an optional layer queues and commits them once per dispatch point (section 6).
7. **Specified and unspecified ops.**
   - Ops 0–999 are **specified**: their meaning and layouts are defined here.
   - Any address may implement a specified op where it makes sense. Mods implement hooks, and may answer `PING`, introspection and Tier 1 reads for their own state.
   - Ops ≥ 1000 are **unspecified**: each address defines its own and describes them in its descriptors.
8. **A layer over the engine as it is.** The API is built over upstream Endless Sky **without changing engine code**, using only what the engine already exposes publicly. This is **Level 0** (section 2). Anything that needs the engine to provide more is an **adopted** feature, listed with its cost (Appendix A). If the API is ever merged upstream, the engine can adopt those features one by one.

## 2. Level 0 and adoption

**The modding package** is everything in `source/modding/` (section 15). Nothing outside it is part of the package. The package's facade, `ModApi`, lives inside it.

**Level 0 (L0)** is what works with the package plus a handful of upstream lines that only *call into* the package (section 16). It uses only what the engine already exposes publicly:

- public getters;
- existing `Save(DataWriter &)` serializers;
- `GameData` collections;
- existing public mutators (`PlayerInfo`, `Account`, `ConditionsStore`, `Politics`, `Fleet::Enter`/`Place`, `Messages::Add`, `PlayerInfo::AddChanges` for event-style data changes);
- the existing UI stack (`UI::Push` of package-owned panels, `DialogPanel`);
- existing file and plugin facilities (`Files`, `GameData::Sources()`, `PluginManager`).

It uses no new accessors, no `friend` declarations and no changes to engine classes. A field with no public getter is not exposed at L0, and goes on the adoption list.

**The upstream lines L0 needs** (exact details in section 16):

| File | Lines | Why | Required? |
|---|---|---|---|
| `source/CMakeLists.txt` | +1 | Pull in `source/modding/Modding.cmake` | Required |
| `source/Engine.cpp` | +2 (include, call in `Engine::Step`) | Per-frame world access: ships in system, spawn list, ship events, step counter | Required |
| `source/MainPanel.cpp` | +2 (include, call in `MainPanel::Step`) | The game's `UI`, for package-owned panels and dialogs; paused-time dispatch | Required for any mod UI |

**Total: 5 lines in 3 upstream files.** Without the `MainPanel.cpp` call there is no mod UI at all, and the minimum drops to 3 lines in 2 files.

Everything else is reached by **observation** from those two calls:
- startup on the first frame, and shutdown through `std::atexit`;
- landing, take-off, jumps, day changes and pilot changes, by diffing `PlayerInfo` state;
- purchases and missions, by diffing the fleet and the mission lists;
- mod data persistence, through a sidecar file whose version is pinned by a condition in the pilot (section 11).

**Adoption** steps (Appendix A) each add a small, self-contained engine change that unlocks more. Examples: `mod` nodes accepted by the data loader, mod data inside the pilot file with a save hook, ship level setters, planet-screen and shop buttons, map overlays, HUD and key routing, job-board insertion, and the gameplay features the existing mods relied on (shop stock, outfit integration).
- `LOOKUP(feature, …)` reports which adopted capabilities a build provides, so mods adapt at run time.
- Every op, hook, event, slot and property in Part II is marked **L0** or **adopted**.

**Core and layers** are a separate axis from L0 and adopted. The **core** (section 4.5) is the small set built first: `es_call`, the registry, `mod.txt`, native loading, hooks, about 24 hand-written records, the bus, and direct writes and actions. Queued writes, Tier 1 traversal, events, the UI kit, settings, caching and routed calls are **optional layers**. The core's ABI already accommodates them, so adding a layer changes nothing the core defined.

---

# Part II: Normative specification

## 3. The C ABI

### 3.1 Entry point and status codes

```c
#define ES_API_VERSION 11
#define ES_API_MIN_VERSION 9

typedef int32_t (ES_CALL *EsCallFn)(uint32_t address, uint32_t op, const void *in, void *out);

/* Status. >= 0 is success. */
enum {
	ES_OK              =   0,
	ES_PENDING         =   1,  /* accepted; the result arrives later (pending handle in out). Core: only APPLY_EVENT in flight (section 6.1) */
	ES_UNKNOWN_OP      =  -1,  /* the address does not implement this op */
	ES_UNKNOWN_TARGET  =  -2,  /* no such address */
	ES_TARGET_GONE     =  -3,  /* address was valid this session; its mod failed or was stopped */
	ES_REFUSED_CONTEXT =  -4,  /* op not allowed in the current context (the op's context mask) */
	ES_BAD_ARG         =  -5,  /* shape or value check failed at call time */
	ES_BAD_STRUCT      =  -6,  /* in/out null, or size < the struct's minimum (its `since` size) */
	ES_TOO_SMALL       =  -7,  /* caller buffer too small; `needed` tells how much */
	ES_STALE_HANDLE    =  -8,  /* handle generation does not match */
	ES_UNKNOWN_ID      =  -9,  /* property/type/slot/event id unknown to the host */
	ES_NOT_FOUND       = -10,  /* name or key resolves to nothing */
	ES_LIMIT           = -11,  /* arena, queue or (queued layer) journal limit hit (section 12) */
	ES_CONFLICT        = -12,  /* queued layer: lost a `set` or `exclusive` merge at commit */
	ES_REJECTED        = -13,  /* state check failed (cannot afford, refused...): at call time in the core */
	ES_TIMEOUT         = -14,  /* routed call ran past its budget */
	ES_UNSUPPORTED     = -15,  /* op known, but not by this host build (e.g. used-hull patch) */
	ES_INTERNAL        = -16,
	ES_STOPPED         = -17   /* returned by a dispatch: the mod's code was stopped (watchdog); marks it STOPPED */
};
```

`in` may be null only for ops that take no input. `out` may be null only for ops whose `out` is `none`. Otherwise a null pointer returns `ES_BAD_STRUCT`.

### 3.2 Struct rules

Every in/out struct starts with a header:

```c
typedef struct EsHeader { uint32_t size; uint32_t version; } EsHeader;
```

- **`size`** is the bytes the caller allocated. The host reads `min(in->size, known)` bytes and treats unread fields as zero. It writes at most `min(out->size, known)` bytes and never touches anything past `out->size`. A size smaller than the struct's first published size returns `ES_BAD_STRUCT`.
- **`version`** is the struct's revision (`ES_REV_<STRUCT>`) in the header the caller was compiled against. On output, the host overwrites `out->version` with its own revision of that struct. **Layout is decided by `size` alone.** `version` is for diagnostics and for a caller to tell which trailing fields the host filled.
- **Append-only.** Fields are never removed, reordered or retyped. A deprecated field stays in place and is zero-filled.
- **Layout.** Natural alignment. Every field is 1, 2, 4 or 8 bytes wide, and 8-byte fields sit at 8-byte offsets. The header writes explicit `_padN` fields, so that no layout depends on compiler packing, and pads every struct to a multiple of 8. There is no `#pragma pack`. The header contains static assertions of `sizeof` and every `offsetof` (section 13.1).
- **Endianness.** Little-endian only (every platform Endless Sky ships for). The header asserts this at compile time.
- **Booleans** are `uint8_t`. On input the host treats any non-zero value as true. On output it writes exactly 0 or 1.
- **Numbers.** Integers are `int32_t`/`int64_t`/`uint32_t` as the header says; credits and condition values are `int64_t`. Reals are `double`. Colours are `float[4]`, 0..1.
- **Pointers** occupy 8 bytes on every platform, including 32-bit Windows:
  ```c
  #define ES_PTR(T) union { T *p; uint64_t _bits; }
  typedef struct EsStr  { ES_PTR(const char) s; uint32_t len; uint32_t _pad; } EsStr;          /* UTF-8, not necessarily NUL-terminated on input */
  typedef struct EsSpan { ES_PTR(const void) data; uint32_t count; uint32_t stride; } EsSpan;    /* array of records */
  typedef struct EsBuf  { ES_PTR(void) data; uint32_t capacity; uint32_t needed; } EsBuf;        /* caller-owned output buffer */
  ```
  Strings the host returns are NUL-terminated as a convenience; `len` excludes the NUL.
- **Arrays** in a returned record are `EsSpan`. **Callers walk them by `stride`, never by `sizeof`**, so an older caller reads the prefix it knows of a newer, longer record.

### 3.3 Handles

```c
typedef uint64_t EsHandle;   /* 0 = none */
/* bits 63..56 handle type id (ES_TYPE_*), 55..32 generation, 31..0 slot */
#define ES_HANDLE_TYPE(h) ((uint32_t)((h) >> 56))
```

- **The host keeps one slot table per handle type.**
  - Definitions (systems, planets, governments, outfits, ship models, fleets, commodities) are keyed by their `GameData` pointer. Those pointers are stable for the session; events modify the objects in place. They get generation 1.
  - Live objects (ships in system, the player's ships, missions, pending results, UI instances) hold a `weak_ptr` or an id, and the slot's generation is bumped every time the slot is reused or the object dies.
  - A pilot change, detected as in section 11.3, bumps the generation of every slot of the live types.
- **Validity.** A handle whose type, slot or generation does not match returns `ES_STALE_HANDLE`. A stale handle is never silently aliased to another object.
- **Keys.** Handles are session-local and never saved. A persistent reference uses the object's key: the true name, or the UUID for the player's ships. The `FIND` op turns a key into a handle, and `KEY_OF` turns a handle into its key.

### 3.4 Variable-size results: the per-hook scratch arena

Every op whose result has variable size takes an `EsBuf buf` in its `in` struct and returns an `EsSpan` (or `EsStr`) in its `out` struct. There are two modes.

- **Arena mode** (`buf.data == NULL`). This is the core's default, and the only mode a caller *must* support inside hooks.
  - The game marshals the result into the calling mod's **per-hook scratch arena**: host memory, reset when the current hook returns.
  - **The result is valid until the hook returns.**
  - Each read is one call and one marshal, with no size query.
- **Caller-buffer mode** (`buf.data != NULL`).
  - The game packs the records, and then their strings and nested arrays, into the caller's buffer, with every pointer pointing inside that buffer.
  - If `buf.capacity` is too small, the game writes nothing and returns `ES_TOO_SMALL` with `buf.needed` set: the two-call pattern.
  - It is required outside a hook (`es_mod_init`, `HOOK_SHUTDOWN`), where there is no arena, and is useful when data must outlive the hook.

**Why the arena is the core's default.** It defines one simple lifetime rule ("until the hook returns") that every binding can follow. It needs no second call. And since the core caches nothing, the two-call pattern would marshal everything twice.

**Implementation.**
- The arena is a list of 64 KiB chunks per hook bracket; the chunks are never moved.
- A request larger than a chunk gets its own allocation.
- The limit is 4 MiB per hook. Beyond it the op returns `ES_LIMIT`, and the caller can retry in caller-buffer mode.

### 3.5 Addresses

| Address | Meaning |
|---|---|
| `0` (`ES_ADDR_GAME`) | The game. Fixed. |
| `1 … 0x7FFFFFFE` | Mods of every kind, in registration order: static entries from `mod` nodes first, then mods registered at run time (section 7). |
| `0xFFFFFFFF` (`ES_ADDR_SELF`) | The caller's own address, resolved by the host from the open bracket. |

- Addresses are stable for the session and **never reused**.
- They are never saved. Persistent references between mods use names, resolved through the registry.

### 3.6 Handshake: one entry point per native library

Every native library the game opens (section 7.3 says which, and when) exports exactly one function:

```c
#define ES_API_VERSION 11
#define ES_MOD_INIT_SYMBOL "es_mod_init"

typedef struct EsBoot {
	EsHeader h;
	EsCallFn es_call;          /* the game's dispatcher */
	uint32_t address;          /* the address assigned to this library's own mod */
	uint32_t header_revision;  /* ES_HEADER_REVISION of the game */
	uint32_t _pad0;
	EsStr    library_path;     /* UTF-8, the cached copy actually opened */
	EsStr    platform;         /* "macos", "macos-arm64", "linux-x86_64", "windows-x86_64", ... */
} EsBoot;

/* Fill `self` (section 7.2) and answer ES_OK, or decline with a negative status. */
typedef int32_t (ES_CALL *EsModInitFn)(const EsBoot *boot, EsModReg *self);
```

`ES_CALL` is `__cdecl` on 32-bit Windows and the platform default elsewhere. `ES_EXPORT` expands to `__declspec(dllexport)` on Windows and to default visibility elsewhere, plus `extern "C"` in C++.

- **Dispatch.** `self->dispatch` is the library's own `es_call`-shaped function. The game calls the library's hooks through it, and also the hooks of every mod the library registers later, unless a registration supplies its own dispatch.
- **Descriptors.** The library declares the specified ops it implements (hooks, and optionally `DESCRIBE`/`GET`/…), its unspecified ops, its dependencies and its version. These must match its plugin's `mod` node, which the game read before opening the library (section 7.6).
- **Script runtimes.** A library that hosts script mods, such as the Dado runtime, implements `HOOK_DISCOVER` and registers each script mod there (section 7.3).
- **Where libraries live.** There is no native-code directory. A library ships inside a plugin folder, next to that plugin's `data/`, `images/` and `scripts/`. The game opens it only if:
  - the plugin is enabled;
  - the descriptor came from that plugin;
  - native mods are not switched off by the troubleshooting switch (section 14).

## 4. The op space

### 4.1 Design choice: hybrid (option c)

| Criterion | (a) Generic verbs + IDs in struct | (b) One typed op per call | (c) Hybrid: typed record reads, actions, hooks and UI; generic SET/ADD over properties |
|---|---|---|---|
| Per-call cost | Switch on op, then a second table lookup on type/property id, plus a generic marshaller | One switch, typed marshaller | One switch for reads and actions. Writes: a property-table lookup (an array index, ~2 ns) |
| ABI churn as features grow | None in op codes; churn moves into IDs | One op per accessor: well over 100 ops, and every new field becomes a new op | A new field is an append to a record (no new op). A new object kind adds two ops. A new writable property adds an ID only |
| Typed wrappers | Need a per-ID generic layer; types are erased at the ABI | Trivial | Trivial for reads and actions. Writes go through `SET` with a property id; bindings may add per-property wrappers |
| Discovery | Two levels (op, then ID) | One level, many names | Op names for records and actions; property names for writes |
| Codes used in ~3 years | ~30 | 400–600 | ~110–160 |

**Decision: (c).**
- **Reads come in two tiers** (section 5).
  - **Tier 1** is a handful of generic traversal ops (`LIST`, `FIND`, `DESCRIBE`, `GET`, `ATTRS`) over every object type, with no per-field bookkeeping.
  - **Tier 2** is a small set of typed records for hot paths. Each record returns everything about an object in one call.
- **Writes** are field-level (and, in the queued layer, carry merge semantics per property), so a generic `SET`/`ADD`/`APPEND`/`REMOVE`/`WRITE_BATCH` over property IDs is the natural unit. It also means a new writable field needs no op.
- **Actions, hooks and UI** are irregular, and each gets a typed op with its own args struct.

**No masked partial-record updates (`SHIP_UPDATE` with a field mask).**
- Masks would duplicate per-property validation (and, later, merge logic) per record type.
- They would complicate conflict detection in the queued layer, which is per property.
- `WRITE_BATCH` already gives one boundary crossing for many fields.

Bindings may offer `game.player.update({credits: …, …})`, which emits one `WRITE_BATCH`.

### 4.2 Layout of the specified range, 0–999

| Block | Domain | Specified in API 11 | Unassigned |
|---|---|---|---|
| 0 | `PING` (every address must implement it) | 0 | — |
| 1–49 | **Hooks**: ops the game calls on a mod's address | 1–5, 10–12, 20–23, 30–33 | 33 |
| 50–99 | Core: introspection, registry, identity, diagnostics | 50–53, 60, 62–66, 72–74, 79 | 36 |
| 100–149 | **Tier 1: generic traversal** | 100–109 | 40 |
| 150–199 | Unassigned: growth of traversal, hooks and core | — | 50 |
| 200–299 | **Tier 2 records: world and economy** | 200–212 | 87 |
| 300–399 | **Tier 2 records: flight and player** | 300–311 | 88 |
| 400–449 | Writes and journal | 400–404, 410–411 | 43 |
| 450–549 | Actions (typed, validated) | 450–459 | 90 |
| 550–599 | Events and the bus | 550–554 | 45 |
| 600–699 | UI kit | 600–603 | 96 |
| 700–749 | Settings and keys | 700–702 | 47 |
| 750–799 | Mod-to-mod routing | 750–751 | 48 |
| 800–949 | Unassigned future domains | — | 150 |
| 950–999 | Conformance, debug, test-only (never in release dispatch) | 950–955 | 44 |
| ≥ 1000 | **Unspecified**: each address's own ops, described by its descriptors | — | — |

**Usage projection.** API 11 specifies 103 codes. Tier 1 means a new object type, or a new field upstream adds, needs **no new op**. Growth comes only from:
- new Tier 2 records for proven hot paths, perhaps 10–20;
- new actions, perhaps 30;
- new hooks, perhaps 10.

That is about 160 codes in three years. Every block stays below about 40% full.

**Cost per op.**
- Dispatch is one hand-written `switch` on the op (a jump table), then that op's marshalling.
- Hooks sit in the lowest codes because they are the per-frame path into mods. A mod's dispatch can then switch on a dense 1–49 range.

### 4.3 The specified ops

**Who implements what.** Each specified op's entry in the `ModOps` table (section 13.2) says who may implement it (`implementors`):

| Implementors | Ops |
|---|---|
| **Every address** | `PING` 0 |
| **Mods** (the game calls them) | hooks 1–49 |
| **Game and mods** | `INTROSPECT` 52 and `LIST_IDS` 53 (for the mod's own ops); the Tier 1 reads 100–107 (for the mod's own state, section 9.1) |
| **Game only** | Everything else. A mod registering one of these is refused |

**Notation.**
- "Imm." means the op never changes game state. In the core every write is direct (section 6.1); "Imm." matters to the queued-writes layer, which journals every non-immediate write.
- **Contexts:**
  - F = flight;
  - L = landed;
  - U = UI hook (the player acted in a mod-owned panel);
  - O = outfitter;
  - Q = query hook;
  - S = save;
  - P = pilot loaded;
  - R = registration phase (`HOOK_DISCOVER`);
  - D = load (`HOOK_START`);
  - E = event or bus delivery;
  - I = init, or outside a hook.
- **Lvl:** **L0** works with the Level 0 integration only. **Ad.** needs an adoption step (Appendix A; step number in brackets).

**Hooks (game → mod), 1–49**

| Code | Op | Ctx | In-struct | Lvl |
|---|---|---|---|---|
| 0 | `PING` | any + I | — (answers address, API version, header revision) | L0 |
| 1 | `HOOK_START` | D | `{order, deps span}`: registry sealed; `on_load` | L0 |
| 2 | `HOOK_PILOT_LOADED` | P | — | L0 (observed, section 11.3) |
| 3 | `HOOK_SAVE` | S | — | Ad. [A2] |
| 4 | `HOOK_SHUTDOWN` | I | — (reverse order; a registrant after its sub-mods) | L0 (`atexit`); exact timing Ad. [A3] |
| 5 | `HOOK_DISCOVER` | R | `{sources span}` (any mod may `REGISTER_MOD`) | L0 |
| 6–9 | unassigned (lifecycle) | | | |
| 10 | `HOOK_DAY` | F L | `{day}` | L0 (observed) |
| 11 | `HOOK_ENTER` | F L | `{system, key}` | L0 (observed) |
| 12 | `HOOK_STEP` | F | `{step}` | L0 |
| 13–19 | unassigned (time) | | | |
| 20 | `HOOK_UI` | U | `{slot, instance, widget, action, value, text}` | L0 for mod-owned slots; vanilla-panel slots Ad. [A6–A9] |
| 21 | `HOOK_QUERY` | Q | `{query, args}`, out `{answer}`; writes refused | Ad. [A7] |
| 22 | `HOOK_KEY` | F L U | `{key id}` | Ad. [A9] (L0 only while a mod-owned panel has focus) |
| 23 | `HOOK_SETTING` | U | `{setting id}` | L0 (from the mod-owned settings screen) |
| 24–29 | unassigned (UI and input) | | | |
| 30 | `HOOK_NOTIFICATION` | E | `{name, payload, sender, sender name}` | L0 |
| 31 | `HOOK_EVENTS` | E | `{events span}` | L0 for observable events (section 8) |
| 32 | `HOOK_COMMIT_RESULTS` | E | `{results span}` | L0 |
| 33 | `HOOK_ROUTED` | E | `{caller, op, in bytes}` | L0 |
| 34–49 | unassigned (delivery) | | | |

**Core, 50–99** (game address unless noted; all immediate; all L0)

| Code | Op | Ctx | Notes |
|---|---|---|---|
| 50 | `API_INFO` | any + I | API version, header revision, ID-space counts, build's adopted features |
| 51 | `LOOKUP` | any + I | `(kind, name)` → code/id + `since` + flags. Kinds: op, record, type, property, event, slot, widget, feature (including adopted capabilities), unspecified op, stable path |
| 52 | `INTROSPECT` | any + I | `(kind, id)` → descriptor (contexts, merge, struct layout) |
| 53 | `LIST_IDS` | any + I | All ids of a kind |
| 60 | `REGISTER_MOD` | R | Register a further mod; the caller supplies its dispatch |
| 62 | `REGISTRY_FIND` | any + I | By name, plugin, feature or unspecified-op name |
| 63 | `REGISTRY_LIST` | any + I | All entries, in resolved order |
| 64 | `REGISTRY_OPS` | any + I | One address's `EsOpDesc[]` |
| 65 | `WITHDRAW` | any | Self, or a mod whose dispatch you provide; `ES_WITHDRAW_GROUP` |
| 66 | `DEP_STATUS` | any | The caller's `EsDepResult[]` |
| 72 | `TIMING_SECTION` | any | |
| 73 | `LOG` | any + I | |
| 74 | `CONTEXT` | any | Context bits, dispatch point, self address |
| 79 | `CACHE_STATS` | any | Caching layer: hits, misses, builds (answers `ES_UNKNOWN_OP` in the core) |

Codes 54–59, 61, 67–71, 75–78 and 80–99 are unassigned.

**Tier 1: generic traversal, 100–149** (section 5.2). All are reads except `PUBLISH`. They may be sent to the game's address or to a mod's. All are L0, with coverage per type as in section 18.2.

| Code | Op | In → out |
|---|---|---|
| 100 | `TYPES` | → `{type id, name, live/definition, count}[]` |
| 101 | `LIST` | `{type, filter path?, filter value?, buf}` → `{handle, key}[]` |
| 102 | `FIND` | `{type, key}` → handle (true name, UUID, or `"type:key"` text) |
| 103 | `KEY_OF` | handle → `{type, key}` |
| 104 | `DESCRIBE` | `{handle, path?, depth}` → `EsNode` tree |
| 105 | `GET` | `{handle, path}` → one `EsNode` (with its subtree to `depth`) |
| 106 | `GET_MANY` | `{handles span, paths span}` → `EsNode*` matrix |
| 107 | `ATTRS` | handle → `{name, value, text}[]` |
| 108 | `STABLE_PATHS` | type → documented stable paths and aliases (section 5.5) |
| 109 | `PUBLISH` | Mod → game, a write: an `EsNode` tree becomes the snapshot that Tier 1 reads of the caller's `mod` handle return (section 9.1) |

**Tier 2: typed records, 200–399** (section 5.6; hand-written records in the header; field sources in section 18.1)

| Code | Op | Record | Cache scope (caching layer) | Lvl |
|---|---|---|---|---|
| 200 | `SYSTEMS` | `SystemInfo[]` | session | L0 |
| 201 | `SYSTEM_INFO` | `SystemInfo` | session | L0 |
| 202 | `PLANET_INFO` | `PlanetInfo` | session | L0 (defense fleets field Ad. [A5]) |
| 203 | `GOVERNMENT_INFO` | `GovernmentInfo` (incl. reputation) | point | L0 |
| 204 | `GOVERNMENT_ATTITUDES` | `{toward, attitude}[]` | point | L0 |
| 205 | `FLEET_INFO` | `FleetInfo` | session | L0 for `strength` (`Fleet::Strength`); averaged stats Ad. [A5] |
| 206 | `COMMODITIES` | `{name, low, high}[]` | session | L0 |
| 207 | `MARKET` | `{commodity, price, base_price}[]` for a system | point | L0 for `price`; `base_price` Ad. [A5] |
| 208 | `SHIPYARD_LISTING` | `{model}[]` for a planet (+ `stock`, `note` Ad. [A13]) | point | L0 |
| 209 | `OUTFITTER_LISTING` | `{outfit}[]` for a planet (+ `stock` Ad. [A13]) | point | L0 |
| 210 | `PLUGINS` | `{name, enabled, path}[]` | session | L0 |
| 211 | `MODEL_INFO` | `ModelInfo` (incl. computed new-ship cost) | session | L0 |
| 212 | `OUTFIT_INFO` | `OutfitInfo`: name, category, cost, mass, outfit space, weapon, ammo | session | L0 |
| 300 | `PLAYER_STATE` | `PlayerState`: day, step, system, planet, flagship, credits | point | L0 |
| 301 | `SHIPS_IN_SYSTEM` | `ShipState[]` | point | L0 |
| 302 | `SHIP_STATE` | `ShipState` | point | L0 |
| 303 | `PLAYER_FLEET` | `FleetShip[]` | point | L0 |
| 304 | `PLAYER_CARGO` | `{commodity, tons}[]` | point | L0 |
| 305 | `CONDITIONS_GET` | names[] → values[] | point | L0 |
| 306 | `TAG_STATS` | `{tag, strength, ships}[]` | point | L0 |
| 307 | `KILLS` | `{tag, count}[]` | point | L0 |
| 308 | `STEP_LOSSES` | `Loss[]` | point | L0 |
| 309 | `OUTFITTER_SELECTION` | `{ships span, outfit}` | point | Ad. [A7] |
| 310 | `STORAGE_GET` | keys[] → values[] (own saved data) | point | L0 (sidecar, section 11) |
| 311 | `SHIP_OUTFITS` | `{outfit, count}[]` for a ship | point | L0 |

Codes 213–299 and 312–399 are unassigned.

**Writes and journal, 400–449** (all L0 as ops; each *property* has its own level, section 6.3)

| Code | Op | Notes |
|---|---|---|
| 400 | `SET` | `{handle, property, key, value}`; only properties the property table marks writable |
| 401 | `ADD` | Numeric deltas on `add` properties |
| 402 | `APPEND` | `append` collections (messages) |
| 403 | `REMOVE` | Keyed entries |
| 404 | `WRITE_BATCH` | `EsWrite[]` |
| 410 | `JOURNAL_STATUS` | Imm.: entries and bytes, limits |
| 411 | `PENDING_STATUS` | Imm.: pending handle → status, result |

**Actions, 450–549** (core: applied directly and validated at call time; queued layer: journalled, `produce` merge, validated at commit)

| Code | Op | Ctx | Lvl and upstream mechanism |
|---|---|---|---|
| 450 | `SPAWN_FLEET` | F | L0: `Fleet::Enter`/`Fleet::Place` into the engine's `newShips` (section 18.3) |
| 451 | `APPLY_EVENT` | any but Q | L0: `PlayerInfo::AddChanges` |
| 452 | `BUY_SHIP` | U L, not O | L0 with shipyard semantics (`PlayerInfo::BuyShip`); "delivery without shop side effects" Ad. [A13] |
| 453 | `PARK_SHIP` | U L, not O | L0: `PlayerInfo::ParkShip` |
| 454 | `REMOVE_SHIP` | U L, not O | L0: `PlayerInfo::DisownShip` |
| 455 | `INTEGRATE_OUTFIT` | U O L | Ad. [A13]: needs the engine's outfit-integration feature |
| 456 | `OFFER_JOB` | L | Ad. [A10] |
| 457 | `RESET_KILLS` | F L | L0 |
| 458 | `GIVE_OUTFIT` | U L | L0: `Ship::AddOutfit` on one of the player's ships (new in 11) |
| 459 | `GRANT_LICENSE` | any but Q | L0: `PlayerInfo::AddLicense` (new in 11) |

Codes 460–549 are unassigned.

**Events and bus, 550–599** (L0):
- 550 `SUBSCRIBE`
- 551 `UNSUBSCRIBE`
- 552 `NOTIFY` (core: enqueued at call time)
- 553 `LISTEN`
- 554 `UNLISTEN`

**UI, 600–699** (L0 for mod-owned slots, section 10):
- 600 `UI_SHOW`
- 601 `UI_UPDATE`
- 602 `UI_CLOSE`
- 603 `UI_STATE`

**Settings and keys, 700–749:**
- 700 `SETTING_DECLARE` (L0)
- 701 `SETTINGS_GET` (L0)
- 702 `KEY_DECLARE` (Ad. [A9])

**Routing, 750–799:**
- 750 `CALL_ASYNC` (L0)
- 751 `CALL_SYNC` (latest layer)

**Test, 950–999:** 950–955 `TEST_*`, only in test builds.

That is 103 specified codes, 97 of them outside the test block.

### 4.4 ID spaces

Besides op codes, the header defines these ID spaces. **All IDs are written explicitly in the header and never reused** (section 13.1).

| Space | Width | Used by |
|---|---|---|
| Handle type id (= Tier 1 type id) | 8 bits (in the handle) | `TYPES`, `LIST`, `FIND`, `KEY_OF`, handle validation |
| Record id | u16 | `INTROSPECT`, bindings |
| Property id | u32 | `SET`/`ADD`/`APPEND`/`REMOVE`/`WRITE_BATCH` |
| Event id | u16 | `SUBSCRIBE`, `HOOK_EVENTS` |
| Slot id | u16 | `UI_*`, `HOOK_UI` |
| Widget kind | u16 | UI specs |
| Feature id | u16 | `LOOKUP(feature)` |

**Discovery.**
- `LOOKUP(property, "player.credits")` returns the property id, its `since`, its merge mode and its context mask.
- `LOOKUP(op, "SHIP_STATE")` returns 302. `LOOKUP(unspecified_op, "diplomacy.war_state")` must be sent to that mod's address.
- Bindings resolve every name they use once, at load, and cache the result. Script mods never see a number.
- `game.has("adopted:planet.button")` is a `LOOKUP` that succeeds.
- A name unknown to an older game returns `ES_NOT_FOUND`, and the binding then answers "not available" instead of failing.

### 4.5 The core and the optional layers

The ABI is designed in full up front: struct headers, the op layout, status codes, handles and the arena rules. It is then implemented as a **small core plus optional layers**. Every later layer fits into that ABI without changing what the core defines:
- new ops go into their unassigned blocks;
- new record fields are appended;
- the queued write mode uses the same op shapes as the immediate one;
- `ES_PENDING` and pending handles are already defined, so callers written against the core handle them.

| Layer | Ops (codes) | Est. effort (one developer, by hand) |
|---|---|---|
| **Core 1: skeleton** | `PING` 0; hooks `HOOK_START` 1, `HOOK_PILOT_LOADED` 2, `HOOK_SHUTDOWN` 4, `HOOK_DISCOVER` 5, `HOOK_DAY` 10, `HOOK_ENTER` 11, `HOOK_STEP` 12, `HOOK_NOTIFICATION` 30; `API_INFO` 50, `LOOKUP` 51, `INTROSPECT` 52, `LIST_IDS` 53; `REGISTER_MOD` 60, `REGISTRY_FIND` 62, `REGISTRY_LIST` 63, `REGISTRY_OPS` 64, `WITHDRAW` 65, `DEP_STATUS` 66; `TIMING_SECTION` 72, `LOG` 73, `CONTEXT` 74; `FIND` 102, `KEY_OF` 103 (24 ops). Also the `mod.txt` node, native library loading, dependency ordering, the two integration calls and the timing report | 4–5 weeks |
| **Core 2: records and the bus** | `SYSTEMS` 200, `SYSTEM_INFO` 201, `PLANET_INFO` 202, `GOVERNMENT_INFO` 203, `GOVERNMENT_ATTITUDES` 204, `FLEET_INFO` 205, `COMMODITIES` 206, `MARKET` 207, `SHIPYARD_LISTING` 208, `OUTFITTER_LISTING` 209, `PLUGINS` 210, `MODEL_INFO` 211, `OUTFIT_INFO` 212; `PLAYER_STATE` 300, `SHIPS_IN_SYSTEM` 301, `SHIP_STATE` 302, `PLAYER_FLEET` 303, `PLAYER_CARGO` 304, `CONDITIONS_GET` 305, `TAG_STATS` 306, `KILLS` 307, `STEP_LOSSES` 308, `STORAGE_GET` 310, `SHIP_OUTFITS` 311; `ATTRS` 107; `NOTIFY` 552, `LISTEN` 553, `UNLISTEN` 554 (28 ops, 24 of them records) plus the view cache | 4–5 weeks |
| **Core 3: writes and actions, immediate** | `SET` 400, `ADD` 401, `APPEND` 402, `REMOVE` 403, `WRITE_BATCH` 404, `PENDING_STATUS` 411; `SPAWN_FLEET` 450, `APPLY_EVENT` 451, `BUY_SHIP` 452, `PARK_SHIP` 453, `REMOVE_SHIP` 454, `RESET_KILLS` 457, `GIVE_OUTFIT` 458, `GRANT_LICENSE` 459 (14 ops), applied **immediately inside the hook bracket** (section 6.1); persistence (section 11) | 2–3 weeks |
| **Core total** | 66 ops | **10–13 weeks** |
| Layer: queued writes | `JOURNAL_STATUS` 410, `HOOK_COMMIT_RESULTS` 32; journals, merge, commit, read-your-own-writes overlay (section 6) | 3–4 weeks |
| Layer: Tier 1 traversal | `TYPES` 100, `LIST` 101, `DESCRIBE` 104, `GET` 105, `GET_MANY` 106, `STABLE_PATHS` 108, `PUBLISH` 109; serializer adapters, definition serializers, path walker, coverage script (section 5) | 5–6 weeks |
| Layer: events | `SUBSCRIBE` 550, `UNSUBSCRIBE` 551, `HOOK_EVENTS` 31; observers (section 8.2) | 1–2 weeks |
| Layer: UI kit | `UI_SHOW` 600, `UI_UPDATE` 601, `UI_CLOSE` 602, `UI_STATE` 603, `HOOK_UI` 20; package panels, dialogs, condition triggers, Mods screen (section 10) | 4–5 weeks |
| Layer: settings and keys | `SETTING_DECLARE` 700, `SETTINGS_GET` 701, `HOOK_SETTING` 23 (`KEY_DECLARE` 702 and `HOOK_KEY` 22 need A9) | 1 week |
| Layer: caching | `CACHE_STATS` 79; shared views per dispatch point and session (section 5.7) | 2 weeks |
| Layer: routed mod-to-mod calls | `CALL_ASYNC` 750, `HOOK_ROUTED` 33; later `CALL_SYNC` 751 | 2–3 weeks |
| Adopted only (Appendix A) | `HOOK_SAVE` 3, `HOOK_QUERY` 21, `HOOK_KEY` 22, `KEY_DECLARE` 702, `OUTFITTER_SELECTION` 309, `INTEGRATE_OUTFIT` 455, `OFFER_JOB` 456 | per step |

Two Tier 2 records, `OUTFIT_INFO` 212 and `SHIP_OUTFITS` 311, are core so that outfits are readable without the Tier 1 layer. The block tables in 4.2 and 4.3 include them. A game that lacks a layer answers its ops with `ES_UNKNOWN_OP`, and does not list them in `LIST_IDS`.

---

## 5. Reads: state coverage in two tiers

**Layers.**
- Tier 2 records (5.6) are **core**, and every read marshals fresh: the core has no cache.
- Tier 1 traversal (5.1–5.5) and caching (5.7) are **optional layers**. Their ops answer `ES_UNKNOWN_OP` until they are built.
- `FIND`, `KEY_OF` and `ATTRS` are core, because records need them.

**Everything the engine exposes is readable.** Two tiers share one handle space:

| Tier | What | Ops | Bookkeeping per field |
|---|---|---|---|
| **1. Procedural** | Every object of every type, as a node tree in the game's own data-file shape | 100–108 | **None** for serializer-backed types: a field upstream adds to a `Save` is readable with no package change. Definition types: one line per key in the package's serializers |
| **2. Typed** | A small set of fixed POD records for per-frame and economy use | 200–212, 300–311 | One header field and one line in the record's fill function |

### 5.1 Where the trees come from (Tier 1 layer; all Level 0)

**Classes with a serializer.** These classes have a public `Save(DataWriter &)` upstream. A tree is produced by calling it on a `DataWriter` constructed with no path (`DataWriter()`, `DataWriter.h:39`), taking `DataWriter::SaveToString()` (`DataWriter.h:51`), re-parsing with `DataFile(std::istream &)` (`DataFile.h:38`), and converting the nodes to `EsNode` (5.2).

| Class: serializer (upstream) | Exposed as |
|---|---|
| `Ship::Save` (`Ship.cpp:1253`): `ship`, `name`, `uuid`, `attributes` (`:1279`), `outfits` (`:1338`), `crew`/`fuel`/`shields`/`hull`/`position` (`:1356-1360`), engines, hardpoints, cargo, `system`/`planet`/`parked` | `ship` (live). Also `ship_model`: the stock models in `GameData::Ships()` (`GameData.h:151`) serialize the same way |
| `Mission::Save` (`Mission.cpp:427`) | `mission` (`PlayerInfo::Missions()`, `AvailableJobs()`, `PlayerInfo.h:245-246`) |
| `Account::Save` (`Account.cpp:84`), `Mortgage::Save` (`Mortgage.cpp:109`) | `player` path `accounts` |
| `CargoHold::Save` (`CargoHold.cpp:99`) | `player` path `cargo`; `ship` path `cargo` |
| `ConditionsStore::Save` (`ConditionsStore.cpp:68`) | `player` path `conditions` (on demand only, 5.7) |
| `BookEntry::Save` (`BookEntry.cpp:102`) | `player` path `logbook` |
| `Depreciation::Save` (`Depreciation.cpp:95`) | `player` paths `basis`, `stock` |
| `GameEvent::Save` (`GameEvent.cpp:134`) | `event` |
| `Conversation::Save` (`Conversation.cpp:192`) | `conversation` |
| `NPC::Save` (`NPC.cpp:268`), `Personality::Save` (`Personality.cpp:167`), `ShipManager::Save` (`ShipManager.cpp:82`), `Message::Save` (`Message.cpp:208`) | subtrees |
| `CoreStartData::Save` (`CoreStartData.cpp:47`), `Gamerules::Save` (`Gamerules.cpp:157`) | `start`, `gamerules` |

**The `player` tree.**
- `PlayerInfo::Save(DataWriter &)` (`PlayerInfo.cpp:5031`) is a const function with no side effects upstream, so `DESCRIBE(player)` at full depth may use it.
- It writes the whole pilot, including every condition and ship, so the package builds the player's subtrees lazily from the sub-serializers above and from public getters instead (`GetDate`, `GetSystem`, `GetPlanet`, `Licenses`, `Ships`, `Missions`, …; section 18.2). It falls back to the full `Save` only for a full-depth `DESCRIBE`.

**Definitions without a serializer** need their own serializers. These are `System`, `Planet`, `Government`, `Fleet`, `Outfit`, `Galaxy`, `Wormhole`, `Hazard`, `Minable`, `Phrase`, `News`, `Person`, `Effect`, commodities, `Shop<>` sales, `Swizzle` and `Formation`.

- **Chosen: minimal serializers in the package**, `source/modding/ModSerialize.cpp`. There is one function per class. Each emits the class's own data-file keys, built **only from public getters**.
  - Events change these objects in place (through `GameData::Change`, `GameData.h:113`, called from the event system), so the output is always current.
  - Nothing is kept in memory until asked for.
  - Section 18.2 lists, per class, which keys are reachable at L0 and which are not. The unreachable ones go to adoption step A5.
- **Rejected: keeping parsed `DataNode`s and re-applying events.**
  - Each class's `Load` applies its own `add`/`remove` merge rules, so the package would have to re-implement every `Load`.
  - It would keep tens of MB of nodes that the game frees after loading.
  - It needs a hook in `UniverseObjects`.

**A coverage check makes drift visible.** A small script, `source/modding/tools/coverage.py`, run by hand or in CI, extracts every `key == "..."` from each definition class's `Load` and diffs them against the keys `ModSerialize` emits. Unlisted new keys fail CI unless they are recorded as `ignored` or `no-getter` in `source/modding/coverage.txt`.

**Attributes** come straight from the engine's maps, through `ATTRS`:
- an outfit's attributes: `Outfit` iteration with `begin()`/`end()` (`Outfit.h:118-119`), or `Precise()` (`Outfit.h:121`);
- a ship's combined attributes: `Entity::Attributes()` (`Entity.h:46`);
- a planet's attribute set: `Planet::Attributes()` (`Planet.h:83`), with each value reported as 1.

### 5.2 Node view, handles and path syntax

**POD form.** A tree is laid out in the arena depth-first, with each node's children contiguous:

```c
typedef struct EsToken {
	uint32_t kind;          /* ES_TOK_TEXT, ES_TOK_NUMBER, ES_TOK_REF */
	uint32_t _pad;
	double   number;        /* when the token parses as a number (DataNode::IsNumber) */
	EsHandle ref;           /* when the serializer marks the token as naming another object */
	EsStr    text;          /* always: the token exactly as written, so nothing is lost */
} EsToken;                  /* 40 bytes */

typedef struct EsNode {
	EsStr    key;           /* token 0 */
	uint32_t token_count;   /* value tokens after the key */
	uint32_t child_count;
	ES_PTR(const EsToken) tokens;
	ES_PTR(const struct EsNode) children;
	uint32_t flags;         /* ES_NODE_TRUNCATED (depth limit), ES_NODE_REF (whole node names an object) */
	uint32_t _pad;
} EsNode;                   /* 48 bytes */
```

**References.**
- Where a serializer writes another object's true name, `ModSerialize` tags the token as a reference: a planet's `system` and `government`, a ship's `government` and `system`, a mission's `destination` and `waypoint`, a system's `link` and `object` planets, a fleet's `government`, an outfit's `ammo`.
- `ModSerialize` does this with a per-class table of `(path, handle type)`, so the tree links up.
- For `Save`-backed classes, the same table is applied after parsing.

**Path syntax.** A path is segments separated by `/`:

| Segment | Selects |
|---|---|
| `name` | The first child whose key is `name`. Keys may contain spaces (`outfit space`); `\/` and `\\` escape |
| `name[n]` | The n-th child (0-based) with key `name` |
| `n` | The n-th child of any key: lists (`planets/0`) |
| `name=value` | The first child with key `name` whose first value token is `value` (`integrated=Energy Blaster`) |
| `*` | All children: `GET` returns a synthetic node holding them |
| `@n` (last segment only) | Value token n of the selected node, as a one-token node |
| `#count` (last segment only) | The number of children, as a number |

**Traversal across references.** When a segment lands on a reference and more segments follow, the walk continues in the referenced object's tree. `system:Sol` → `planets/0/government` goes from the system to its first planet's tree, then to that planet's `government` token, which is itself a reference to a government handle. At most 8 hops are allowed.

**Synthetic lists.** `ModSerialize` adds a few keys that data files spell differently, so lists read naturally:
- `system`: `planets` (the planets of its `object` tree, flattened) and `links`;
- `planet`: `outfitters` and `shipyards`;
- `player`: `ships` (references) and `missions` (references);
- `government`: `reputation` (from `Politics`) and `attitude toward/<government>`;
- `market`: one child per system, then `<commodity> <price>`. A base price is added once adoption step A5 provides it.

Synthetic keys are marked in `STABLE_PATHS`.

**Text addresses.** `FIND` also accepts `"type:key"`, for example `system:Sol` or `ship:00000000-...-0001`. Bindings accept that string wherever a handle is expected.

### 5.3 Type coverage

| Type | Live/definition | Tier 1 source | Tier 2 record |
|---|---|---|---|
| `player` | live (one) | `ModSerialize` composition of public getters + `Account`, `CargoHold`, `ConditionsStore`, `BookEntry`, `Depreciation` saves; `PlayerInfo::Save` for a full-depth `DESCRIBE` | `PlayerState`, `PLAYER_CARGO`, `CONDITIONS_GET` |
| `ship` | live | `Ship::Save` | `ShipState`, `FleetShip` |
| `mission` | live | `Mission::Save` | — |
| `npc` | live | `NPC::Save` | — |
| `system` | definition (events applied) | `ModSerialize` (`System.h` getters) | `SystemInfo` |
| `planet` | definition | `ModSerialize` (`Planet.h`) | `PlanetInfo` |
| `government` | definition + live reputation | `ModSerialize` (`Government.h`) + `reputation` from `Politics` | `GovernmentInfo`, attitudes |
| `fleet` | definition | `ModSerialize` (government, `Fleet::Strength()`; variants are private upstream, adoption A5) | `FleetInfo` |
| `outfit` | definition | `ModSerialize` + `ATTRS` (attribute iteration, `Outfit.h:118-121`) | `OutfitInfo`, `SHIP_OUTFITS` |
| `ship_model` | definition | `Ship::Save` on the stock model | `ModelInfo` (computed cost) |
| `galaxy`, `wormhole`, `hazard`, `minable`, `commodity`, `outfitter`, `shipyard`, `news`, `phrase`, `person`, `effect` | definition | `ModSerialize` | — |
| `event` | definition and scheduled | `GameEvent::Save` | — |
| `conversation` | definition | `Conversation::Save` | — |
| `start`, `gamerules` | definition | `CoreStartData::Save`, `Gamerules::Save` | — |
| `market` | live per system | `ModSerialize` (`System::Trade`, `System.h:171`; commodities from `GameData::Commodities()`, `GameData.h:167`) | `MARKET` |
| `plugin` | session | `PluginManager` | `PLUGINS` |

### 5.4 Tier 1 contexts and identity

- Tier 1 reads are allowed in every context, including init for definitions.
- Live `ship` handles of ships in the system exist only in flight. The player's own ships exist everywhere.
- Trees reflect the engine's state at the moment of the call. With the core's direct writes, a mod sees its own and earlier mods' writes. With the queued-writes layer, it sees the same overlay as records (section 6.8).

### 5.5 Stability of paths

Paths follow the game's data format, so an upstream rename (say `"outfit space"`) changes a path. Mitigations:
1. **Stable paths.** `source/modding/stable_paths.txt` lists the paths the package commits to, per type, for example `ship: name, uuid, attributes/<attr>, outfits/<outfit>, cargo/commodities/<name>`. `STABLE_PATHS` returns them, and the conformance tests check them.
2. **Aliases.** When upstream renames a key, the package adds an alias (`old → new`). Lookups through an alias still work, with a once-per-session log line.
3. **Tier 2** for anything a mod depends on every frame.

Unlisted paths work, but are documented as "follows upstream data format; may change".

### 5.6 Tier 2: typed records (core)

Tier 2 is deliberately small. It holds the records listed at 200–212 and 300–311: what mods read every frame, plus what is computed rather than stored in any serializer (new-ship cost, market prices, tag strength).

**Each record is a hand-written struct in the header**, with a hand-written fill function in the package (`ModRecords.cpp`).
- Each fill function takes the upstream object and fills every field from public API only. Section 18.1 gives, for every field, the upstream method that provides it.
- **Adding a field** means appending it to the struct (with `since` in a comment and the revision bumped), adding its static assertions, and adding one line to the fill function.
- A field that would need a private member is not added at L0. It is listed under adoption step A5.

Example (abridged):

```c
typedef struct EsShipState {            /* record 3, rev 1 */
	EsHeader h;
	EsHandle handle;                    /* ship */
	EsHandle model;                     /* ship_model */
	EsHandle government;                /* government */
	EsStr    name;
	EsStr    uuid;                      /* "" for ships not the player's */
	EsStr    tag;                       /* the tag a mod spawned it with, or "" */
	double   x, y, vx, vy, facing;      /* new in 11 */
	double   hull, max_hull, shields, max_shields;
	double   energy, max_energy, fuel, max_fuel;
	double   strength;                  /* Ship::Cost() */
	uint32_t index;                     /* index in this point's SHIPS_IN_SYSTEM order */
	uint8_t  is_player, is_flagship, is_disabled, is_parked;
} EsShipState;                          /* 176 bytes */
```

**Choices about what goes in a record.**

1. **Size versus frequency.** A record is 100–300 bytes, and filling one costs a few hundred nanoseconds, so making records "complete" is cheap. The per-object traversal cost (pointer chasing in `Ship`) dominates over byte count. So records carry every field that is O(1) to compute, and nothing that needs a scan.
2. **Nested data.**
   - Small, bounded handle lists that are almost always wanted with the record are **inline spans into the arena**. Examples: `SystemInfo.links`, `.planets`, `.fleets`; `ModelInfo.licenses`. (`SystemInfo.defense_fleets` stays empty until adoption A5, because planets' defense fleets are private upstream.)
   - Unbounded or expensive nested data gets its own list op in the core (`SHIP_OUTFITS`, `ATTRS`, `GOVERNMENT_ATTITUDES`). Everything else is read through Tier 1 once that layer exists (`GET(ship, "cargo")`, `LIST(mission)`).
   - Rule: if building the nested data costs more than the rest of the record, it gets its own op.
3. **Strings** are `EsStr` pointing into the same arena block as the record, so they share its lifetime.
4. **String-keyed maps** (outfit attributes, conditions) use a separate query.
   - `ATTRS(handle)` (core) returns `{name, value, text}[]`.
   - `CONDITIONS_GET` takes a batch of names.
   - `OutfitInfo` carries the fixed fields: name, category, cost, mass, outfit space, weapon, ammo. Every other attribute is read through `ATTRS`.
   - `FleetInfo.strength` comes from `Fleet::Strength()` (L0). The averaged stats (`ships`, `hull`, `shields`, `dps`, `speed`) need the fleet's variants, which are private upstream. They read 0, with `ES_FLEET_STATS_UNAVAILABLE` set in `flags`, until adoption A5.
5. **Versioning.** Fields are appended with a new `since` and the record's `rev` is bumped. Old callers keep reading their prefix by `stride`.

### 5.7 Later: caching (optional layer)

**The core caches nothing.** Every read marshals fresh into the calling mod's per-hook scratch arena (section 3.4). The ABI already promises only what a cache needs, so one can be added later without any ABI change:

- **Lifetime.** Returned data is valid only until the current hook returns, never longer. A cache can therefore hand out shared pointers whose real lifetime is a whole dispatch point or session.
- **Stable ordering.** Lists are in a defined order:
  - ships in engine order;
  - the fleet in fleet order;
  - definitions in true-name order.

  A cached array is then identical to a fresh one.
- **Handles** carry generations, so a cached handle can never alias a newer object.

**Sketch of the layer.**
- Collections are marshalled on first request and kept per dispatch point (live data) or per session (definitions).
- Invalidation:
  - live data at the end of each point;
  - definitions when a world change is observed (new day, landing, take-off, pilot change, an applied `APPLY_EVENT`);
  - any collection a write touched, immediately.
- The cache lives in an arena of 64 KiB chunks, with stable addresses until invalidation. Bounds: 16 MiB per point and 32 MiB per session, with least-recently-used eviction between points.
- Full records are cached, with no field masks: masks would multiply cache keys and marshalling paths for little gain.
- With queued writes, each mod reads the shared cache except where its own pending writes apply, in which case it gets a private patched copy (section 6.8).
- `CACHE_STATS` (79) reports builds, hits, misses and bytes per collection.

---

## 6. Writes

**Reads cover everything; writes are deliberate.** The only ways to change state are:
- `SET`/`ADD`/`APPEND`/`REMOVE` on properties the property table explicitly marks writable, each with a validator;
- the typed actions.

**There is no `SET(handle, path)` over Tier 1 trees**, for four reasons:
1. **Engine invariants.** Changing a field behind the engine's back skips the work its setters do. For example, an outfit count changed without `Ship::AddOutfit` leaves attributes, mass, capacities and the cargo hold inconsistent. Changing a planet's government skips the politics and the AI.
2. **Saves.** Trees are serializer output. Writing them back would mean round-tripping through `Load`, which for definitions is the event system (`APPLY_EVENT` already exposes that, deliberately and saved with the pilot), and for live objects is not designed for partial input.
3. **Validation and ordering.** Validators (and, in later layers, merge rules and cache invalidation) are per property. An arbitrary path has none of them.
4. **Stability.** A write API pinned to data-format paths would break mods on every upstream rename, with corrupting rather than failing consequences.

New writable state is added by one property: an id in the header, an entry in the `ModIds` table, a validator, and an apply function that calls the upstream mutator (section 6.3).

### 6.1 Core: direct writes

**In the core, a write op is applied immediately, when it is called, inside the calling mod's hook bracket.** There is no journal, command buffer, commit point, merge, read-your-own-writes overlay or rollback.

**Semantics.**
- **Order is call order.** Hooks run in resolved mod order (section 7.3), and within a hook, in the order the mod calls them.
- **Visibility.** A mod sees its own writes, and every earlier mod's writes, immediately, in every later read.
- **Last write wins.** Two mods setting the same property leave the later one's value.
- **Validation.** Each op validates at call time (shape, context, handle, argument ranges, and state checks such as affordability) and returns its final status. A refused write changes nothing.

**Out structs are already shaped for later layers.** Every write and action returns:

```c
typedef struct EsWriteOut {
	EsHeader h;
	int32_t  status;    /* ES_OK, ES_REJECTED, ...; ES_PENDING only where 6.1 says so */
	uint32_t _pad;
	EsHandle result;    /* an action's product (ship, ...), or 0 */
	EsHandle pending;   /* a pending handle when status == ES_PENDING, else 0 */
} EsWriteOut;
```

Callers written against the core must accept `ES_PENDING`. That way, the queued-writes layer (6.4–6.8) can make every write pending without an ABI change.

**Consequences, stated honestly.**
- **Mod order affects results.** A mod later in the order sees, and can override, an earlier mod's writes in the same frame.
- **No rollback.** If a mod's hook throws, or its host stops it, the writes it already made stay made.
- **Immediate effect on the engine.** A write takes effect for the engine at once. Upstream mutators keep the engine consistent, but a mod sees its effects (for example, reduced credits) for the rest of the frame.

**Engine-safety rules.** A short list of ops are unsafe as direct writes at some moments. The core guards them by context, or by deferring that one action to a safe point. This is an engine-safety rule, not a buffer.

| Op | Hazard | Guard |
|---|---|---|
| `PARK_SHIP`, `REMOVE_SHIP`, `BUY_SHIP`, `GIVE_OUTFIT` | Changing the fleet or a ship's outfits while the engine flies it | Refused (`ES_REFUSED_CONTEXT`) outside landed contexts (L, U while landed) |
| `SPAWN_FLEET` | Needs the engine's `newShips` list, which exists only inside `Engine::Step` | Allowed only in flight hooks run from `ModApi::EngineFrame`; refused elsewhere |
| `APPLY_EVENT` | `PlayerInfo::AddChanges` changes systems and planets the engine is drawing and steering through | Called from a flight hook, it is **deferred to the end of the same frame's `ModApi::PanelFrame`**, where upstream itself applies changes (as `PlayerInfo::Land` does from `MainPanel::Step`, `MainPanel.cpp:105`). It returns `ES_PENDING`, resolved that frame. In paused or landed contexts it applies at once |
| Any write in `HOOK_QUERY` (adopted) | Called while a vanilla panel draws | Refused |

### 6.2 Dispatch points

A **dispatch point** is one round of running a hook across all mods that implement it. Each point is driven from one of the two integration calls (section 16). In the core, writes inside a point are direct. The "Commit" column applies only to the queued-writes layer.

| Point | Driven from | Commit |
|---|---|---|
| Start (`HOOK_START` for every mod) | The first frame call, whichever comes first (section 16.4) | After all `HOOK_START` hooks, before the first bus drain |
| Pilot loaded | Whichever frame call first observes a new pilot (section 11.3) | After all `HOOK_PILOT_LOADED` hooks |
| Day, enter, step (flight) | `ModApi::EngineFrame` inside `Engine::Step` | **One commit per hook kind**: after each day's round, after enter, after step. Spawned ships go into the engine's `newShips` during the commit, while `Engine::Step` still holds it |
| Day, enter (paused or landed) | `ModApi::PanelFrame` | After each round |
| UI hook (a mod-owned panel's button, row, header, dialog answer, setting) | `ModApi::PanelFrame`, or the package panel's own event handler | After the hook, then the drain |
| Query hook | Adopted (A7) | No commit: writes refused |
| Bus drain round | End of each frame call that ran hooks | After each round (at most 4 rounds) |
| Events delivery | Start of each `EngineFrame` and `PanelFrame` that has events | After the round |
| Save | Adopted (A2): inside the engine's save path, before the pilot is written | Before the engine writes the pilot |

### 6.3 Writable properties and their upstream mechanism

| Property | Merge (queued layer) | Contexts | Lvl: upstream mechanism |
|---|---|---|---|
| `player.condition[name]` | set, add | any but Q | L0: `ConditionsStore::Set`/`Add` via `PlayerInfo::Conditions()` (`PlayerInfo.h:307`; `ConditionsStore.h:62-65`) |
| `player.credits` | add (commit rejects going below 0) | L U | L0: `Account::AddCredits` via `PlayerInfo::Accounts()` (`PlayerInfo.h:163`; `Account.h:42`) |
| `government.reputation` | set, add | any but Q | L0: `Politics::SetReputation`/`AddReputation` via `GameData::GetPolitics()` (`Politics.h:69-70`; `GameData.h:164`) |
| `ship.name` (player's ships) | set | L U | L0: `PlayerInfo::RenameShip` (`PlayerInfo.h:198`) |
| `player.travel_destination` | set | F L | L0: `PlayerInfo::SetTravelDestination` (`PlayerInfo.h:348`) |
| `mod.data[key]` | set (self only) | any but Q | L0: the package's sidecar (section 11) |
| `mod.setting[id]` | set (self only) | any but Q | L0: the package's settings file (section 10) |
| `game.messages` | append | F L U E | L0: `Messages::Add` (`Messages.h:53`) |
| `ship.hull`, `ship.shields` | set, add (clamped to [0, max]) | F | **Ad. [A4]**: no public setter upstream (`Ship.h` exposes only `Restore`/`Recharge`) |
| `planet.ship_stock[model]`, `planet.outfit_stock[outfit]`, `planet.ship_order_note[model]` | set, add | any but Q | **Ad. [A13]**: shop stock is an engine gameplay feature that would need adopting |

### Optional layer: queued writes

This layer replaces direct writes with journals committed once per dispatch point, for mods that register with `write_mode = ES_WRITE_QUEUED`. It gives deterministic results independent of mod order (except for documented `set` conflicts), rollback when a mod throws, and a consistent snapshot for every mod within a point. It reuses the core's op shapes and statuses: writes return `ES_PENDING`, and outcomes arrive through `PENDING_STATUS` and `HOOK_COMMIT_RESULTS`.

### 6.4 Journals

- Each mod has one journal per point.
- An entry is `{seq, op, property/action id, handle, key, value or args, merge mode}`: 48 bytes fixed, plus variable payload in the journal arena.
- **Call-time validation** happens before an entry is recorded:
  - struct shape and size;
  - context (`ES_REFUSED_CONTEXT`);
  - handle validity;
  - argument ranges and enum values;
  - name syntax (bus names).

  Failures return immediately and record nothing.
- **Rollback.** If a mod's hook throws, or the watchdog stops it (the mod providing its dispatch returns `ES_STOPPED`, or withdraws it), that mod's journal for the point is discarded. Its earlier points are unaffected.

### 6.5 Merge semantics (per property or action, declared in the property and op tables)

| Merge | Rule | Examples |
|---|---|---|
| `set` | Last writer in **resolved mod order** wins. When two mods write different values to the same `(handle, property, key)`, the conflict is logged at most once a minute per property, and losers receive `ES_CONFLICT` in their commit results | `player.condition[name]`, `government.reputation`, `mod.data[key]` (self only, so it never conflicts) |
| `add` | All deltas are summed, then applied once and clamped by the property's rule | `player.credits`, `government.reputation` (ADD), `player.condition[name]` (ADD) |
| `append` | Concatenated in mod order, then journal order | `game.messages`, bus `NOTIFY`, log lines |
| `exclusive` | One winner per point and slot. The mod that owns the player-started UI hook wins; otherwise the first in resolved order wins. Others get `ES_CONFLICT` | Opening a modal: `mod.screen`, `dialog` |
| `produce` | Actions. Applied in order, each validated against the state left by the previous ones; returns a pending handle | `BUY_SHIP`, `SPAWN_FLEET`, `OFFER_JOB` |

A property may allow both `set` and `add` (`player.condition[name]`). If one point carries both on the same key, the last `set` in resolved order fixes the base, and the `add` deltas from mods ordered after it are applied on top.

### 6.6 Commit algorithm

1. **Fold.** Group state writes by `(handle, property, key)` and apply the merge rules. The result is one value per key.
2. **Apply state writes**, in property-id order, so the result never depends on hash order.
3. **Run actions** in resolved mod order, then journal order. Each one is **validated at commit time** against current state (affordability, licences, landed, ship carries mission cargo, …). Its pending handle resolves to `ES_OK` plus a result handle, or to `ES_REJECTED`/`ES_CONFLICT`.
4. **Apply appends**: messages, then bus posts into `ModBus` in mod order. The bus drains after this commit.
5. **UI:** resolve `exclusive` slots, then apply `UI_SHOW`/`UPDATE`/`CLOSE` to the panel state.
6. **Invalidate** point caches and epochs for the types touched. Queue `HOOK_COMMIT_RESULTS` for each mod that has non-trivial outcomes.

**Determinism.** Given the same inputs and the same resolved mod order, the commits are identical. The resolved order comes from the dependency sort with name tie-breaks (section 6.3), not from library or file-system order.

### 6.7 Immediate ops

These are marked immediate in the `ModOps` table and never journalled:
- discovery and the registry;
- `LOG`, `TIMING_SECTION`, `CONTEXT`, `PENDING_STATUS`, `JOURNAL_STATUS`, `CACHE_STATS`;
- subscription state (`SUBSCRIBE`, `LISTEN`, `UNLISTEN`);
- declarations at load (`SETTING_DECLARE`, `KEY_DECLARE`).

**None of them changes the world.**

### 6.8 Commit results, pending handles and the overlay

- A pending handle has type `pending`. `PENDING_STATUS` answers `ES_PENDING` until the commit has run, then returns the final status, the result handle, and an optional result record (e.g. `SpawnResult {count, ships span}`).
- After a commit, each mod with pending or failed entries gets `HOOK_COMMIT_RESULTS` at the start of its next hook point. Its in-struct carries `EsCommitResult[] {seq, op, id, pending, status}`.
- Outcomes it carries: every pending action, every `ES_CONFLICT`, and every commit-time `ES_REJECTED`.
- Successful `set`/`add`/`append` writes are not reported, which keeps the batch small.

**Read-your-own-writes overlay.**
- Each mod has a dirty set: the property ids and types it has journalled in this point.
- A read whose collection is not dirty returns the shared data. Otherwise it gets a private copy with the mod's own pending `set` values and summed `add` deltas applied.
- Other mods' pending writes are never visible.

---

## 7. Registration, descriptors, ordering and identity

### 7.1 Who registers

**There are two ways to register, and both produce identical registry entries.**

1. **Statically, from data.** Every `mod` node in an enabled plugin's data creates a registry entry and an address before any code runs (section 7.6).
   - This applies to native library mods. It also applies to script mods that choose to declare themselves, with `host "dado"`.
   - A native library then confirms its entry by filling `EsModReg` in `es_mod_init` (section 3.6). The confirmation must match the data node.
2. **Dynamically, at run time.** Any mod may register further mods by calling `REGISTER_MOD` while handling its own `HOOK_DISCOVER`. For a mod that already has a data node, this registration only confirms the static entry.
   - The registering mod supplies the new mod's dispatch, or null, meaning its own dispatch.
   - The game knows who is calling from the open bracket. The registering mod is recorded as `registered_by`, so a mod cannot be registered "by" someone else.

`registered_by` is **metadata**. It is used for diagnostics, for the ordering hint in 7.3, for `ES_WITHDRAW_GROUP`, and for one capability that follows from providing a dispatch: you may withdraw a mod whose hooks you dispatch (section 7.4).
- **No different rules otherwise.** A registered mod has its own address, descriptors, dependencies, hooks, bracket and limits.
- **Registrants can be registered too.** A registered mod may itself declare `HOOK_DISCOVER` and register more mods.

**Examples.**
- **The Dado runtime** (es-modloader) is a library mod named `dado`, declared by its plugin `Dado` (Appendix B). It declares `HOOK_DISCOVER`, scans `<plugin>/scripts/*.js` there, and registers each script mod with `dispatch = null`. All of their hooks then reach its own dispatch, carrying the script mod's address.
- **Compiled mods** need no host. Each is a library declared by its own plugin's `mod` node, so the game opens it directly.

### 7.2 Registration structs

```c
typedef struct EsFieldDesc {        /* one field of a struct layout (checked by EsLayout, section 13.3) */
	EsStr    name;
	uint16_t type;                  /* ES_FT_U8..I64, F32, F64, BOOL, STR, SPAN, HANDLE, BUF, STRUCT, PAD */
	uint16_t flags;                 /* ES_FF_ARRAY (fixed inline count), ES_FF_DEPRECATED */
	uint32_t offset, size;
	uint32_t count;                 /* inline array length, 1 otherwise */
	uint32_t ref;                   /* record id (SPAN/STRUCT), handle type (HANDLE), 0 otherwise */
	uint32_t since;                 /* struct revision that added the field */
} EsFieldDesc;                      /* 40 bytes */

typedef struct EsStructDesc {
	EsHeader h;
	EsStr    name;
	uint32_t size, min_size;        /* current size; size at first publication */
	uint32_t revision, field_count;
	ES_PTR(const EsFieldDesc) fields;
	uint32_t game_record;           /* nonzero: "this is game record N"; fields may then be omitted */
	uint32_t _pad;
} EsStructDesc;

typedef struct EsOpDesc {
	EsHeader h;
	uint32_t code;                  /* a specified op this mod implements (a hook, PING, INTROSPECT, a Tier 1 read), or an unspecified op >= 1000 */
	uint32_t flags;                 /* ES_OPF_HOOK, ES_OPF_READONLY, ES_OPF_ASYNC_ONLY, ES_OPF_IDEMPOTENT */
	EsStr    name;                  /* "diplomacy.war_state"; specified ops use their header name, e.g. "HOOK_STEP" */
	uint32_t version, since_api;
	ES_PTR(const EsStructDesc) in;  /* null for specified ops: the header defines their layout */
	ES_PTR(const EsStructDesc) out;
	uint32_t merge;                 /* for unspecified ops that write the callee's state: ES_MERGE_* (informational) */
	uint32_t budget_ms;             /* routed-call budget the callee asks for; capped by the game */
	EsStr    doc;
} EsOpDesc;

typedef struct EsDep { EsStr name; EsStr version_range; uint32_t kind; uint32_t _pad; } EsDep;
/* kind: ES_DEP_NEEDS ("I need this": ordering + information, never enforced), ES_DEP_OPTIONAL,
 * ES_DEP_AFTER, ES_DEP_BEFORE, ES_DEP_CONFLICTS. version_range: "" or e.g. ">=0.2 <1" */

typedef struct EsDepResult {        /* one per declared dependency, delivered in HOOK_START */
	EsStr    name;
	uint32_t outcome;               /* ES_DEP_PRESENT, MISSING, VERSION_MISMATCH, CONFLICT_PRESENT, CYCLE_BROKEN, WITHDRAWN */
	uint32_t address;               /* when present */
	EsStr    version;               /* the dependency's version, when present */
} EsDepResult;

typedef struct EsHookStartIn { EsHeader h; uint32_t order; uint32_t dep_count; ES_PTR(const EsDepResult) deps; } EsHookStartIn;

typedef struct EsModReg {           /* in-struct of REGISTER_MOD (op 60) */
	EsHeader h;
	EsStr    name;                  /* unique mod name, 1..64 bytes, [A-Za-z0-9 _.-] */
	EsStr    plugin;                /* the plugin it came from ("" for resources or a native folder) */
	EsStr    version;               /* the mod's own semver */
	uint32_t api_level;             /* the mod API the mod was built for (its min_api) */
	uint32_t write_mode;            /* ES_WRITE_DIRECT (0, the core) or ES_WRITE_QUEUED (1, needs that layer; falls back to direct, as CONTEXT reports) */
	uint32_t trust;                 /* ES_TRUST_SCRIPT, ES_TRUST_NATIVE (section 14) */
	uint32_t op_count;
	ES_PTR(const EsOpDesc) ops;     /* the specified ops it implements (hooks included), plus its unspecified ops */
	uint32_t dep_count, _pad;
	ES_PTR(const EsDep) deps;
	EsCallFn dispatch;              /* null: the registering mod's dispatch (ignored in es_mod_init: required there) */
	uint32_t header_revision;       /* ES_HEADER_REVISION the mod was built against */
	uint32_t _pad1;
} EsModReg;

typedef struct EsModRegOut { EsHeader h; uint32_t address; int32_t status; EsStr message; } EsModRegOut;
```

The game copies every descriptor it accepts; the caller's memory need only live for the call. `REGISTRY_LIST` entries add `{address, name, plugin, version, origin (library path or file), registered_by, order, state, trust, op count, header_revision}`.

**Hook presence comes from the descriptors.**
- The game dispatches a hook to a mod **only if the mod registered that hook op**. This replaces the Dado runtime's per-hook probing (`esmod_has`, `loader.c:396-416`) and the game's blind calls to every loader.
- A script mod's descriptors are produced by the mod that registers it (Dado: from the methods the class defines). The probe Dado runs today moves to registration time.
- A native mod writes them by hand, or has its own build tooling produce them from its `mod.txt`.

**Validation at registration.** A bad registration returns `ES_BAD_ARG` with `message` set, and the game logs it. Checks:
- the name is well-formed and unique (7.4);
- a code below 1000 must be a specified op whose `implementors` include mods; unassigned codes, and game-only ops (registry, writes, actions, UI, …), are refused;
- **a specified op must use the specified layout and semantics.** Its `in`/`out` descriptors must be null (meaning "as specified") or have sizes equal to the game's own (the `ModOps` table); its name must be the header name; its flags must match (e.g. `ES_OPF_READONLY` for Tier 1 reads);
- unspecified codes must be at least 1000 and unique within the mod, and their names must be prefixed with the mod's name;
- layouts are well-formed: fields lie inside `size`, are naturally aligned and do not overlap; `min_size ≤ size`; a `STR`, `SPAN` or `HANDLE` field has its exact size; `game_record` ids exist;
- `EsDep` names are syntactically valid;
- at most 256 ops and 64 dependencies per mod.

### 7.3 Startup sequence: data, static sort, libraries, discovery, full sort, start

```
FIRST FRAME CALL (ModApi::EngineFrame or PanelFrame, section 16.4; GameData loaded, a pilot exists)
  ModDescriptors: for each enabled plugin in GameData::Sources(): read <plugin>/mod.txt
                  (L0; or data/*.txt "mod" nodes once adoption A1 forwards them)
  ModDescriptors: resolve paths per plugin, validate, compute struct layouts
REGISTRY FROM DATA
  game: a static registry entry + address for every mod node, in plugin load order
  game: STATIC SORT (Kahn) over the static entries -> library load order
  game: unless the kill switch is on (section 14)
LIBRARIES, in static order, for each native mod with a build for this platform:
  game: copy library to <config>/native-cache/<sha256>/; verify hash; open the copy
  game: es_mod_init(boot, &reg)  -> must match the data node (7.6), else FAILED
REGISTRATION PHASE (context R), in rounds (at most 4):
  game: HOOK_DISCOVER {sources} to each registered mod that declared it, in static order
    m: REGISTER_MOD for each script mod: confirms a declared one (same address),
       or creates a dynamic entry (new address), registered_by = m
game: seal the registry
game: FULL SORT over static + dynamic entries; log it; EsDepResult[] for every mod
game: HOOK_START {order, deps} in full order; drain the bus
game: HOOK_PILOT_LOADED in full order; drain the bus
```

**There are two sorts.**
- The **static sort** uses only data, and decides the order in which libraries are opened and `HOOK_DISCOVER` runs. It is what lets a loader-mod's `needs` ordering hold before any code runs.
- The **full sort** adds dynamically registered mods and decides everything from `HOOK_START` on.
- Both use the same rules, and a static entry keeps the same relative order in both, because dynamic entries only add nodes and edges.

- **Registrants come first.** A registering mod's `HOOK_DISCOVER` always runs before any of its sub-mods' hooks, because the registration phase precedes the full sort.
- **The sort adds a soft edge** from each registrant to every mod it registered, so the registrant's `HOOK_START` comes before theirs. This edge has the lowest priority and is the first dropped in a cycle (7.3, cycles). That lets a runtime mod initialise its engine before its scripts' `on_load`.
- **Script top-level code** runs in the registration phase, under the hosting mod's own watchdog. It can call only ops that change no game state, because no world exists for mods until `HOOK_START`.

**Late registration (hot reload) is not allowed in API 11.** It is listed as an open question.

**Dependency sources and how they combine.**
1. **Plugin-level** `dependencies` in `plugin.txt` (`Plugin.h:27-42`: `required`, `optional`, `conflicted`). These are lifted onto every mod in that plugin, pointing at every mod in the named plugin.
2. **Mod-level** `EsDep`: `needs` (renamed from "requires" to make clear it is not enforced), `optional`, `after`, `before`, `conflicts`, by mod name, with an optional version range.

The union of both is used for **ordering and information only**. The game's own `plugin.txt` checks (vanilla `PluginDependencies`, upstream behaviour for data plugins) are unchanged and separate. **The mod API adds no refusals on top of them.** A mod-level `before` that contradicts a plugin-level `required` edge is a cycle, handled as below.

**Graph.** `needs(B)` and `optional(B)` (when B is present) and `after(B)` all add an edge B → A. `before(B)` adds A → B.

**Sort.**
- Kahn's algorithm, with the ready set kept as a min-heap by mod name (byte order).
- The result is deterministic, independent of library and file-system order, and equals today's name order when there are no edges except registrant edges.

**Best-effort rules.**
- **Cycle.** When Kahn stalls with nodes left, the game finds the strongly connected components (Tarjan) and, in each one, drops one edge deterministically:
  - prefer the implicit registrant edge, then an `after`/`before` edge, over an `optional` edge, and an `optional` edge over a `needs` edge;
  - among equals, drop the edge whose target is alphabetically last.

  It logs `Mod order: cycle diplomacy -> corporations -> diplomacy; ignored "corporations after diplomacy"` and resumes.
- **No mod is ever refused over dependencies**, whether for a missing `needs`, a version mismatch, a conflict or a cycle. Every registered mod is ordered and started.
  - Unmet dependencies are logged as `INFO`, or as `WARNING` for `needs` and `conflicts`, never as errors. Example: `Mod "x" needs "y" (not installed); starting it anyway, it was told.`
  - A missing node simply contributes no edges.
- **Each mod is told the outcome.** `HOOK_START` carries an `EsDepResult` for every declared dependency, and `DEP_STATUS` returns the same list at any time. The outcomes are `PRESENT` (with address and version), `MISSING`, `VERSION_MISMATCH`, `CONFLICT_PRESENT`, `CYCLE_BROKEN` and `WITHDRAWN`.
- **The mod decides** whether to disable itself, run with reduced features, or carry on.
- **Withdrawing.** `WITHDRAW` is immediate and acts on the caller only:
  - its subscriptions, listens, UI slots and map layers are dropped;
  - the game dispatches it no more hooks;
  - its address answers `ES_TARGET_GONE`, and its registry state becomes `WITHDRAWN`.

  Mods whose `HOOK_START` has not yet run see the dependency as `WITHDRAWN`. Those that already started receive a `mod_withdrawn` event if they subscribed to it. If the withdrawn mod was registered by another mod, the registrant receives `HOOK_COMMIT_RESULTS` with a `withdrawn` entry for it, so it can free that mod's engine.
- **Visibility.** The resolved order is logged once at startup. `REGISTRY_LIST` returns entries in resolved order, each with its `order` index, state and flags.

**The resolved order is used for:**
- hook dispatch;
- the order of direct writes between mods, and in the queued layer, `set` conflict resolution and action order at commit;
- notification delivery (replacing "the order of the mods' names", `ModBus.h:67-73`);
- `HOOK_START` order.

### 7.4 Uniqueness, stability, failure

- **Name clashes.** The first registration of a name wins. Static entries come first (plugin load order, then file and line); then dynamic registrations in registration order. A second `mod` node with the same name is reported at data load and ignored. This matches today's "first loader wins" (`ModLoaders.h:87-91`). A later registration of the same name gets `ES_CONFLICT`. A registrant's own override rule (Dado: a later plugin source replaces a mod) applies before it registers.
- **Stable addresses.** An address is stable for the session, never reused and never saved.
- **Failure.** A mod that fails to load, is stopped by a watchdog, or withdraws keeps its registry entry, now in state `FAILED`, `STOPPED` or `WITHDRAWN`. Any `es_call` addressed to it returns **`ES_TARGET_GONE`**, as does a pending routed call to it. Its subscriptions and listens are dropped. Writes it already made stay made (in the core, writes are direct).
- **Reporting failure.** The mod that provides a dispatch reports a stop by returning `ES_STOPPED` (`-17`) from that hook's dispatch, which marks the mod `STOPPED`. It can also call `WITHDRAW {address, reason}` (state `FAILED`), for example for a script that failed after registration. Any mod may report this way for mods whose dispatch it provides, and only for those.
- **Grouped withdrawal.** `WITHDRAW` with `ES_WITHDRAW_GROUP` takes the target and, transitively, everything registered by it. A library mod that withdraws takes its script mods with it.

### 7.5 Identity

- **The game opens every bracket itself**, for every mod, whoever registered it. It records the mod's address, calls that mod's dispatch with the address, and closes the bracket. Every mod-scoped op made meanwhile acts for that address.
- **A registrant cannot act as its sub-mods.**
  - Inside the sub-mod's bracket, the code that runs is the sub-mod's (dispatched by the registrant), and it acts as the sub-mod.
  - Outside that bracket, nothing can act as the sub-mod.
  - The registrant can only dispatch to a sub-mod when the game hands it that sub-mod's hook. It cannot open brackets, and the v2 ABI has no bracket ops.
- **The `address` argument of a hook call is the game's choice**, never the dispatcher's.
- **`es_mod_init` runs as the library's own mod.** The game holds a bracket for the library's address during the call.
- **The bus sender** is the bracketed address, with its name attached by the game.

### 7.6 Static descriptors: the `mod` data node

**Where the node lives.**
- **At L0, in `<plugin>/mod.txt`**, a DataNode-syntax file at the plugin's root that the package reads itself. Upstream's data loader reads only `.txt` files under the plugin's data folders (`UniverseObjects::LoadFile`, `UniverseObjects.cpp:367-372`), so this file is never seen by the engine, and causes no "Skipping unrecognized root object" warning (`UniverseObjects.cpp:737`).
- **With adoption A1**, the same `mod` nodes may also appear in `data/*.txt`. The engine then forwards them to the package instead of warning.

The node format is the same in both places. Example: the Dado plugin's `plugins/Dado/mod.txt`:

```
mod "dado"
	version "0.3.0"
	api 11
	"display name" "Dado script runtime"
	description "Runs JavaScript and DadoScript mods from each plugin's scripts/ folder."
	library "macos" "lib/macos/libesdado.dylib"
		sha256 "9f2c...e1"
	library "linux-x86_64" "lib/linux-x86_64/libesdado.so"
	library "linux-arm64" "lib/linux-arm64/libesdado.so"
	library "windows-x86_64" "lib/windows-x86_64/esdado.dll"
	hooks discover start shutdown
	registers "scripts/*.js"
	setting "hook ms"
		type int
		default 250
		range 50 2000
		label "Script time limit per hook (ms)"
```

A plugin that ships a compiled mod with an unspecified op, `plugins/Traffic Control/mod.txt`:

```
mod "traffic control"
	version "1.2.0"
	api 11
	library "macos" "bin/libtraffic.dylib"
	library "linux-x86_64" "bin/libtraffic.so"
	library "windows-x86_64" "bin/traffic.dll"
	hooks start step enter save pilot_loaded
	needs "dado" ">=0.3"
	optional "diplomacy"
	after "corporations"
	conflicts "old traffic"
	op 1000 "traffic control.lane_load"
		version 1
		in "LaneLoadIn"
		out "LaneLoadOut"
		budget 5
		doc "Ships per hour on a hyperspace link."
	struct "LaneLoadIn"
		field "from" handle system
		field "to" handle system
	struct "LaneLoadOut"
		field "ships_per_hour" f64
		field "pirate_share" f64
```

A script mod may declare itself statically too, so that others can order against it and bind its ops before any code runs. `plugins/Diplomacy/mod.txt`:

```
mod "diplomacy"
	version "0.2.0"
	api 11
	host "dado"
	script "scripts/diplomacy.js"
	hooks start day enter step planet_button ui notification save pilot_loaded
	optional "corporations"
	op 1000 "diplomacy.war_state"
		in "WarStateIn"
		out "WarStateOut"
	struct "WarStateIn"
		field "government" handle government
	struct "WarStateOut"
		field "at_war" bool
		field "since_day" i32
```

**Grammar.** Children of `mod "<name>"`:

| Key | Meaning |
|---|---|
| `version`, `api` | The mod's version; the oldest mod API it needs |
| `"display name"`, `description` | Shown on the Mods screen |
| `library "<platform>" "<path>"` | One per platform. Platforms: `macos` (universal), `macos-arm64`, `macos-x86_64`, `linux-x86_64`, `linux-arm64`, `windows-x86_64`; the most specific match wins. An optional child `sha256` pins the file |
| `host "<mod>"` + `script "<path>"` | A mod run by another mod (no library). `host` is an implicit `needs` |
| `hooks <names...>` | The hook ops it implements (header names, lower case, without `HOOK_`). If present, this set is authoritative |
| `implements <ops...>` | Other specified ops it answers on its own address, e.g. `implements DESCRIBE GET LIST INTROSPECT`; or `publishes`, meaning it serves Tier 1 reads from `PUBLISH` snapshots |
| `registers "<glob>"` | Informational: the mod registers further mods at run time (shown on the Mods screen) |
| `needs`, `optional`, `after`, `before`, `conflicts` `"<mod>"` [`"<range>"`] | Dependencies (section 7.3) |
| `op <code> "<name>"` with `in`, `out`, `version`, `merge`, `budget`, `doc` | Unspecified ops, code ≥ 1000 |
| `struct "<name>"` with `field "<name>" <type> [<ref>]` | Layouts; types as in the layout helper (section 13.3) |
| `setting "<id>"` with `type`, `default`, `range`, `choices`, `label`, `doc` | Static settings (also declarable at run time with `SETTING_DECLARE`) |
| `key "<id>"` with `default`, `label` | Static key bindings |

**Paths.**
- Paths resolve relative to the root of the plugin whose data file holds the node: the `GameData::Sources()` entry that is the file's parent.
- Absolute paths and `..` components are rejected.
- After symlink resolution, the target must still lie inside that plugin folder.
- A `mod` node in the game's own `resources/data` is rejected: native code comes from plugins.

**Static and dynamic registration, and what must match.**

| Field | Static (data) | Runtime (`es_mod_init` or `REGISTER_MOD`) must… |
|---|---|---|
| name | Authoritative | match exactly |
| version | Authoritative | match exactly |
| host / registrant | `host "x"` | come from `x`'s `REGISTER_MOD` (for script mods) |
| hooks | Authoritative if `hooks` is present | be a subset; extra hooks are ignored, with a warning |
| specified ops (`hooks`, `implements`) and unspecified ops | Authoritative if present | declare the same codes, names and versions, with identical layouts (same field names, types and offsets, compared by layout hash) |
| dependencies | Authoritative; the static sort already used them | — runtime `deps` are ignored, with a warning if they differ |
| settings and keys | Declared | may add more at `HOOK_START` |

- **A mismatch on name, version or ops** marks the entry `FAILED`. The library is closed, and dependants are told `MISSING`.
- **A mod with no data node**, such as a Dado script without one, is registered dynamically as before. It is known only after `HOOK_DISCOVER` and joins only the full sort.
- **A data node whose library or script never confirms** (native mods switched off, no build for this platform, host absent, file missing, `sha256` mismatch) stays in the registry in state `SWITCHED_OFF`, `NO_PLATFORM`, `UNCONFIRMED` or `FAILED`. Calls to it return `ES_TARGET_GONE`. Dependants see the reason in `EsDepResult.outcome`.

**Zipped plugins: supported, by extraction.**
- Every library is copied to `<config>/native-cache/<sha256>/<file>` and opened from there, never in place:
  - this closes the gap between checking an optional `sha256` pin and loading the file;
  - it lets an update of the plugin replace its file while the game runs;
  - on Windows, it keeps the plugin folder unlocked.
- For a zipped plugin, the copy is made with `Files::Read` (`Files.h:75`), which reads zip members transparently, followed by a plain write into the cache.
- The cache is pruned of hashes not used for 30 days.
- Libraries still link their own dependencies statically, as today; nothing next to them is searched.

**Where it lives in the game.**
- `source/modding/ModDescriptors.{h,cpp}` owns the collection: reading, parsing, validation, path resolution and layout computation (the shared `EsLayout`, section 13.3).
- **L0 reading.**
  - Iterate `GameData::Sources()` (`GameData.h:99`, defined at `GameData.cpp:294`), skipping index 0 (the game's resources folder: native code comes only from plugins).
  - For each source, test `Files::Exists(source / "mod.txt")` (`Files.h:55`).
  - Read it with `Files::Read` (`Files.h:75`), which also reads inside zipped plugins, and parse it with `DataFile(std::istream &)`.
  - Order: by source order, then node order. This is deterministic.
- `GameData::Sources()` holds only enabled plugins, because `GameData::LoadSources` (`GameData.cpp:922`) loads only those. So **a disabled plugin's `mod.txt` is never read**. The library opener re-checks the plugin's enabled flag through `PluginManager::Get()` (`PluginManager.h:44`) before opening anything.

---

## 8. The bus (core) and events (optional layer)

### 8.1 The bus (core)

Mods post named notifications to each other through the game:
- `NOTIFY {name, payload}` posts one;
- `LISTEN` and `UNLISTEN` set which names a mod receives (exact names, or prefixes ending in `*`);
- delivery is `HOOK_NOTIFICATION`.

**Rules.**
- **Names.** 1–128 bytes of `A-Z a-z 0-9 . _ : / -`.
- **Payload.** Opaque text of up to 64 KiB (JSON, by convention).
- **Sender.** The game sets it to the bracketed address, so it cannot be spoofed.
- **Delivery.** A post is never delivered from inside `NOTIFY`. It is queued, and the queue is drained at the end of each frame call that ran hooks (section 16), oldest first. Each notification goes to every listener except its sender, in resolved mod order.
- **Cascades.** What listeners post during a drain is delivered in the same drain, for up to 4 rounds or 1024 deliveries.
- **Limits.**
  - The queue holds at most 1024 notifications and 4 MiB.
  - A mod may post at most 256 notifications per drain, and hold at most 256 listen patterns.
  - Refusals are logged at most 20 a minute.
- **Pilot changes.** Another pilot empties the queue; listen patterns persist.
- **Write modes.** In the core's direct write mode, `NOTIFY` enqueues at call time. In the queued layer it is a journalled `append`: a mod that throws posts nothing.

### 8.2 Events (optional layer)

- `SUBSCRIBE {event ids[], filter}` is immediate. A subscription lasts until unsubscribed or the session ends, and survives pilot changes.
- Each subscriber gets one `HOOK_EVENTS` call per frame call that has events, with an `EsSpan` of records:

```c
typedef struct EsEvent { uint16_t id; uint16_t _pad; uint32_t size; int32_t step; int32_t day; /* then the event's own fields */ } EsEvent;
```

- Records are walked by `size`.
- Each subscriber has a bounded queue of 4096 events. On overflow the oldest are dropped, and an `events_overflowed {dropped}` event is queued.

**Which events Level 0 can produce.** "Observed" means detected by diffing state between frames.

| Event | Source at L0 | Reliability |
|---|---|---|
| `ship_destroyed`, `ship_disabled`, `ship_boarded`, `ship_captured`, `ship_scanned`, `ship_provoked`, `ship_assisted` | The engine's `ShipEvent`s, handed to `ModApi::EngineFrame` in `Engine::Step` (`ShipEvent.h:30-71` types; `Actor()`, `ActorGovernment()`, `Target()`, `Type()` at `ShipEvent.h:78-82`) | Exact |
| `system_entered` | Observed: `PlayerInfo::GetSystem()` changed | Exact (frame resolution) |
| `landed`, `took_off` | Observed: `PlayerInfo::GetPlanet()` changed, and/or a `PlanetPanel` appeared on `UI::Stack()` | Exact |
| `day_passed` | Observed: `PlayerInfo::GetDate()` changed by 1–7 days. A larger jump, or a backwards one, is a pilot change | Exact |
| `pilot_loaded` | Observed: section 11.3 | Exact |
| `mission_accepted`, `mission_removed` | Observed: UUID sets of `PlayerInfo::Missions()` | Exact |
| `mission_completed` versus `mission_failed` | Observed: `Mission::IsFailed()` (`Mission.h:159`) on the last frame before removal; otherwise unknown | Best effort. Exact needs adoption A12 |
| `ship_bought`, `ship_sold`, `outfit_bought`, `outfit_sold` | Observed: fleet UUID set and per-ship `Ship::Outfits()` diffs, plus credits | Best effort (cannot tell a purchase from a gift). Exact needs A12 |
| `reputation_changed` | Observed: `Politics::Reputation` per government, compared once per frame call (about 50 governments) | Exact |
| `player_died` | Observed: `PlayerInfo::IsDead()` | Exact |
| `saved` | Not observable | Needs A2 |

`STEP_LOSSES` and `KILLS` (core records) are built from the same `ShipEvent`s, so the core has losses and kill counts without the events layer.

---

## 9. Mod-to-mod calls (optional layer)

**Declaring an op space.**
- A mod declares its unspecified ops (codes ≥ 1000) and their layouts in its `mod` node (section 7.6).
- The game knows these ops before any code runs, so other mods can bind to them as soon as `HOOK_START`.
- Its registration's `EsOpDesc[]` must match the node.

**Discovery (core).**
- `REGISTRY_FIND {by: unspecified_op, name: "diplomacy.war_state"}` returns the address.
- `REGISTRY_OPS(address)` returns the descriptors: the specified ops the address implements, and its unspecified ops with their in/out layouts.
- A caller binds by name, checks `version`, and checks that the layout is compatible:
  - the callee's `min_size` must not exceed what the caller sends;
  - the fields the caller uses must have the same offset and type.

The simplest mod-to-mod channel needs no further op at all: plain `NOTIFY`/`LISTEN` with JSON payloads (core).

### 9.1 Mods answering Tier 1 reads (with the Tier 1 layer)

A mod can expose its state to the same traversal ops that read game state, through the handle type `mod` (`mod:diplomacy`). There are two ways to serve them.

1. **Published snapshot.**
   - The mod calls `PUBLISH` with an `EsNode` tree whenever its state changes; the previous snapshot is replaced.
   - The game answers other mods' `GET`, `DESCRIBE` and `LIST` on `mod:<name>` from that snapshot, synchronously and without calling the mod, so brackets never nest.
2. **Live answers.**
   - The mod declares `implements DESCRIBE GET`. The game routes a reader's `GET` to the mod's dispatch as a synchronous, read-only routed call: a 5 ms budget, writes refused, nesting depth 1. The answer is cached for the rest of the dispatch point.
   - The answer must follow the specified `GET` semantics: path syntax, node view and statuses.

**Example.** Diplomacy publishes:

```
wars
	"Republic" "Free Worlds"
		since 2207
		intensity 0.7
```

Another mod then reads `GET(mod:diplomacy, "wars/Republic=Free Worlds/intensity")` and gets `0.7`.

### 9.2 Routed unspecified ops

**Asynchronous.**
- `CALL_ASYNC {address, op, in bytes}` returns a pending handle.
- At the next bus drain, the game sends the callee `HOOK_ROUTED {caller, op, in bytes}` in the callee's own bracket.
- The callee's `out` bytes become the caller's pending result (`PENDING_STATUS`), readable at its next hook.
- Brackets never nest.

**Synchronous (`CALL_SYNC`, latest layer).**
- The game suspends the caller's bracket and opens the callee's, with a budget of `min(desc.budget_ms, 20 ms)`.
- The callee is read-only. Nesting depth is 1. A timeout returns `ES_TIMEOUT`.
- The caller's host must be able to pause its own watchdog during the call.

---

## 10. UI, settings and keys (optional layers)

**What Level 0 can show, and how.**
- **The UI handle.** The package receives the game's `UI` through the `MainPanel::Step` integration call (section 16.2). It can push its own `Panel` subclasses (`UI::Push`, `UI.h:69-70`) and upstream `DialogPanel` instances (`DialogPanel.h`).
- **Screen observation.** It can see which screen is showing through `UI::Stack()` (`UI.h:65`) and `UI::Top()` (`UI.h:82`), with a `dynamic_cast` to `PlanetPanel`, `MapPanel`, `ShopPanel` and so on. It reads them only, never changes them.
- **Pushing a panel pauses flight.** `MainPanel::Step` treats the game as active only while it is the top panel (`MainPanel.cpp:71`, `isActive = GetUI().IsTop(this)`). A package panel pushed in flight therefore pauses the game, as the map or a mission dialog does. That is acceptable for dialogs and screens, but it rules out an always-on HUD at L0.
- **No overlay on vanilla panels.** A package panel cannot add a button to a vanilla panel. It also cannot stay on the stack as a transparent overlay without breaking that panel's own "am I on top" logic. `PlanetPanel` and others check `GetUI().IsTop(this)` before offering missions or taking off.
- **How a mod's screen opens at L0:**
  1. from a hook, while the game is already paused (on landing, after an `enter` in the landed context, or on a notification), or as a modal dialog in flight;
  2. from a **condition trigger**, the L0 substitute for a planet button. A plugin's own data (a spaceport conversation, a job-board mission's conversation, an outfit's "use" through a mission) sets the condition `mod ui: <mod>: <slot>` to 1. At its next frame call the package sees the change, resets the condition to 0, and dispatches `HOOK_UI {slot, action: "trigger"}` to that mod. The mod typically answers with `UI_SHOW`.

**Slots.**

| Slot | Merge | Lvl |
|---|---|---|
| `mod.screen` (full screen, as the outfitter is) | exclusive | L0 (package panel) |
| `mod.panel` (a smaller window) | exclusive | L0 (package panel) |
| `dialog` (confirm, number, text input) | exclusive | L0 (`DialogPanel`) |
| `mods.page` (the Mods screen: list, settings, state) | — | L0 as a package screen, reached by the condition trigger `mod ui: mods: page`; a menu entry is Ad. [A11] |
| `planet.button` | set per mod | Ad. [A6] |
| `outfitter.button`, `shipyard.button` | set per mod | Ad. [A7] |
| `map.layer` (lines, markers, labels, rings), `map.detail` | set per mod | Ad. [A8] |
| `hud.status` | set per mod | Ad. [A9] |

**Spec.**
- `UI_SHOW {slot, EsUiNode span, root}` describes a widget tree.
- Each node is a flat POD: `{kind, flags, parent, id, text, text2, value, color[4], items}`.
- Widget kinds: `column`, `row`, `heading`, `text`, `button`, `table` (columns, rows, selectable, sortable headers), `chart` (up to three series), `number_input`, `toggle`, plus the map kinds `marker`, `line`, `label`, `ring` and `detail`.
- Activations come back as `HOOK_UI {slot, instance, widget id, action, value}`.
- `UI_UPDATE` patches nodes by `id`: selection, rows, chart data.
- The package renders trees with upstream drawing facilities only: `FontSet`, `FillShader`, `Interface`, `Table`, `WrappedText`.

**Settings (optional layer, L0).**
- `SETTING_DECLARE {id, label, type, default, min, max, choices, doc}` is called at `HOOK_START`, or a `setting` entry appears in the `mod` node.
- Values live in `<config>/mod settings.txt`, written by the package. They are global, not per pilot.
- They are shown on the `mods.page` screen. A change dispatches `HOOK_SETTING`.

**Keys.**
- `KEY_DECLARE` needs the engine to route a key to the package while a vanilla panel is on top. That is adoption A9.
- At L0, keys reach mods only while a package panel has focus, through the panel's own `KeyDown`.

**SDK base classes** are built on ops only, with no ABI of their own:

| Class | Built on |
|---|---|
| `Feature` | `DEP_STATUS`, `LOOKUP(feature)`, `WITHDRAW` |
| `Persistent` | `STORAGE_GET`, `SET mod.data` |
| `Timer` | `HOOK_STEP`, `HOOK_DAY` |
| `Screen` | `UI_SHOW mod.screen`, `UI_UPDATE`, `HOOK_UI` |
| `MapLayer` | `UI_SHOW map.layer` (needs A8) |
| `JobBoard` | `OFFER_JOB` (needs A10) |

---

## 11. Persistence of mod data (core, Level 0)

Mods keep per-pilot text by key (`mod.data[key]`; read with `STORAGE_GET`). At L0 the pilot file cannot carry it, because upstream `PlayerInfo::Save` writes nothing the package controls. The options were weighed as follows.

| Option | Saved atomically with the pilot? | Follows snapshots and old saves? | Cost |
|---|---|---|---|
| (a) Encode the data into conditions (int64 chunks) | Yes | Yes | Bloats the save; conditions are visible to missions; awkward to encode text |
| (b) A sidecar written when a save is observed (file modification time) | No: written after the fact; lost when the game quits right after saving | No | Unreliable |
| **(c) A versioned sidecar, pinned by one condition** | **Yes, for the pointer** | **Yes** | Small |

**Chosen: (c).**

### 11.1 Layout

- `<config>/mod data/<pilot id>/<version>.txt`: DataNode text with one block per mod (`mod "<name>"`), holding `"<key>" "<value>"` children.
- `<pilot id>` is a random 63-bit number, held in the condition `mod api: pilot id`.
- The current version is held in the condition `mod api: data version`.
- Both conditions live in the pilot's `ConditionsStore` and are saved by upstream with every save: snapshots, autosaves, quitting.

### 11.2 Writing

1. A `SET` of `mod.data` marks the store dirty (or a commit, in the queued layer).
2. At the end of the frame call, if dirty, the package writes `<version+1>.txt`. It writes to a temporary name and renames, so the file is complete before it is referenced.
3. Only then does it set `mod api: data version = version+1`.

Any save the engine makes afterwards carries the new pointer. A save made in between carries the old pointer, whose file still exists. So **whatever save the player loads, it names a complete file matching its own moment.**

### 11.3 Loading and pilot changes

On every frame call the package reads `mod api: pilot id` and `mod api: data version` (two `ConditionsStore::Get` calls, `ConditionsStore.h:58`).
- **No pilot id:** a new pilot. The package assigns an id, starts empty, and dispatches `HOOK_PILOT_LOADED`.
- **A pilot id or version different from what the package last wrote or loaded:** another pilot was loaded, or an older save of the same pilot. The package loads `<pilot id>/<version>.txt`, bumps the handle generations of the live types, and dispatches `HOOK_PILOT_LOADED`.

A missing version file (it was pruned) falls back to the nearest older one, and the fallback is logged.

### 11.4 Pruning

At startup, the package scans `Files::Saves()` (`Files.h:41`) for save files containing `mod api: pilot id <id>`, and collects the versions they reference.
- It keeps those versions, plus the last 50.
- It deletes the rest when they are older than 30 days.

### 11.5 Without a save hook

- Mods cannot run code "just before saving" at L0 (`HOOK_SAVE` is adoption A2).
- Data is written when it changes, so nothing is lost. A mod that kept state only in memory must store it when it changes, which the SDK's `Persistent` class does.

**With adoption A2**, the package's data goes into the pilot file itself as a block, and `HOOK_SAVE` runs before it is written. The sidecar remains for older saves.

---

## 12. Performance and limits

**Per-call cost.** These are estimates, to be confirmed by the bench in section 20. For reference, the previous API's numeric call measured about 40 ns end to end through a script runtime.

| Path | Estimate |
|---|---|
| `es_call` dispatch: switch, header checks, context mask check | 10–20 ns |
| Single record read (core: marshalled fresh) | 0.2–1 µs |
| `SHIPS_IN_SYSTEM`, 200 ships × 176 B (core: per call) | 10–25 µs per call. Twenty mods each reading it every step cost 0.2–0.5 ms, which is the case the caching layer addresses |
| `SET` in the core (direct) | the cost of the upstream mutator |
| `SET` in the queued layer | 40–80 ns (append to the journal arena) |
| `WRITE_BATCH` of n entries | one crossing + n × 30 ns |
| Hook dispatch per mod | one indirect call; the game opens and closes the bracket itself |
| Commit (queued layer), typical step (< 100 entries in total) | < 50 µs; target < 0.2 ms at the 99th percentile |
| Tier 1 tree build (layer), `Save`-backed ship (`SaveToString` + parse + convert) | 30–80 µs per ship |
| Tier 1 tree build (layer), `ModSerialize` definition (system, planet) | 5–20 µs |
| Tier 1 `GET` on a built tree | segment walk: O(depth × siblings), typically 0.2–1 µs; each `name` segment is a linear scan, with a per-node key index built after 16 lookups |
| `GET_MANY` 200 ships × 3 paths (trees built) | ~100 µs: build cost dominates; use `SHIPS_IN_SYSTEM` for per-frame fields |
| `ATTRS(outfit)` | 1–3 µs |

**Guidance.**
- Tier 1 is for breadth: UI, reports, occasional queries. Tier 2 is for anything read every step.
- In the core, a mod should read a list once per hook and keep the result for the rest of that hook. It is valid until the hook returns.
- The timing report shows time spent inside game calls, per mod and op, so expensive read patterns are visible.

**Tree bounds.** The point arena counts tree bytes. A single tree over 1 MiB (for example a `conditions` subtree) is built only when its path is requested explicitly, never through `DESCRIBE(player)` with the default depth of 3.

**Limits** (constants in `ModLimits.h`). Rows marked with a layer apply only once that layer exists.

| Resource | Limit | On overflow |
|---|---|---|
| Journal entries per mod per point (queued layer) | 4096 | `ES_LIMIT` at call time; the entries already recorded are kept; logged once a minute |
| Journal bytes per mod per point (queued layer) | 1 MiB | as above |
| Scratch arena per mod per hook | 4 MiB | `ES_LIMIT`; caller may use caller-buffer mode |
| Point / session view cache (caching layer) | 16 / 32 MiB | `ES_LIMIT` / least-recently-used eviction |
| Events queued per subscriber (events layer) | 4096 | Oldest dropped; `events_overflowed` |
| Bus | section 8.1 | refused or dropped, and logged |
| Ops / deps per registration | 256 / 64 | `ES_BAD_ARG` |
| Routed async calls per mod per point (routing layer) | 64 | `ES_LIMIT` |

**Commit cost per frame (queued layer).**
- The fold uses a flat hash map keyed by `(handle, property, key-hash)`, reused across points with no allocation in steady state.
- Commit time is timed per point and reported as a row of its own (`(commit)`) in the package's timing report: per mod, per hook and per section, plus each mod's share of the frame, logged at exit.

---

## 13. The header, the tables and the layout helper

There is no schema file and no generator. **One hand-written C header, `source/modding/es_api.h`, is the single source of truth** for ops, structs, records, enums, IDs and constants. Languages that interoperate with C build their bindings from it with their own tools: rust-bindgen, Zig's `@cImport`, Python's cffi/ctypes, Dado's `foreign` import, and so on.

### 13.1 Header rules (binding-friendly)

1. **Language.** Plain C11, also valid C++17. No compiler extensions in the declarations.
2. **Types.** Only `<stdint.h>` fixed-width integers, `float`, `double`, the `ES_PTR` union (section 3.2) and named structs. No `bool`, `long`, `size_t`, enums-as-field-types or bitfields in any struct: enum *values* are stored in `uint32_t` fields.
3. **Explicit padding.** Every struct is laid out by hand with natural alignment, with `_padN` members where needed, and its size is a multiple of 8.
4. **Size checks.** After each struct, `ES_STATIC_ASSERT(sizeof(EsShipState) == 176, "...")` and `ES_STATIC_ASSERT(offsetof(EsShipState, hull) == 96, "...")` for every field. The `ES_STATIC_ASSERT` macro expands to `_Static_assert` in C11 and `static_assert` in C++, and to nothing for tools that cannot parse either (`#ifdef ES_NO_STATIC_ASSERT`).
5. **Few macros, all documented.** Layouts never depend on a macro.
   - `ES_PTR` is documented as "8 bytes, a pointer in the low bits on 32-bit targets".
   - `ES_CALL` and `ES_EXPORT` affect only functions.
   - Constants are `#define ES_OP_SHIP_STATE 302u` or `enum { ES_OP_SHIP_STATE = 302 };`, one per line, **with the value written explicitly**.
6. **Versions.** The header defines:
   - `ES_API_VERSION` (11);
   - `ES_HEADER_REVISION`, bumped on every append;
   - each struct's revision as `ES_REV_<STRUCT>`.
7. **ID stability.** Every op code, record id, handle type id, property id, event id, slot id, widget kind and status value is written as an explicit number. The rules:
   - Never renumber, retype or remove.
   - Append only, with the next free number in that block.
   - A retired ID stays in the header, commented `/* retired in rev N; do not reuse */`.
8. **Grouping.** The header is sectioned in the order of section 4.2, so a diff shows what a revision added.

### 13.2 The dispatch and discovery tables (in the package)

- **`ModOps.cpp`** holds one table entry per specified op: `{code, name, implementors, contexts mask, flags, in min size, in current size, out min size, out current size, layer}`.
  - The dispatcher (`ModDispatch.cpp`) is a hand-written `switch (op)`. Each case validates its arguments, as described in section 17.
  - `LOOKUP`, `INTROSPECT` and `LIST_IDS` answer from this table.
- **`ModIds.cpp`** holds the name ↔ id tables for handle types, properties, events, slots, widgets and features. Each has a short descriptor: for a property, its type, merge modes, contexts and level (L0 or adopted).
- **Feature names** cover adopted capabilities (`"adopted:planet.button"`, …). An entry reports present only when the build provides it, so a mod can test it with `LOOKUP(feature, …)`.

**Keeping the tables in sync with the header.** A unit test (`test_modops.cpp`, section 20) does three things:
1. reads `es_api.h` as text and extracts every `ES_OP_*`, `ES_PROP_*`, `ES_EVENT_*` and `ES_SLOT_*` constant with a simple line pattern;
2. checks that each one has exactly one table entry with the same number and name, and that no table entry is missing from the header;
3. calls the dispatcher with each op and a zeroed, correctly sized struct outside any hook, and checks that the answer is never `ES_UNKNOWN_OP`. A missing `case` therefore fails the test.

### 13.3 The layout helper

`EsLayout.{h,cpp}` is a small, dependency-free unit that holds the field-type table:
- name → size and alignment: `u8 … i64`, `f32`, `f64`, `bool` (u8), `str` (16), `span` (16), `buf` (16), `handle` (8), `struct:<name>`, `pad:<n>`;
- the rules of section 3.2.

It is used in two places:
- **`mod` node `struct` blocks** (section 7.6): given a field list, it computes offsets, padding and total size, or reports why the layout is invalid. The rules: unknown type, misalignment, overlap, a size that is not a multiple of 8, or a `str`/`span`/`handle` field of the wrong size.
- **Registration** (section 7.2): it checks each `EsOpDesc` layout the same way, and compares a mod's runtime descriptor with its `mod` node by layout hash: FNV-1a over `(name, type, offset)` per field.

No generator checks a mod's layouts. The game validates them when the mod registers, with this helper.

**For specified ops a mod implements** (hooks, `PING`, Tier 1 reads), the descriptor's `in`/`out` must be null, meaning "as specified". If not null, they must equal the game's own sizes, from the `ModOps` table.

---

## 14. Native code in plugins: trust

**The model, stated plainly.**
- A native library is **fully trusted code, exactly like the game executable**. It runs in the game's process with the player's privileges: no sandbox, no preemptive watchdog (its host can only time it), and a crash takes the game down. No in-process mechanism could change that, and the API does not pretend otherwise.
- **The permission to run it is installing and enabling its plugin.**
  - Putting a plugin folder into `plugins/` takes deliberate effort. A player who did that has already decided to run what is in it.
  - A prompt would be one the player always accepts, so there is none.
  - Enabling and disabling the plugin in the game's plugin list is the control.
- **There is no in-game plugin installer or downloader** in the game's source today (no plugin download or index code under `source/`). Plugins arrive by being copied into a plugins folder. If upstream adds an installer, installing through it is the same deliberate act and needs no extra prompt. The plugin list should still show which plugins contain native code.
- The sandbox covers only what a hosting mod gives its script mods. For Dado, that is a QuickJS engine per mod with no file, network or process access (README "The sandbox"). `EsModReg.trust` is informational.

**What the game guarantees.**
1. **A disabled plugin's library is never opened.**
   - A disabled plugin is not in `GameData::Sources()`, so its `mod.txt` is never read (section 7.6).
   - The opener re-checks `PluginManager` before opening anything anyway.
2. **Paths stay inside the plugin.** Absolute paths, `..` and symlinks escaping the plugin folder are rejected (section 7.6).
3. **Integrity, not permission.**
   - The optional `sha256` line under `library` is checked against the cached copy just before it is opened. A mismatch means the file is corrupt or not what the author shipped: the mod is `FAILED` and the reason is logged.
   - A library without a pin loads normally.
4. **Copy, then open.** Libraries are opened from `<config>/native-cache/<sha256>/`, never in place. This also covers zipped plugins.
5. **Kill switch, for troubleshooting.**
   - At L0, either of two switches turns off every native library:
     - the environment variable `ES_NO_NATIVE_MODS=1`;
     - the preference `"Native mods: off"`, read with `Preferences::Has` (`Preferences.h:190`), which the package's Mods screen can set (`Preferences::Set`, `Preferences.h:191`).
   - A command-line flag needs a line in `main.cpp`, so it belongs to adoption A3.
   - Native mods are then registered in state `SWITCHED_OFF`, and script mods hosted by them do not appear.
   - It is meant for finding a crashing mod, not as a security control.
6. **Visibility.**
   - The log records every library opened, with its plugin and hash.
   - The package's Mods screen lists every native mod with its plugin, library, hash and state.
   - Marking plugins that contain native code in the game's own plugin list needs adoption A11.

**Documentation required of any native mod.** It is checked by the SDK's release tool and stated in `docs/modding-api.md`:
- a README section "Native code" saying what the code does and why it must be native;
- the source code or a link to it, and the licence;
- reproducible build instructions and the `sha256` lines;
- the platforms supported;
- that it is not sandboxed;
- for a mod that registers others, what it loads and what sandbox, if any, it gives them.

On macOS, libraries must be at least ad-hoc signed to be loadable on Apple silicon. The cached copy keeps the signature.

---

# Part III: Implementer's guide

Work through sections 15–20 in order. Each item in section 19 ends with a checkpoint: something to verify before moving on.

## 15. Repository layout and build

### 15.1 Where the package lives

The package is **`source/modding/`**, a subdirectory of `source/` like the existing `image/`, `text/` and `shader/`. Includes therefore read `#include "modding/ModApi.h"`, matching upstream style (`#include "image/Mask.h"`, `Engine.cpp:42`).

- **No new dependencies.**
  - Native libraries are opened with SDL (`SDL_LoadObject`, `SDL_LoadFunction`, `SDL_UnloadObject`), which the game already links.
  - Files and zips go through upstream `Files`; text parsing through upstream `DataFile`/`DataNode`.
  - The rest is C++17 standard library: `<filesystem>` and `<chrono>`.
- **Build.** A file `source/modding/Modding.cmake` contains `target_sources(EndlessSkyLib PRIVATE …)` listing the package's files with their `modding/` prefix. It is pulled in by one line in `source/CMakeLists.txt` (section 16.1).
  - `EndlessSkyLib` is an `OBJECT` library (`source/CMakeLists.txt:1`), so every package object is linked into the executable.
  - When `BUILD_TESTING` is on, `Modding.cmake` also defines:
    - the unit-test executable `EndlessSkyModTests`, with Catch2 as upstream's tests use (`tests/CMakeLists.txt`), so no upstream test file changes;
    - the test native library `es_test_mod` (`add_library(... MODULE ...)`);
    - a CTest entry that runs the integration tests in section 20.

### 15.2 Ways of avoiding upstream lines that were investigated

| Idea | Result |
|---|---|
| Have upstream's CMake pick the files up by glob | Not possible: upstream lists every source explicitly ("Every source file … should be listed here", `source/CMakeLists.txt:14-16`). One `include` line is the minimum |
| A static initializer in a package file registers the package | It would run, because `EndlessSkyLib` is an `OBJECT` library and nothing is dropped. But it reaches nothing it needs: `PlayerInfo player` is a local in `main` (`main.cpp:105`), the UIs are locals in `GameLoop` (`main.cpp:302-306`), and the engine's ship list is private (`Engine.h:236`). Useful only for self-registration of package parts, not as a substitute for a call site |
| An SDL event watch (`SDL_AddEventWatch`) installed by a static initializer, as a per-frame tick | Rejected. It is called from inside `SDL_PollEvent` (`main.cpp:341`), on the main thread, but only when events arrive, so not every frame. It runs before `MainPanel::Step` calls `engine.Wait()` (`MainPanel.cpp:67`), so while the calculation thread may still be running: a data race. And it has no reference to the player or the UI |
| SDL timers | Run on another thread. Rejected |
| An existing generic extension mechanism | None: plugins cannot run code, conversations and missions cannot call into C++, and the test framework only drives tests |
| Start the package lazily instead of a startup call | **Adopted.** It starts on the first frame call. Data has loaded by then, because `MainPanel` exists only after `GameLoadingPanel` has finished (`GameLoadingPanel.cpp:52-62`) |
| `std::atexit` instead of a shutdown call | **Adopted.** Registered when the package starts. Caveat: function-local statics created after that registration are destroyed before the handler runs, so `HOOK_SHUTDOWN` runs with **no world access** (context I), and the package only lets mods clean up and then unloads libraries |
| Read the `mod` node without touching `UniverseObjects` | **Adopted:** `<plugin>/mod.txt`, read by the package (section 7.6) |
| Persist mod data without touching `PlayerInfo` | **Adopted:** the versioned sidecar (section 11) |

**The truly unavoidable lines:**
1. **Build**, 1 line: the package's files must be compiled.
2. **`Engine::Step`**, 2 lines: the only place where the ships in the system, the spawn list and the step's ship events are reachable.
3. **`MainPanel::Step`**, 2 lines: the only place where the game's `UI` is reachable while the engine is paused. It is unavoidable only if mods are to have any UI.

## 16. Upstream integration points

Each entry gives the file, the function, the insertion point (with the upstream lines around it), the call, why it goes there, and the thread and state at that point. Lines are at the pinned commit.

### 16.1 Build (required)

`source/CMakeLists.txt`, at the end of the file, after the Windows block:

```cmake
if(WIN32)
	target_sources(EndlessSkyLib PRIVATE
		windows/TimerResolutionGuard.cpp
		...
	)
endif()                                   # source/CMakeLists.txt:507 (last line)
include(modding/Modding.cmake)            # <-- add
```

- **Why there:** after `EndlessSkyLib` exists, and without editing the long file list.
- **State:** configure time.

### 16.2 Per-frame world call (required)

`source/Engine.cpp`, `void Engine::Step(bool isActive)` (`Engine.cpp:454`).

Insert after the comment at line 470, and before line 471:

```cpp
			if(object.HasSprite())
				SpriteLoadManager::LoadDeferred(asyncQueue, object.GetSprite());

	// The calculation thread was paused by MainPanel before calling this function, so it is safe to access things.
	ModApi::EngineFrame(player, ships, newShips, events, step, isActive && !timePaused);   // <-- add
	const shared_ptr<Ship> flagship = player.FlagshipPtr();
	const StellarObject *object = player.GetStellarObject();
```

Also add `#include "modding/ModApi.h"` to the include block (alphabetical, near `#include "Mission.h"`, `Engine.cpp:45`).

**Arguments:**
- `player`: `PlayerInfo &`, the engine's member;
- `ships`, `newShips`: `std::list<std::shared_ptr<Ship>>`, `Engine.h:236` and `:244`;
- `events`: `std::list<ShipEvent>`, `Engine.h:303`, holding the last calculation step's events (swapped in at `Engine.cpp:456`);
- `step`: `int`, `Engine.h:297`, incremented in `Engine::Go` (`Engine.cpp:1128`);
- the flag: true only when the game is flying and not paused (`timePaused`, `Engine.h:300`).

**Why here:**
- It is the only place where the engine's ship list, spawn list and events are reachable.
- The engine's own comment guarantees the calculation thread is paused.
- Ships pushed into `newShips` are spliced into `ships` by the next calculation step (`Engine.cpp:1882`), as the engine's own spawning does (`Engine.cpp:1562`, `Fleet::Place`).

**Thread and state:**
- Main thread, with the calculation thread paused (`MainPanel::Step` called `engine.Wait()` at `MainPanel.cpp:67`).
- It runs every frame while the game screen is on the stack, including while landed: `UI::StepAll` steps every panel in the stack (`UI.cpp:101-108`), and `MainPanel::Step` calls `engine.Step` unconditionally (`MainPanel.cpp:127`).
- It does not run while a menu is shown (`main.cpp:472` steps `menuPanels` instead).

**What the package does there:**
1. Start, if not started yet.
2. Run the observers: system, date, planet, pilot.
3. Record the ship events.
4. If flying, run the flight hooks (`HOOK_DAY` per new day, `HOOK_ENTER`, `HOOK_STEP`) for the mods that implement them.
5. Drain the bus.

### 16.3 Per-frame UI call (required for mod UI)

`source/MainPanel.cpp`, `void MainPanel::Step()` (`MainPanel.cpp:65`).

Insert after line 127, and before line 129:

```cpp
	// Display any relevant help/tutorial messages.
	if(isActive)
		isActive = !ShowHelp(false);

	engine.Step(isActive);
	ModApi::PanelFrame(player, GetUI(), isActive);   // <-- add

	if(isActive && !engine.IsPaused())
		player.StepMissionTimers(GetUI());
```

Also add `#include "modding/ModApi.h"` (alphabetical, near `#include "Mission.h"`, `MainPanel.cpp:31`).

**Why here:**
- `GetUI()` is reachable here: it is protected in `Panel` (`Panel.h:137`), and `MainPanel` is a panel.
- The engine is still paused: `engine.Go()` comes later, at `MainPanel.cpp:139-140`.
- Upstream itself applies event changes and opens panels at this point (`player.Land(GetUI())`, `MainPanel.cpp:105`).

**Thread and state:**
- Main thread, calculation thread paused, every frame while the game screen is on the stack.
- `isActive` is false when another panel is on top: landed, a dialog, the map.

**What the package does there:**
1. Capture the `UI &` (first call).
2. Run the paused-context work:
   - landed and pilot observers, and `HOOK_DAY`/`HOOK_ENTER` when not flying;
   - deferred `APPLY_EVENT`s (section 6.1);
   - condition triggers (section 10);
   - pushing or closing package panels;
   - persistence writes (section 11.2).
3. Drain the bus.

### 16.4 Startup (no upstream line)

The package starts lazily, in whichever frame call comes first. Data has loaded and a pilot exists by then.

**Start sequence:**
1. Read the `mod.txt` files.
2. Build the static registry and sort it.
3. Open the libraries.
4. Run `HOOK_DISCOVER` rounds, then the full sort.
5. Run `HOOK_START`, then the pilot observer.

*Optional (adoption A3):* to start before the main menu (for example, for a Mods entry there), call `ModApi::Init()` in `GameLoadingPanel::Step` right after `GameData::FinishLoading();` (`GameLoadingPanel.cpp:59`), before `PilotProfile::LoadProfiles();` (`:61`).

### 16.5 Shutdown (no upstream line)

`std::atexit(&ModApi::Shutdown)` is registered at start. It does three things:
1. dispatches `HOOK_SHUTDOWN` in reverse order, with no world access;
2. unloads the libraries;
3. writes the timing report to the log (`Logger::Log`).

*Optional (adoption A3):* an explicit call in `main.cpp`, just before `GameLoop(player, queue, conversation, testToRunName, debugMode);` (`main.cpp:266`): a guard object whose destructor calls `ModApi::Shutdown()`. Mods then shut down while the game state still exists.

### 16.6 Data loader for `mod` nodes (no upstream line; optional A1)

At L0 the package reads `<plugin>/mod.txt` (section 7.6).

*Optional (adoption A1):* in `UniverseObjects::LoadFile` (`UniverseObjects.cpp:367`), add a branch before the final fallback:

```cpp
		else if(key == "mod" && hasValue)      // <-- add (2 lines + 1 include)
			ModDescriptors::Add(node, path);
		else
			node.PrintTrace("Skipping unrecognized root object:");   // UniverseObjects.cpp:736-737
```

`LoadFile` runs on a task-queue thread (`UniverseObjects::Load`, `UniverseObjects.cpp:48-66`), so `Add` must take a lock.

### 16.7 Pilot save and load (no upstream line; optional A2)

At L0 the package uses the versioned sidecar (section 11).

*Optional (adoption A2):*
- in `PlayerInfo::Save(DataWriter &)` (`PlayerInfo.cpp:5031`), call `ModApi::Saving(*this, out)` first (`HOOK_SAVE`), and write a `"mod data"` block;
- in `PlayerInfo::Load` (`:303`), hand a `"mod data"` child to the package;
- in `PlayerInfo::Clear` (`:241`), tell the package a pilot is being cleared.

That is about 8 lines in one file.

## 17. File-by-file plan

Files are listed in the order to write them. "Owns" means the data that file alone may mutate. "Deps" lists package files first, then upstream classes. Each file is a pair `.h`/`.cpp` unless noted.

### Core

| # | File | Responsibility | Owns | Deps |
|---|---|---|---|---|
| 1 | `es_api.h` (header only) | The normative ABI: status codes, `EsHeader`, `ES_PTR`, `EsStr`/`EsSpan`/`EsBuf`, `EsHandle`, `EsBoot`, `EsModReg` and descriptors, every op constant, every in/out struct and record, the ID enums, static assertions (sections 3, 4, 13.1) | — | `<stdint.h>`, `<stddef.h>` |
| 2 | `ModLimits.h` (header only) | Every numeric limit (section 12) | — | — |
| 3 | `EsLayout` | Field-type table; computing offsets, padding and size from a field list; validating a descriptor's layout; layout hash (section 13.3) | — | 1 |
| 4 | `ModSha256` | A small, self-contained SHA-256 for library pins and cache names. Upstream has none | — | — |
| 5 | `ModArena` | Per-hook scratch arena (chunks, reset); helpers: copy a `std::string` into an `EsStr`, allocate an `EsSpan` of n records with a stride, pack into a caller `EsBuf` with the two-call rule (section 3.4) | Arena chunks | 1, 2 |
| 6 | `ModHandles` | One slot table per handle type. Definitions keyed by pointer (generation 1); live objects by `weak_ptr<Ship>` or `EsUuid` (generations bumped on slot reuse and on pilot change). Encode and decode handles; `FIND`/`KEY_OF` by true name or UUID | Slot tables | 1; `GameData` sets (`GameData.h:128-157`), `Ship`, `EsUuid` |
| 7 | `ModOps`, `ModIds` | The op table and the ID name tables (section 13.2), used by dispatch and discovery | Static tables | 1 |
| 8 | `ModContext` | The current frame's world pointers (player, ships, newShips, events, step, UI), the context bits, and the bracket (the running mod's address, or none). Guards: "no world outside a frame call" | World pointers, bracket | 1; `PlayerInfo`, `Ship`, `ShipEvent`, `UI` |
| 9 | `ModDispatch` | `es_call` itself: null and size checks, address routing (game vs. a mod's dispatch), context-mask check from `ModOps`, then `switch (op)` calling the handler. Exports the `EsCallFn` given in `EsBoot` | — | 5–8 |
| 10 | `ModDescriptors` | Read `mod.txt` from enabled plugins; parse `mod` nodes; path rules; platform choice; struct layouts through `EsLayout` (section 7.6) | Parsed descriptors | 3; `GameData::Sources`, `Files`, `DataFile`, `PluginManager` |
| 11 | `ModRegistry` | Entries (address, name, plugin, version, state, `registered_by`, dispatch, ops, deps); registration validation; static and full sorts (Kahn with a name-ordered heap; Tarjan to break cycles); `EsDepResult`s; withdraw (section 7) | The registry | 3, 7, 10 |
| 12 | `ModNative` | For each static native entry: copy to the cache (with zip extraction), check the pin, `SDL_LoadObject`, `SDL_LoadFunction("es_mod_init")`, call it inside a bracket, compare with the descriptor; unload at shutdown (sections 3.6, 7.6, 14) | Library handles | 4, 9, 10, 11; SDL, `Files` |
| 13 | `ModTiming` | Times every bracket per mod, hook and section; frame share; slow-hook log lines; exit report | Timing tables | `Logger`, `<chrono>` |
| 14 | `ModHooks` | Run one hook op over the mods that registered it, in resolved order: open the bracket, reset the arena, call the dispatch, close the bracket, handle `ES_STOPPED` and exceptions crossing the boundary (impossible in C; a C++ mod must not throw across it) | — | 5, 8, 11, 13 |
| 15 | `ModObserve` | Per-frame diffs: date, system, planet, pilot, fleet and missions; records `ShipEvent`s into kills, losses and tags; decides which hooks to run (sections 8.2, 11.3) | Previous-frame snapshot | 8; `PlayerInfo`, `ShipEvent`, `Mission` |
| 16 | `ModRecords` | One fill function per Tier 2 record, plus the list ops, each marshalling fresh into the arena (section 18.1) | — | 5, 6, 8; upstream getters |
| 17 | `ModBus` | Notification queue, listen patterns, limits, drain rounds (section 8.1) | Queue, patterns | 11, 14 |
| 18 | `ModWrites` | Property apply functions and actions, with validation and the engine-safety guards; the deferred `APPLY_EVENT` list (sections 6.1, 6.3, 18.3) | Deferred list, spawned-ship tags | 6, 8; upstream mutators |
| 19 | `ModStorage` | The sidecar: pilot id and version conditions, load, write (temporary file, then rename), pruning (section 11) | Per-mod data maps | 8; `ConditionsStore`, `Files`, `DataFile`/`DataWriter` |
| 20 | `ModApi` | The facade: `EngineFrame`, `PanelFrame`, the lazy start sequence, `atexit` shutdown | Package state machine (unstarted, running, idle) | everything above |
| 21 | `Modding.cmake` | Source list; test targets | — | — |

### Later layers (each self-contained)

| File | Layer |
|---|---|
| `ModJournal` | Queued writes: journals, merge, commit, overlay (6.4–6.8) |
| `ModViews` | Caching (5.7) |
| `ModTree`, `ModSerialize`, `ModPath`, `stable_paths.txt`, `coverage.txt`, `tools/coverage.py` | Tier 1 traversal (5.1–5.5) |
| `ModEvents` | Events (8.2) |
| `ModUi`, `ModPanel`, `ModDialog` | UI kit (10) |
| `ModSettings` | Settings (10) |
| `ModRouting` | Routed calls (9.2) |

### Tests (section 20)

- `source/modding/tests/unit/test_*.cpp`
- `source/modding/tests/testmod/` (the C test library)
- `source/modding/tests/integration/config/plugins/modapi-tests/` (a test plugin with `mod.txt`, `data/tests/*.txt`, and `lib/<platform>/` filled by the build)

## 18. Upstream source map

The map from each Level 0 feature to the upstream code that provides it. Header line numbers are at the pinned commit.

### 18.1 Tier 2 records (core)

| Record: field | Upstream source |
|---|---|
| **ShipState** (ships in system: the `ships` list passed to `EngineFrame`; also the player's ships) | |
| `handle` | `ModHandles` (`weak_ptr<Ship>`) |
| `model` | `Ship::TrueModelName()` (`Ship.h:218`) → `GameData::Ships().Find` |
| `government` | `Body::GetGovernment()` (`Body.h:55`) |
| `name` | `Ship::GivenName()` (`Ship.h:213`) |
| `uuid` | `Ship::UUID().ToString()` (`Ship.h:208`, `EsUuid.h:77`), player's ships only |
| `tag` | The package's own map, filled by `SPAWN_FLEET` |
| `x`, `y`, `vx`, `vy`, `facing` | `Body::Position()`, `Velocity()`, `Facing()` (`Body.h:44-47`) |
| `hull`, `shields`, `energy`, `fuel` | `Entity::HullLevel()`, `ShieldLevel()`, `EnergyLevel()`, `FuelLevel()` (`Entity.h:60-63`) |
| `max_*` | `Entity::MaxHull()`, `MaxShields()`, `MaxEnergy()`, `MaxFuel()` (`Entity.h:70-73`) |
| `strength` | `Ship::Cost()` (`Ship.h:232`) |
| `is_player` | `Ship::IsYours()` (`Ship.h:256`) |
| `is_flagship` | pointer equality with `PlayerInfo::Flagship()` (`PlayerInfo.h:177`) |
| `is_disabled` | `Ship::IsDisabled()` (`Ship.h:344`) |
| `is_parked` | `Ship::IsParked()` (`Ship.h:259`) |
| **FleetShip** (`PlayerInfo::Ships()`, `PlayerInfo.h:181`, skipping `Entity::IsDestroyed()`, `Entity.h:92`) | As ShipState, plus `system` = `Ship::GetSystem()` (`Ship.h:333`) and `planet` = `Ship::GetPlanet()` (`Ship.h:337`) |
| **PlayerState** | `day`: `PlayerInfo::GetDate()` (`PlayerInfo.h:133`), as days since epoch; `step`: from `EngineFrame`; `system`, `planet`: `GetSystem()`/`GetPlanet()` (`PlayerInfo.h:146`, `:150`); `flagship`: `Flagship()`; `credits`: `Accounts().Credits()` (`PlayerInfo.h:162`, `Account.h:40`); `first_name`, `last_name`: `PlayerInfo.h:128-129`; `dead`: `IsDead()` (`PlayerInfo.h:125`) |
| **PLAYER_CARGO** | Landed: `PlayerInfo::Cargo().Commodities()` (`PlayerInfo.h:211`, `CargoHold.h:79`). Flying: the sum of `Ship::Cargo().Commodities()` (`Ship.h:512`) over the player's ships in the system |
| **CONDITIONS_GET** | `PlayerInfo::Conditions().Get(name)` (`PlayerInfo.h:308`, `ConditionsStore.h:58`) |
| **SHIP_OUTFITS** | `Ship::Outfits()` (`Ship.h:521`) |
| **SystemInfo** (`GameData::Systems()`, `GameData.h:153`; skip `!IsValid()` and `Inaccessible()`) | `key`: `TrueName()`; `display_name`: `DisplayName()`; `x`, `y`: `Position()`; `government`: `GetGovernment()`; `links`: `Links()`; `inhabited`: `IsInhabited(player.Flagship())`; `hidden`: `Hidden()`; `danger`: `Danger()`; `has_market`: `HasTrade()`; `planets`: `Objects()` → `StellarObject::HasValidPlanet()`/`GetPlanet()` (`StellarObject.h:56-58`); `fleets`: `Fleets()` → each `RandomEvent<Fleet>`'s fleet (System.h lines 88–190 as cited in section 5) |
| **PlanetInfo** (`GameData::Planets()`) | `TrueName()`, `DisplayName()`, `GetSystem()`, `GetGovernment()`; `services`: bits from `HasServices()`, `HasShipyard()`, `HasOutfitter()`, `CanUseServices()` (`Planet.h:97-164`); `attributes`: `Attributes()` (`Planet.h:83`) as a span of strings; `security`: `Security()`; `required_reputation`: `RequiredReputation()`; `inhabited`: `IsInhabited()`; `wormhole`: `IsWormhole()`; `landable`: `IsAccessible(player.Flagship())` (`Planet.h:153`) |
| **GovernmentInfo** (`GameData::Governments()`) | `TrueName()`, `DisplayName()`, `GetColor()`, `Reputation()` (`Government.h:183`), `IsEnemy()` (`:153`, enemy of the player), `GetBribeFraction()`, `GetFineFraction()`, `Language()` |
| **GOVERNMENT_ATTITUDES** | `Government::AttitudeToward(other)` (`Government.h:95`) for every government |
| **FleetInfo** (`GameData::Fleets()`) | `government`: `Fleet::GetGovernment()` (`Fleet.h:61`); `strength`: `Fleet::Strength()` (`Fleet.h:75`); averaged stats Ad. [A5] |
| **COMMODITIES** | `GameData::Commodities()` (`GameData.h:167`): `Trade::Commodity{name, low, high}` (`Trade.h:31-35`) |
| **MARKET** | `System::Trade(name)` (`System.h:171`) per commodity; `base_price` Ad. [A5] |
| **SHIPYARD_LISTING** / **OUTFITTER_LISTING** | `Planet::Shipyards()` / `Outfitters()` (`Planet.h:113`, `:121`) → `Shop<T>::Stock()` (`Shop.h:49`): the items, merged and sorted by true name |
| **PLUGINS** | `PluginManager::Get()` (`PluginManager.h:44`): `Plugin::name`, `enabled`, `path` (`Plugin.h:55-72`) |
| **ModelInfo** (`GameData::Ships()`, `GameData.h:151`) | `TrueModelName()`, `DisplayModelName()` (`Ship.h:218-219`); `category`: `Attributes().Category()`; `cost`: `Ship::Cost()` (the full new price of hull and outfits); `licenses`: `Attributes().Licenses()` (`Outfit.h:105`); `hull`, `shields`, `mass`, `cargo_space`: `Attributes().Get("hull")` and so on (`Outfit.h:113`) |
| **OutfitInfo** (`GameData::Outfits()`, `GameData.h:145`) | `TrueName()`, `DisplayName()`, `Category()`, `Cost()`, `Mass()` (`Outfit.h:94-103`); `outfit_space`: `Get("outfit space")`; `is_weapon`: `GetWeapon() != nullptr` (`Outfit.h:137`); `ammo`: `GetWeapon()->Ammo()` (`Weapon.h:93`) |
| **ATTRS** | Outfit: iteration with `begin()`/`end()` (`Outfit.h:118-119`). Ship: `Entity::Attributes()` (`Entity.h:46`). Planet: `Attributes()` |
| **TAG_STATS**, **KILLS**, **STEP_LOSSES** | From the `ShipEvent`s given to `EngineFrame`: `Type()` with `DESTROY`/`DISABLE` (`ShipEvent.h:30-71`), `ActorGovernment()` compared with `GameData::PlayerGovernment()` (`GameData.h:163`), and `Target()` for the ship, its tag and its model |

### 18.2 Tier 1 definitions (Tier 1 layer)

| Type | Reachable at L0 (public getters) | Not reachable: adoption A5 |
|---|---|---|
| `system` | name, display name, position, government, links, objects (planets, stars), habitable zone, belts, jump range, haze, music, asteroids, trade, fleets (with periods), hazards, raid fleets, hidden, inaccessible, danger (`System.h:88-190`) | Per-object orbit parameters beyond what `StellarObject` exposes; the original base trade price |
| `planet` | name, display name, description, landscape, attributes, required attributes, noun, services, shipyards, outfitters, government, required reputation, bribe, security, system, wormhole, daily tribute penalty (`Planet.h:65-174`) | Defense fleets and threshold (private: `defenseThreshold`, `Planet.h:214`); tribute amount |
| `government` | names, swizzle, colour, attitudes (via `AttitudeToward` over all governments), initial reputation, bribe and fine fractions, language, raid fleets, enemies, player flag, reputation and its bounds (`Government.h:84-187`) | Penalty tables, custom hail phrases, friendly and hostile disabled-hail settings |
| `fleet` | government, strength, validity (`Fleet.h:56-75`) | **Variants** (private), names, fighters, cargo settings, personality |
| `outfit` | names, plural, category, description, cost, mass, licenses, every attribute (iteration), weapon presence and ammo (`Outfit.h:94-137`) | Sprite and sound references are partial |
| `ship_model` | Everything, through `Ship::Save` | — |
| `galaxy`, `wormhole`, `hazard`, `minable`, `news`, `phrase`, `person` | Their few public getters (`Wormhole.h:38-43`; `Phrase.h` exposes only `ExpandPhrases`/`IsEmpty`) | Most content: phrase lists, news messages, person ship and conditions |
| `event`, `conversation`, `start`, `gamerules` | Everything, through their `Save` | — |

### 18.3 Writes and actions (core, direct)

| Write | Upstream mechanism |
|---|---|
| condition set/add | `PlayerInfo::Conditions()` → `ConditionsStore::Set`/`Add` (`ConditionsStore.h:62-65`) |
| credits add | `PlayerInfo::Accounts()` → `Account::AddCredits` (`Account.h:42`); refuse if the result would be below 0 |
| reputation set/add | `GameData::GetPolitics()` → `Politics::SetReputation`/`AddReputation` (`Politics.h:69-70`; `Politics.cpp:417-424`) |
| message | `Messages::Add(Message)` (`Messages.h:53`; `Messages.cpp:38`) |
| ship name | `PlayerInfo::RenameShip` (`PlayerInfo.h:198`) |
| travel destination | `PlayerInfo::SetTravelDestination` (`PlayerInfo.h:348`) |
| `SPAWN_FLEET` | `GameData::Fleets().Find(name)`. If `arrive`: `Fleet::Enter(*player.GetSystem(), newShips)` (`Fleet.h:64`, `Fleet.cpp:191`); else `Fleet::Place(system, newShips)` (`Fleet.cpp:385`). For a government override, `Ship::SetGovernment` (`Ship.h:250`) on each new ship. Record tags. Only inside `EngineFrame`, while flying |
| `APPLY_EVENT` | Parse the text into `DataNode`s (`DataFile(std::istream&)`), then `PlayerInfo::AddChanges(list<DataNode>&)` (`PlayerInfo.h:119`, `PlayerInfo.cpp:751`). Deferred to `PanelFrame` when called in flight (6.1). Afterwards the package forgets cached handles' derived data: nothing in the core, the world epoch in the caching layer |
| `BUY_SHIP` | `PlayerInfo::BuyShip(model, name)` (`PlayerInfo.h:190`, `PlayerInfo.cpp:1333`): the shipyard's own purchase, with its price, depreciation and stock records. Landed only. Check licences first with `PlayerInfo::HasLicense` (`PlayerInfo.h:172`) against the model's `Licenses()` |
| `PARK_SHIP` | `PlayerInfo::ParkShip(ship, on)` (`PlayerInfo.h:197`, `PlayerInfo.cpp:1467`). Refuse the flagship and disabled ships, as the info panel does |
| `REMOVE_SHIP` | `PlayerInfo::DisownShip(ship)` (`PlayerInfo.h:196`, `PlayerInfo.cpp:1450`). Refuse a ship carrying mission cargo or passengers (`CargoHold::MissionCargoSize`, `CargoHold.h:62`), and the flagship unless another ship can take over |
| `GIVE_OUTFIT` | `Ship::AddOutfit(outfit, count)` (`Ship.h:526`, `Ship.cpp:4110`), then `PlayerInfo::UpdateCargoCapacities()` (`PlayerInfo.h:221`). Landed, player's ships only |
| `GRANT_LICENSE` | `PlayerInfo::AddLicense` (`PlayerInfo.h:170`, `PlayerInfo.cpp:1157`) |
| `mod.data` | `ModStorage` (section 11) |

### 18.4 Observation sources

| Observation | Source |
|---|---|
| system, planet, date | `PlayerInfo::GetSystem()`, `GetPlanet()`, `GetDate()` |
| pilot | the conditions `mod api: pilot id` and `mod api: data version` (section 11.3) |
| missions | `PlayerInfo::Missions()` (`PlayerInfo.h:245`), by `Mission::UUID()` (`Mission.h:77`), with `IsFailed()` (`Mission.h:159`) |
| fleet | `PlayerInfo::Ships()`, by UUID; `Ship::Outfits()` |
| reputation | `Government::Reputation()` per government |
| ship events | the `events` list in `EngineFrame` |
| screen | `UI::Stack()` (`UI.h:65`), `UI::Top()` (`UI.h:82`) with `dynamic_cast` |

## 19. Implementation order and checkpoints

Each step ends with a checkpoint. Do not start the next step until it passes.

**Core 1: skeleton (4–5 weeks)**

1. **The header** (`es_api.h`, core parts first).
   - *Write:* sections 3.1–3.6 and the core op constants and structs, with static assertions.
   - *Check:* the header compiles as C11 (`cc -std=c11 -fsyntax-only`) and as C++17. A `bindgen` or Zig `@cImport` dry run parses it.
2. **Build plumbing.**
   - *Write:* `Modding.cmake` and the one line in `source/CMakeLists.txt`, with an empty `ModApi.cpp`.
   - *Check:* the game builds and runs unchanged.
3. **Arena, handles, tables, layout** (files 3–7).
   - *Check:* unit tests for the arena (chunking, reset, the 4 MiB limit), handles (encode, decode, stale generation), layout (the valid and invalid fixtures of section 20.1), and the table-sync test of section 13.2.
4. **`es_call` with `PING`, `API_INFO`, `LOG`, `LOOKUP`, `INTROSPECT`, `LIST_IDS`, `CONTEXT`** (files 8–9).
   - *Check:* unit tests call `es_call` directly with fuzzed sizes and canaries (section 20.1).
5. **The integration calls** (section 16.2, 16.3), with `ModApi` frame functions that only count frames.
   - *Check:* a debug log line every 600 frames in flight and while landed; none while in the main menu.
6. **Descriptors and registry** (files 10–11).
   - *Check:* unit tests for parsing, path rules, platform choice, the sorts (chains, diamonds, cycles), and dependency results.
7. **Native loading** (file 12): **the game loads an empty native mod and calls its init.**
   - *Check:* the test library (section 20.2), in a test plugin, logs from `es_mod_init` through `LOG`. The log shows the library path and hash. Disabling the plugin means no load. `ES_NO_NATIVE_MODS=1` means no load.
8. **Hooks and timing** (files 13–14): `HOOK_START`, `HOOK_STEP`, `HOOK_SHUTDOWN`, brackets, `ES_STOPPED`.
   - *Check:* the test mod counts steps into a condition (through `LOG` until writes exist), and the exit log shows its timing row.
9. **Observers** (file 15): `HOOK_DAY`, `HOOK_ENTER`, `HOOK_PILOT_LOADED`, `HOOK_DISCOVER`, and `REGISTER_MOD` for sub-mods.
   - *Check:* jump, land and take off. Each hook fires once, in order. Load another pilot: `HOOK_PILOT_LOADED` fires. A test sub-mod registered in `HOOK_DISCOVER` receives its own hooks.

**Core 2: records and the bus (4–5 weeks)**

10. **Records** (file 16), one record at a time, in this order: `PLAYER_STATE`, `SHIPS_IN_SYSTEM`/`SHIP_STATE`, `PLAYER_FLEET`, `SYSTEMS`/`SYSTEM_INFO`, `PLANET_INFO`, `GOVERNMENT_INFO`/`ATTITUDES`, `OUTFIT_INFO`, `ATTRS`, `MODEL_INFO`, `SHIP_OUTFITS`, `FLEET_INFO`, `COMMODITIES`/`MARKET`, the listings, `PLUGINS`, `CONDITIONS_GET`, `PLAYER_CARGO`, `TAG_STATS`/`KILLS`/`STEP_LOSSES`; `FIND`/`KEY_OF`.
    - *Check:* for each record, a unit test against a fixture world where possible. An in-game integration test: the test mod copies chosen fields into conditions, and the test asserts on them (section 20.3).
11. **Bus** (file 17).
    - *Check:* two test mods play ping-pong. There is no self-delivery, the cascade limit holds, the sender cannot be spoofed, and bad names are refused.

**Core 3: direct writes and actions (2–3 weeks)**

12. **Writes** (file 18): conditions, credits, reputation, messages; then the actions, one by one, each with its engine-safety guard.
    - *Check:* integration tests:
      - a test mod sets a condition in `HOOK_STEP`, and the test asserts it;
      - it spawns a fleet in flight, and the ships appear;
      - it buys a ship while landed, and the fleet grows;
      - `APPLY_EVENT` in flight resolves in the same frame;
      - every refused context answers `ES_REFUSED_CONTEXT`.
13. **Persistence** (file 19).
    - *Check:* set data, save, quit, reload, and the data is back. Load an older snapshot, and that snapshot's data comes back. Start a new pilot, and the data is empty. A pruning test removes the right versions.
14. **Port the test mod and a first real mod** (Appendix B).
    - *Check:* Diplomacy's core logic runs at L0 with the C test harness or with the ported Dado runtime.

**Optional layers (any order after the core):**
- queued writes, 3–4 weeks;
- Tier 1 traversal, 5–6 weeks;
- events, 1–2 weeks;
- UI kit, 4–5 weeks;
- settings, 1 week;
- caching, 2 weeks;
- routed calls, 2–3 weeks.

Each layer's checkpoint is its section of 20.4.

## 20. Test plan

### 20.1 Unit tests (`EndlessSkyModTests`, Catch2, `source/modding/tests/unit`)

Follow upstream's conventions (`tests/unit/README.md`): `SCENARIO`/`GIVEN`/`WHEN`/`THEN`, an anonymous namespace, and stubs instead of SDL calls.

- **Conformance of the game's `es_call`.** For every op in the `ModOps` table, run the following with zeroed or fuzzed structs:
  - in-sizes `0`, `4`, `8`, `min-1`, `min`, `current`, and `current+64` with a garbage tail;
  - out-sizes the same, with canary bytes after `out->size` that must survive;
  - `version` values 0, current and current+5.

  Expected:
  - `ES_BAD_STRUCT` below `min`;
  - success at or above it, with trailing fields defaulted;
  - `ES_UNKNOWN_OP` for unassigned codes and ops of missing layers;
  - `ES_UNKNOWN_TARGET` for address 9999;
  - the exact context allow/refuse result from the table;
  - `ES_STALE_HANDLE` for bumped generations;
  - `ES_TOO_SMALL` and then success, with an exact `needed`.
- **Table sync** (section 13.2).
- **Layout helper:** valid and invalid field lists; equal layout hashes for equal layouts.
- **Registry:** chains, diamonds, `before`/`after`, cycles broken deterministically (with the log line), missing `needs` (the mod still starts and is told `MISSING`), version mismatch, conflicts, name clash (first wins), late registration refused, withdraw and grouped withdraw, the same order over 100 shuffled runs.
- **Descriptors:** every key; path rules (absolute paths, `..`, symlink escape); platform choice; zipped plugin extraction (with a small zip fixture).
- **Arena and handles**, as in step 3.
- **Bus**, as in step 11.
- **Storage:** write, then rename atomically; version pointer semantics; fallback; pruning.

### 20.2 The test native library (`source/modding/tests/testmod/test_mod.c`)

A small C file built as a `MODULE` library by `Modding.cmake`, and copied into the integration test plugin's `lib/<platform>/` at build time. It:
- implements `es_mod_init`;
- registers `HOOK_START`, `HOOK_STEP`, `HOOK_ENTER`, `HOOK_DAY`, `HOOK_PILOT_LOADED` and `HOOK_DISCOVER`;
- in `HOOK_DISCOVER`, registers one sub-mod with its own name;
- performs scripted behaviour selected by a condition (`modapi test: scenario`), so one library serves every scenario:
  - copy record fields into conditions;
  - write;
  - spawn;
  - post and receive notifications;
  - withdraw;
  - fall back when a declared dependency is missing.

It is also the template for authors' own test mods: the smallest complete mod.

### 20.3 Integration tests (headless, real game)

Upstream's runner:
- `tests/integration/IntegrationTests.cmake` lists tests with `endless-sky --config <config> --tests`, and adds one CTest per test.
- Each test runs as `endless-sky --config <copy of config> --resources <resources> --test "<name>"` (`tests/integration/RunIntegrationTest.cmake`).
- On Linux CI, the whole suite runs under Xvfb with `tests/integration/run_tests_headless.sh`.
- Tests are `test` nodes in a plugin's `data/tests/*.txt`. Upstream's live in `tests/integration/config/plugins/integration-tests/data/tests/` (for example `tests_disown.txt`). They inject commands and keys, and assert on conditions.

**For the API**, `Modding.cmake` defines its own config folder, `source/modding/tests/integration/config/`, containing:
- `plugins/modapi-tests/plugin.txt` and `mod.txt` (declaring the test library);
- `lib/<platform>/`;
- `data/tests/*.txt`.

It registers the tests the same way as upstream's runner does, with the same `--config`/`--test` invocation. Upstream's own tests and config are not touched.

Each test:
1. sets `modapi test: scenario`;
2. loads a test save (from upstream's test-data mechanism, `test-data` nodes) or starts a pilot;
3. flies or lands with injected commands;
4. asserts on the conditions the test mod wrote.

**Scenarios (core):**
- the mod loads and its init runs;
- hook order on jump, land and take-off;
- pilot change;
- each record's chosen fields;
- each write and action, plus its refusal context;
- `APPLY_EVENT` in flight;
- persistence across save and load;
- the bus;
- a disabled plugin is not loaded;
- `ES_NO_NATIVE_MODS`;
- a pin mismatch;
- a missing dependency (the mod is told and falls back);
- withdraw.

### 20.4 Layer tests

| Layer | Tests |
|---|---|
| Queued writes | Merge rules; rollback on a stop; determinism (the same commit-log hash with loaders and mods registered in permuted orders); commit results |
| Tier 1 | Path syntax fuzzing; round-trip `DESCRIBE` against `DataFile(SaveToString())` for `Save`-backed types; references; event invalidation; stable paths checked against the current game data; `coverage.py` in CI |
| Events | Each observable event fires once, with exact or best-effort semantics as in section 8.2 |
| UI kit | Package panel push and pop; dialog answers; a condition trigger opens a screen |
| Caching | Hit and miss counts; invalidation triggers; pointer stability through a hook |

### 20.5 Bench

A test scenario with 20 copies of the test mod, each reading `SHIPS_IN_SYSTEM` and doing 10 writes per step. The timing report gives the per-step cost. Record it before and after each optional layer.

---

# Appendices

## Appendix A. Level 0 versus adopted features

### A.1 Classification summary

| Kind | Level 0 | Adopted (step) |
|---|---|---|
| **Hooks** | `HOOK_START`, `HOOK_PILOT_LOADED`, `HOOK_SHUTDOWN` (`atexit`, no world access), `HOOK_DISCOVER`, `HOOK_DAY`, `HOOK_ENTER`, `HOOK_STEP`, `HOOK_UI` (mod-owned slots), `HOOK_SETTING`, `HOOK_NOTIFICATION`, `HOOK_EVENTS`, `HOOK_COMMIT_RESULTS`, `HOOK_ROUTED` | `HOOK_SAVE` (A2), `HOOK_QUERY` (A7), `HOOK_KEY` (A9), `HOOK_UI` on vanilla-panel slots (A6–A9), shutdown with world access (A3) |
| **Records** | All core records, except the fields listed in the next column | `FLEET_INFO` averaged stats, `PLANET_INFO`/`SYSTEM_INFO` defense fleets, `MARKET.base_price` (A5); `OUTFITTER_SELECTION` (A7); listing `stock`/`note` (A13) |
| **Writable properties** | condition, credits, reputation, ship name, travel destination, messages, `mod.data`, `mod.setting` | `ship.hull`/`ship.shields` (A4); shop stock and notes (A13) |
| **Actions** | `SPAWN_FLEET`, `APPLY_EVENT`, `BUY_SHIP` (shipyard semantics), `PARK_SHIP`, `REMOVE_SHIP`, `RESET_KILLS`, `GIVE_OUTFIT`, `GRANT_LICENSE` | `OFFER_JOB` (A10), `INTEGRATE_OUTFIT` and delivery without shop side effects (A13) |
| **Events** | Ship events (exact), system entered, landed, took off, day, pilot loaded, mission accepted or removed, reputation, death (all exact); mission completed or failed, purchases (best effort) | Exact mission outcome and purchases (A12); saved (A2) |
| **UI slots** | `mod.screen`, `mod.panel`, `dialog`, `mods.page` (reached by condition trigger) | `planet.button` (A6), `outfitter.button`/`shipyard.button` (A7), `map.layer`/`map.detail` (A8), `hud.status` (A9), menu entry (A11) |
| **Tier 1** | All `Save`-backed types fully; definitions per section 18.2 | The missing definition keys (A5) |
| **Infrastructure** | `mod.txt` descriptors, sidecar persistence, lazy start, `atexit` shutdown, environment or preference kill switch | `mod` nodes in `data/` (A1), mod data in the pilot file (A2), early start, explicit shutdown and a command-line flag (A3), plugin-list marking (A11) |

### A.2 Adoption steps

Each step is an engine change that could be made on its own. Upstream line counts are rough.

| Step | What the engine adds | Upstream size | Unlocks |
|---|---|---|---|
| **A1. `mod` nodes in data files** | A two-line branch in `UniverseObjects::LoadFile` forwarding `mod` nodes to the package (section 16.6) | 3 lines, 1 file | `mod` nodes in `data/*.txt`, with no warning |
| **A2. Mod data in the pilot file** | `PlayerInfo::Save`/`Load`/`Clear` call the package (section 16.7) | ~8 lines, 1 file | `HOOK_SAVE`; data saved inside the pilot; exact pilot-change notification |
| **A3. Explicit lifecycle** | `ModApi::Init()` after `GameData::FinishLoading()`; a shutdown guard in `main.cpp`; a `--no-native-mods` flag | ~6 lines, 2 files | Start before the main menu; `HOOK_SHUTDOWN` with world access; command-line kill switch |
| **A4. Ship level setters** | Public `Ship::SetHull`/`SetShields` (clamped), or an equivalent | ~6 lines, 2 files | `ship.hull`, `ship.shields` writes |
| **A5. Definition accessors** | `Fleet::Variants()`, `Planet::DefenseFleets()`, `System::BasePrice()`, and getters for phrase, news and person content and government penalty tables | 2–6 lines each, about 8 files | Fleet stats, defense fleets, base prices, fuller Tier 1 for definitions |
| **A6. Planet-screen slot** | `PlanetPanel` asks the package for button labels, draws them, and forwards clicks and keys; an area where a package panel is swapped in, like the bank or trading panel | 25–50 lines, 2 files | `planet.button`; mod screens from the planet screen |
| **A7. Shop slots** | `OutfitterPanel`/`ShipyardPanel` draw package buttons, ask the package whether each is enabled (`HOOK_QUERY`), and expose the selected ships and item | ~40 lines, 3 files | `outfitter.button`, `shipyard.button`, `OUTFITTER_SELECTION` |
| **A8. Map overlays** | `MapPanel::Draw` and `MapDetailPanel::Draw` call the package with the map's centre and zoom | ~8 lines, 2 files | `map.layer`, `map.detail` |
| **A9. HUD and keys** | `MainPanel::Draw` calls the package for a HUD layer; `MainPanel`/`PlanetPanel` key handling offers unhandled keys to the package; key rows in the controls list | ~15 lines, 3–4 files | `hud.status`, `HOOK_KEY`, `KEY_DECLARE` |
| **A10. Job board** | A public way to add a mission to the landed planet's job board (`PlayerInfo::AddJob`) | ~20 lines, 2 files | `OFFER_JOB` |
| **A11. Menu and plugin list** | A "Mods" entry in the main menu or preferences; a native-code marker in the plugin list | ~13 lines, 2–3 files | Mods screen without a trigger; visibility |
| **A12. Event emissions** | One call each where a mission completes or fails, where a shop buys or sells, and where the game saves | ~1–2 lines per emission, 3–4 files | Exact mission-outcome and purchase events |
| **A13. Gameplay features** (engine features, not API features) | Shop stock tracking and its enforcement, with saved state; ship delivery without shop side effects; outfit integration (permanently installed, lighter outfits); used-hull buy-back | 30–200 lines each, many files | Stock properties and listing fields; `BUY_SHIP` delivery mode; `INTEGRATE_OUTFIT` |

Each step registers a feature name (`adopted:<step name>`) in `ModIds`, so mods can test for it with `LOOKUP(feature, …)`.

## Appendix B. Porting the existing loader, SDK and mods

The new API replaces API 10 entirely. There is no compatibility layer.

**The Dado loader (es-modloader)** becomes a plugin named `Dado`:
- **Layout:** `plugin.txt`, `mod.txt` (the `mod "dado"` node with a `library` per platform, and `hooks discover start shutdown`), `lib/<platform>/libesdado.*`.
- **C side** (`src/loader.c`):
  - exports `es_mod_init` instead of `es_loader_init`;
  - implements `HOOK_DISCOVER` by scanning each source's `scripts/*.js`, and calls `REGISTER_MOD` for each script mod with `dispatch = NULL`. The hooks the mod's class defines become its registered hook ops, replacing today's per-hook probing;
  - routes each hook call by its address to that script's engine;
  - drops `hook_timing`, because the game brackets every hook;
  - keeps the watchdog and its limits, and returns `ES_STOPPED` when it stops a script.
- **Bindings:** the generated host shim (`tools/gen-host-shim.cmake`) is replaced by Dado's `foreign` import of `es_api.h`, which reads the hand-written header directly.
- **The JS-facing API** (`harness/Game.dados`) is rewritten by hand over the new ops: record-returning methods plus the API 10 method names that map directly (for example `game.hull(i)` reads the `SHIPS_IN_SYSTEM` record). This is the loader's own work, outside the game.

**The SDK (endless-sky-mod-sdk).**
- Its typings (`js/es.d.ts`) are written by hand, or produced by the loader's own tooling from `Game.dados`, as `tools/sync.mjs` does today.
- `FakeGame` is updated to the new methods and to direct-write semantics.
- Nothing in the SDK is generated by the game.

**The three mods at Level 0, and what each loses without adopted features:**

| Mod | Works at L0 | Needs adoption |
|---|---|---|
| **Corporations** | Conditions; planet, system and government reads; the player's fleet (names, models, parked state); park and remove ships; model cost; outfit categories and counts; planet services; its screen (UI layer), opened from landing or a condition trigger set by its own spaceport conversation | Job offers (A10); shipyard and outfitter stock (A13); outfitter button and selection (A7); planet button (A6) |
| **Diplomacy** | The war and faction simulation on `HOOK_DAY`/`HOOK_ENTER`; reputation writes; fleet strength (`Fleet::Strength`); kill counts (from ship events); messages; its panels and charts (UI layer), opened by condition trigger or on landing | Fleet stat breakdowns and defense fleets (A5); map overlays (A8); planet button (A6) |
| **Outfit Integration** | Reading ships, outfits and attributes; dialogs (UI layer) | Its core feature: outfit integration (A13) and the outfitter button (A7). Without them, it has nothing to do at L0 |

**API 10 calls → new ops** (grouped):

| API 10 calls | New ops |
|---|---|
| per-ship scalars | `SHIPS_IN_SYSTEM`/`SHIP_STATE` |
| `system_*`, `planet_count`/`planet_at` | `SYSTEMS`/`SYSTEM_INFO` |
| `planet_*` | `PLANET_INFO` |
| `fleet_*` | `PLAYER_FLEET`, `FLEET_INFO` |
| `outfit_*` | `OUTFIT_INFO`, `ATTRS` |
| `model_*` | `MODEL_INFO` |
| `shipyard_*` | `SHIPYARD_LISTING` |
| `condition*` | `CONDITIONS_GET`, `SET player.condition` |
| `set_reputation`/`reputation`/`attitude` | `SET government.reputation`, `GOVERNMENT_INFO`, `GOVERNMENT_ATTITUDES` |
| `spawn` | `SPAWN_FLEET` |
| `change` | `APPLY_EVENT` |
| `buy_ship` | `BUY_SHIP` |
| `ship_park` | `PARK_SHIP` |
| `ship_remove` | `REMOVE_SHIP` |
| `losses`/`player_kills`/`tag_strength` | `STEP_LOSSES`/`KILLS`/`TAG_STATS` |
| `trade_*`, `commodity_*` | `MARKET`, `COMMODITIES` |
| `cargo` | `PLAYER_CARGO` |
| `data`/`set_data` | `STORAGE_GET`, `SET mod.data` |
| `notify`/`listen`/`unlisten` | the bus ops |
| `api_has` | `LOOKUP(feature)` |
| `timing_section` | `TIMING_SECTION` |
| `log` | `LOG` |
| `message` | `APPEND game.messages` |
| panels and screens | UI layer |
| map, planet and outfitter buttons; stock; integration; jobs | adopted features |

## Appendix C. Risks and open questions

**Risks**

1. **Direct writes make results depend on mod order.** That is acceptable for the core, but mods that interact through shared state may behave differently when the order changes. The queued-writes layer fixes this for mods that opt in.
2. **Observation edge cases.**
   - Pilot detection relies on two conditions, which a mission or plugin could overwrite. The names are namespaced (`mod api: …`), and a mismatch is logged.
   - Purchases cannot be told apart from gifts (best-effort events).
3. **`atexit` shutdown** runs after some statics may be gone, so `HOOK_SHUTDOWN` has no world. A mod that needs to flush must do so as it goes (the sidecar is written on change).
4. **Upstream drift.** Getter or serializer changes upstream can break fill functions (a compile error, which is good) or Tier 1 paths (stable paths and the coverage check mitigate this).
5. **No HUD and no planet button at L0.** Mod UI is modal and reached by triggers. The UX is clunky until A6 and A9 are adopted.
6. **Native code arriving with plugins.** Installing a plugin is the only gate. That is the same trust as the game executable; it is mitigated by visibility and documentation, not by prompts.
7. **Hand-maintained tables.** The `ModOps`/`ModIds` tables can drift from the header. The sync test (section 13.2) must run in CI.
8. **Performance without a cache.** Many mods reading large lists every step costs a fraction of a millisecond each (section 12). The caching layer is the remedy.

**Open questions**

1. Should `APPLY_EVENT` in flight be refused outright instead of deferred to `PanelFrame`, to keep the core free of any pending results?
2. Should mods be allowed to register late (hot reload)? This is excluded from API 11.
3. Is `mod.txt` at the plugin root the right L0 location, or should the package also read `data/*.mod` files (an extension the engine ignores) so descriptors sit with the other data?
4. Should `BUY_SHIP` at L0 use `PlayerInfo::GiftShip` plus `Account::AddCredits`, avoiding shop side effects, instead of `BuyShip`? `GiftShip` records the ship as gifted, which upstream treats specially.
5. Pruning of the sidecar: is scanning `Files::Saves()` at startup acceptable for players with very many saves?
6. Is the 8-bit handle-type field enough? It gives 255 types; there are about 20 in API 11.
7. Which adoption steps should be proposed upstream first? A1, A2 and A8 are the smallest with the most effect.

