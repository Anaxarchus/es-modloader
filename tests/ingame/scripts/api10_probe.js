// dados/runtime.js
var MAX_SAFE = 9007199254740991;
var MAX_SAFE_N = 9007199254740991n;
function canon(r) {
  return r >= -MAX_SAFE_N && r <= MAX_SAFE_N ? Number(r) : r;
}
function wide(a, b, op) {
  const x = BigInt(a), y = BigInt(b);
  switch (op) {
    case 0:
      return canon(BigInt.asIntN(64, x + y));
    case 1:
      return canon(BigInt.asIntN(64, x - y));
    case 2:
      return canon(BigInt.asIntN(64, x * y));
    case 3:
      return canon(BigInt.asIntN(64, x / y));
    case 4:
      return canon(BigInt.asIntN(64, x % y));
    case 5:
      return canon(BigInt.asIntN(64, x & y));
    case 6:
      return canon(BigInt.asIntN(64, x | y));
    case 7:
      return canon(BigInt.asIntN(64, x ^ y));
    default:
      return canon(BigInt.asIntN(64, x & ~y));
  }
}
function __dados_int_add(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    if (r >= -MAX_SAFE && r <= MAX_SAFE) return r + 0;
  }
  return wide(a, b, 0);
}
function zero_divisor(b) {
  if (b === 0 || b === 0n) throw __dados_fault("integer division by zero");
}
function __dados_int_mod(a, b) {
  zero_divisor(b);
  if (typeof a === "number" && typeof b === "number") return a % b + 0;
  return wide(a, b, 4);
}
function __dados_int_of_float(x) {
  if (x !== x) return 0;
  if (x >= 9223372036854776e3) return 9223372036854775807n;
  if (x < -9223372036854776e3) return -9223372036854775808n;
  const t = Math.trunc(x);
  if (t >= -MAX_SAFE && t <= MAX_SAFE) return t + 0;
  return BigInt(t);
}
function __dados_str_int(a) {
  return String(a);
}
var DEFAULT_CODE = 70;
var ERROR_CODE = -2147483648;
function code_of(code) {
  if (code === 0) return ERROR_CODE;
  return typeof code === "number" && (code | 0) === code ? code : DEFAULT_CODE;
}
var __dados_Location = class {
  constructor(file, line, column, fn) {
    this.file = file;
    this.line = line;
    this.column = column;
    this.function = fn;
    Object.freeze(this);
  }
};
var __dados_nowhere = new __dados_Location("", 0, 0, "");
function __dados_str_location(l) {
  return l.file === "" ? "<unknown>" : l.file + ":" + l.line + ":" + l.column;
}
function at_line(l) {
  return "  at " + __dados_str_location(l) + (l.function === "" ? "" : " (" + l.function + ")");
}
var modules = /* @__PURE__ */ new Map();
function stack_text(above) {
  const holder = {};
  if (typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(holder, above);
    return holder.stack;
  }
  return new Error().stack;
}
var FRAME = /^\s*at (?:.* \()?(.+?):(\d+):(\d+)\)?$/;
function frames_of(text) {
  const out = [];
  if (typeof text !== "string") return out;
  for (const line of text.split("\n")) {
    const m = FRAME.exec(line);
    if (m !== null) out.push([m[1], Number(m[2])]);
  }
  return out;
}
function __dados_lines(file, fns, table, files) {
  const here = frames_of(stack_text(__dados_lines));
  if (here.length > 0) modules.set(here[0][0], { file, fns, table, files });
}
function position(frame) {
  const m = modules.get(frame[0]);
  if (m === void 0) return null;
  const t = m.table;
  let lo = 0, hi = t.length / 4 - 1, found = -1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (t[mid * 4] <= frame[1]) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const fn = t[found * 4 + 3];
  if (found < 0 || fn < 0) return null;
  const file = m.files === void 0 ? m.file : m.files[fn];
  return new __dados_Location(file, t[found * 4 + 1], t[found * 4 + 2], m.fns[fn]);
}
var __dados_Error = class {
  constructor(message, code, location) {
    this.message = message;
    this.code = code_of(code);
    this.__at = location;
    this.__raw = null;
    this.__frames = null;
  }
  __mapped() {
    if (this.__frames === null) {
      const out = [];
      for (const f of frames_of(this.__raw)) {
        const p = position(f);
        if (p !== null) out.push(p);
      }
      this.__frames = out;
    }
    return this.__frames;
  }
  get location() {
    if (this.__at === null) {
      const f = this.__mapped();
      this.__at = f.length > 0 ? f[0] : __dados_nowhere;
    }
    return this.__at;
  }
  get trace() {
    const f = this.__mapped();
    const at = this.location;
    const first = f.length > 0 && f[0].file === at.file && f[0].line === at.line;
    return f.slice(first ? 1 : 0);
  }
  toString() {
    return "error " + this.code + ": " + this.message;
  }
  // The report's frame lines: the location, then the trace.
  get stack() {
    let out = at_line(this.location) + "\n";
    for (const l of this.trace) out += at_line(l) + "\n";
    return out;
  }
};
function __dados_fault(message) {
  const e = new __dados_Error(message, DEFAULT_CODE, null);
  e.__raw = stack_text(__dados_fault);
  return e;
}
function __dados_failure(thrown) {
  if (thrown instanceof __dados_Error) return thrown;
  let message;
  let code = DEFAULT_CODE;
  let raw = null;
  if (thrown instanceof Error) {
    message = String(thrown.message);
    if (typeof thrown.code === "number") code = thrown.code;
    if (typeof thrown.stack === "string") raw = thrown.stack;
  } else {
    try {
      message = typeof thrown === "string" ? thrown : String(thrown);
    } catch (_) {
      message = "a thrown value that has no text";
    }
  }
  const e = new __dados_Error(message, code, null);
  e.__raw = raw;
  return e;
}
Object.defineProperty(globalThis, "__dados_failure", { value: __dados_failure, configurable: true });

// es/Mod.js
var Mod$;
function Mod$class() {
  if (Mod$ === void 0) {
    class Mod2 {
      constructor(...args) {
        this.$fields();
        this.init(...args);
      }
      init() {
      }
      $fields() {
      }
      api_version() {
        return 10;
      }
      min_api() {
        return 1;
      }
      name() {
        return "unnamed mod";
      }
      on_load(game) {
        return;
      }
      on_step(game, step) {
        return;
      }
      on_day(game, day) {
        return;
      }
      on_enter(game, system) {
        return;
      }
      on_planet_button(game) {
        return;
      }
      on_panel(game, button) {
        return;
      }
      can_outfitter(game, outfit) {
        return true;
      }
      on_outfitter(game, outfit) {
        return;
      }
      on_confirm(game, token) {
        return;
      }
      on_panel_row(game, row) {
        return;
      }
      on_panel_header(game, column) {
        return;
      }
      on_number(game, token, value) {
        return;
      }
      on_save(game) {
        return;
      }
      on_pilot_loaded(game) {
        return;
      }
      on_notification(game, name, payload, sender) {
        return;
      }
      log(game, text) {
        game.log(this.name() + ": " + text);
      }
      every(step, seconds) {
        let period = __dados_int_of_float(seconds * 60);
        if (period < 1) {
          return true;
        }
        return __dados_int_mod(step, period) === 0;
      }
      player_ships(game) {
        let out = [];
        {
          const end$1 = game.ship_count();
          for (let i = 0; i < end$1; i = __dados_int_add(i, 1)) {
            if (game.is_player(i) && !game.is_disabled(i)) {
              out.push(i);
            }
          }
        }
        return out;
      }
    }
    Mod$ = Mod2;
  }
  return Mod$;
}
var Mod = Mod$class();
__dados_lines("es/Mod.dados", ["es.Mod.api_version", "es.Mod.min_api", "es.Mod.name", "es.Mod.on_load", "es.Mod.on_step", "es.Mod.on_day", "es.Mod.on_enter", "es.Mod.on_planet_button", "es.Mod.on_panel", "es.Mod.can_outfitter", "es.Mod.on_outfitter", "es.Mod.on_confirm", "es.Mod.on_panel_row", "es.Mod.on_panel_header", "es.Mod.on_number", "es.Mod.on_save", "es.Mod.on_pilot_loaded", "es.Mod.on_notification", "es.Mod.log", "es.Mod.every", "es.Mod.player_ships"], [
  5,
  0,
  0,
  -1,
  20,
  26,
  5,
  0,
  21,
  0,
  0,
  -1,
  24,
  34,
  5,
  1,
  25,
  0,
  0,
  -1,
  28,
  38,
  5,
  2,
  29,
  0,
  0,
  -1,
  32,
  42,
  5,
  3,
  33,
  0,
  0,
  -1,
  36,
  46,
  5,
  4,
  37,
  0,
  0,
  -1,
  40,
  51,
  5,
  5,
  41,
  0,
  0,
  -1,
  44,
  56,
  5,
  6,
  45,
  0,
  0,
  -1,
  48,
  61,
  5,
  7,
  49,
  0,
  0,
  -1,
  52,
  65,
  5,
  8,
  53,
  0,
  0,
  -1,
  56,
  71,
  5,
  9,
  57,
  0,
  0,
  -1,
  60,
  76,
  5,
  10,
  61,
  0,
  0,
  -1,
  64,
  81,
  5,
  11,
  65,
  0,
  0,
  -1,
  68,
  86,
  5,
  12,
  69,
  0,
  0,
  -1,
  72,
  91,
  5,
  13,
  73,
  0,
  0,
  -1,
  76,
  95,
  5,
  14,
  77,
  0,
  0,
  -1,
  80,
  108,
  5,
  15,
  81,
  0,
  0,
  -1,
  84,
  115,
  5,
  16,
  85,
  0,
  0,
  -1,
  88,
  121,
  5,
  17,
  89,
  0,
  0,
  -1,
  92,
  125,
  5,
  18,
  93,
  0,
  0,
  -1,
  96,
  129,
  5,
  19,
  97,
  130,
  5,
  19,
  98,
  131,
  9,
  19,
  99,
  130,
  5,
  19,
  100,
  132,
  5,
  19,
  101,
  0,
  0,
  -1,
  104,
  136,
  5,
  20,
  105,
  137,
  5,
  20,
  108,
  138,
  9,
  20,
  109,
  139,
  13,
  20,
  110,
  138,
  9,
  20,
  111,
  137,
  5,
  20,
  113,
  140,
  5,
  20,
  114,
  0,
  0,
  -1
]);

// main/Api10Probe.js
var Api10Probe = class extends Mod$class() {
  $fields() {
    super.$fields();
  }
  name() {
    return "api10 probe";
  }
  record(game, key, value) {
    game.set_condition("test: api10 " + key, value);
  }
  on_load(game) {
    game.listen("test10.*");
  }
  on_pilot_loaded(game) {
    this.record(game, "pilot loaded", __dados_int_add(game.condition("test: api10 pilot loaded"), 1));
  }
  on_save(game) {
    if (game.condition("test: api10") === 0) {
      return;
    }
    game.set_data("saved", "yes");
    this.record(game, "saves", __dados_int_add(game.condition("test: api10 saves"), 1));
    game.notify("test10.ping", "after save");
  }
  on_enter(game, system) {
    if (game.condition("test: api10") === 0 || game.planet() === "") {
      return;
    }
    game.timing_section("trade");
    this.record(game, "price Alpha Food", game.trade_price("Alpha", "Food"));
    this.record(game, "base Alpha Food", game.trade_base_price("Alpha", "Food"));
    this.record(game, "price Delta Metal", game.trade_price("Delta", "Metal"));
    this.record(game, "price unknown", __dados_int_add(__dados_int_add(game.trade_price("Nowhere", "Food"), game.trade_price("Alpha", "Gold")), game.trade_base_price("Nowhere", "Food")));
    let n = game.commodity_count();
    let list = "";
    {
      const end$1 = n;
      for (let k = 0; k < end$1; k = __dados_int_add(k, 1)) {
        if (k > 0) {
          list = list + ",";
        }
        list = list + game.commodity_name(k);
      }
    }
    this.record(game, "commodities " + __dados_str_int(n) + " " + list, 1);
    this.record(game, "commodity bad", game.commodity_name(n) === "" && game.commodity_name(-1) === "" ? 1 : 0);
    this.record(game, "cargo Food", game.cargo("Food"));
    this.record(game, "cargo Nope", game.cargo("Nope"));
    game.timing_section("stock");
    game.outfit_stock_on(true);
    game.set_outfit_stock("Alpha I", "Laser", 4);
    this.record(game, "outfit stock set", game.outfit_stock("Alpha I", "Laser"));
    game.set_outfit_stock("Alpha I", "Laser", -5);
    this.record(game, "outfit stock untracked", game.outfit_stock("Alpha I", "Laser"));
    game.set_outfit_stock("Nowhere", "Laser", 3);
    game.set_outfit_stock("Alpha I", "Nope", 3);
    this.record(game, "outfit stock unknown", __dados_int_add(game.outfit_stock("Nowhere", "Laser"), game.outfit_stock("Alpha I", "Nope")));
    game.set_outfit_stock("Alpha I", "Battery", 2);
    game.timing_section("");
    this.record(game, "park in enter", game.ship_park("uuid-b", true) ? 1 : 0);
    this.record(game, "has notify", game.has("notify") ? 1 : 0);
    this.record(game, "has nope", game.has("nope") ? 1 : 0);
  }
  on_planet_button(game) {
    if (game.condition("test: api10 old") !== 0) {
      this.record(game, "old price", game.trade_price("Alpha", "Food"));
      this.record(game, "old base", game.trade_base_price("Alpha", "Food"));
      this.record(game, "old commodities", game.commodity_count());
      this.record(game, "old name", game.commodity_name(0) === "" ? 1 : 0);
      this.record(game, "old outfit stock", game.outfit_stock("Alpha I", "Laser"));
      game.outfit_stock_on(true);
      game.set_outfit_stock("Alpha I", "Laser", 3);
      this.record(game, "old park", game.ship_park("uuid-b", true) ? 1 : 0);
      this.record(game, "old remove", game.ship_remove("uuid-b") ? 1 : 0);
      this.record(game, "old parked", game.ship_parked("uuid-b") ? 1 : 0);
      this.record(game, "old cargo", game.cargo("Food"));
      game.listen("x.*");
      game.unlisten("x.*");
      game.timing_section("x");
      this.record(game, "old notify", game.notify("x.y", "") ? 1 : 0);
      this.record(game, "old has", game.has("notify") ? 1 : 0);
      this.record(game, "old done", 1);
      return;
    }
    if (game.condition("test: api10") === 0) {
      return;
    }
    this.record(game, "park b", game.ship_park("uuid-b", true) ? 1 : 0);
    this.record(game, "parked b", game.ship_parked("uuid-b") ? 1 : 0);
    this.record(game, "park flagship", game.ship_park("uuid-a", true) ? 1 : 0);
    this.record(game, "unpark b", game.ship_park("uuid-b", false) && !game.ship_parked("uuid-b") ? 1 : 0);
    this.record(game, "remove c", game.ship_remove("uuid-c") ? 1 : 0);
    this.record(game, "remove unknown", game.ship_remove("uuid-z") ? 1 : 0);
    this.record(game, "notify ping", game.notify("test10.ping", "reply") ? 1 : 0);
  }
  on_panel(game, button) {
    if (game.condition("test: api10") === 0) {
      return;
    }
    if (button === 1) {
      game.notify("test10.ping", "loop");
    } else if (button === 2) {
      let accepted = 0;
      {
        const end$2 = 300;
        for (let k = 0; k < end$2; k = __dados_int_add(k, 1)) {
          if (game.notify("test10.flood", __dados_str_int(k))) {
            accepted = __dados_int_add(accepted, 1);
          }
        }
      }
      this.record(game, "flood accepted", accepted);
    } else if (button === 3) {
      this.record(game, "bad name", game.notify("bad name!", "") ? 1 : 0);
    }
  }
  on_notification(game, name, payload, sender) {
    this.record(game, "got " + name + "|" + payload + "|" + sender, 1);
    this.record(game, "notes", __dados_int_add(game.condition("test: api10 notes"), 1));
    if (name === "test10.pong" && payload === "loop") {
      game.notify("test10.ping", "loop");
    }
  }
  on_step(game, step) {
    if (game.condition("test: api10") === 0) {
      return;
    }
    this.record(game, "energy fraction", __dados_int_of_float(game.energy_fraction(0) * 100));
    this.record(game, "fuel fraction", __dados_int_of_float(game.fuel_fraction(0) * 100));
  }
};
__dados_lines("api10_probe/api10_probe.dados", ["main.Api10Probe.name", "main.Api10Probe.record", "main.Api10Probe.on_load", "main.Api10Probe.on_pilot_loaded", "main.Api10Probe.on_save", "main.Api10Probe.on_enter", "main.Api10Probe.on_planet_button", "main.Api10Probe.on_panel", "main.Api10Probe.on_notification", "main.Api10Probe.on_step"], [
  6,
  0,
  0,
  -1,
  12,
  13,
  5,
  0,
  13,
  0,
  0,
  -1,
  16,
  16,
  5,
  1,
  17,
  0,
  0,
  -1,
  20,
  19,
  5,
  2,
  21,
  0,
  0,
  -1,
  24,
  22,
  5,
  3,
  25,
  0,
  0,
  -1,
  28,
  25,
  5,
  4,
  29,
  26,
  9,
  4,
  30,
  25,
  5,
  4,
  31,
  27,
  5,
  4,
  32,
  28,
  5,
  4,
  33,
  30,
  5,
  4,
  34,
  0,
  0,
  -1,
  37,
  33,
  5,
  5,
  38,
  34,
  9,
  5,
  39,
  33,
  5,
  5,
  40,
  35,
  5,
  5,
  41,
  36,
  5,
  5,
  42,
  37,
  5,
  5,
  43,
  38,
  5,
  5,
  44,
  39,
  5,
  5,
  45,
  40,
  5,
  5,
  46,
  41,
  5,
  5,
  47,
  42,
  5,
  5,
  50,
  43,
  9,
  5,
  51,
  44,
  13,
  5,
  52,
  43,
  9,
  5,
  53,
  45,
  9,
  5,
  54,
  42,
  5,
  5,
  56,
  46,
  5,
  5,
  57,
  47,
  5,
  5,
  58,
  48,
  5,
  5,
  59,
  49,
  5,
  5,
  60,
  50,
  5,
  5,
  61,
  51,
  5,
  5,
  62,
  52,
  5,
  5,
  63,
  53,
  5,
  5,
  64,
  54,
  5,
  5,
  65,
  55,
  5,
  5,
  66,
  56,
  5,
  5,
  67,
  57,
  5,
  5,
  68,
  58,
  5,
  5,
  69,
  59,
  5,
  5,
  70,
  60,
  5,
  5,
  71,
  61,
  5,
  5,
  72,
  62,
  5,
  5,
  73,
  63,
  5,
  5,
  74,
  0,
  0,
  -1,
  77,
  66,
  5,
  6,
  78,
  68,
  9,
  6,
  79,
  69,
  9,
  6,
  80,
  70,
  9,
  6,
  81,
  71,
  9,
  6,
  82,
  72,
  9,
  6,
  83,
  73,
  9,
  6,
  84,
  74,
  9,
  6,
  85,
  75,
  9,
  6,
  86,
  76,
  9,
  6,
  87,
  77,
  9,
  6,
  88,
  78,
  9,
  6,
  89,
  79,
  9,
  6,
  90,
  80,
  9,
  6,
  91,
  81,
  9,
  6,
  92,
  82,
  9,
  6,
  93,
  83,
  9,
  6,
  94,
  84,
  9,
  6,
  95,
  85,
  9,
  6,
  96,
  66,
  5,
  6,
  97,
  86,
  5,
  6,
  98,
  87,
  9,
  6,
  99,
  86,
  5,
  6,
  100,
  88,
  5,
  6,
  101,
  89,
  5,
  6,
  102,
  90,
  5,
  6,
  103,
  91,
  5,
  6,
  104,
  92,
  5,
  6,
  105,
  93,
  5,
  6,
  106,
  94,
  5,
  6,
  107,
  0,
  0,
  -1,
  110,
  97,
  5,
  7,
  111,
  98,
  9,
  7,
  112,
  97,
  5,
  7,
  113,
  99,
  5,
  7,
  114,
  100,
  9,
  7,
  115,
  99,
  5,
  7,
  116,
  102,
  9,
  7,
  117,
  103,
  9,
  7,
  120,
  104,
  13,
  7,
  121,
  105,
  17,
  7,
  122,
  104,
  13,
  7,
  123,
  103,
  9,
  7,
  125,
  106,
  9,
  7,
  126,
  99,
  5,
  7,
  127,
  108,
  9,
  7,
  128,
  99,
  5,
  7,
  129,
  0,
  0,
  -1,
  132,
  111,
  5,
  8,
  133,
  112,
  5,
  8,
  134,
  113,
  5,
  8,
  135,
  114,
  9,
  8,
  136,
  113,
  5,
  8,
  137,
  0,
  0,
  -1,
  140,
  117,
  5,
  9,
  141,
  118,
  9,
  9,
  142,
  117,
  5,
  9,
  143,
  119,
  5,
  9,
  144,
  120,
  5,
  9,
  145,
  0,
  0,
  -1
]);
export {
  Api10Probe
};
