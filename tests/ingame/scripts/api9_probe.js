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
        return 9;
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
__dados_lines("es/Mod.dados", ["es.Mod.api_version", "es.Mod.name", "es.Mod.on_load", "es.Mod.on_step", "es.Mod.on_day", "es.Mod.on_enter", "es.Mod.on_planet_button", "es.Mod.on_panel", "es.Mod.can_outfitter", "es.Mod.on_outfitter", "es.Mod.on_confirm", "es.Mod.on_panel_row", "es.Mod.on_panel_header", "es.Mod.on_number", "es.Mod.log", "es.Mod.every", "es.Mod.player_ships"], [
  5,
  0,
  0,
  -1,
  20,
  25,
  5,
  0,
  21,
  0,
  0,
  -1,
  24,
  29,
  5,
  1,
  25,
  0,
  0,
  -1,
  28,
  33,
  5,
  2,
  29,
  0,
  0,
  -1,
  32,
  37,
  5,
  3,
  33,
  0,
  0,
  -1,
  36,
  42,
  5,
  4,
  37,
  0,
  0,
  -1,
  40,
  47,
  5,
  5,
  41,
  0,
  0,
  -1,
  44,
  52,
  5,
  6,
  45,
  0,
  0,
  -1,
  48,
  56,
  5,
  7,
  49,
  0,
  0,
  -1,
  52,
  62,
  5,
  8,
  53,
  0,
  0,
  -1,
  56,
  67,
  5,
  9,
  57,
  0,
  0,
  -1,
  60,
  72,
  5,
  10,
  61,
  0,
  0,
  -1,
  64,
  77,
  5,
  11,
  65,
  0,
  0,
  -1,
  68,
  82,
  5,
  12,
  69,
  0,
  0,
  -1,
  72,
  86,
  5,
  13,
  73,
  0,
  0,
  -1,
  76,
  90,
  5,
  14,
  77,
  0,
  0,
  -1,
  80,
  94,
  5,
  15,
  81,
  95,
  5,
  15,
  82,
  96,
  9,
  15,
  83,
  95,
  5,
  15,
  84,
  97,
  5,
  15,
  85,
  0,
  0,
  -1,
  88,
  101,
  5,
  16,
  89,
  102,
  5,
  16,
  92,
  103,
  9,
  16,
  93,
  104,
  13,
  16,
  94,
  103,
  9,
  16,
  95,
  102,
  5,
  16,
  97,
  105,
  5,
  16,
  98,
  0,
  0,
  -1
]);

// main/Api9Probe.js
var Api9Probe = class extends Mod$class() {
  $fields() {
    super.$fields();
  }
  name() {
    return "api9 probe";
  }
  on_enter(game, system) {
    if (game.condition("test: api9") === 0 || game.planet() === "") {
      return;
    }
    game.ship_stock_on(true);
    let planet = game.planet();
    let n = game.shipyard_count(planet);
    let list = "";
    {
      const end$1 = n;
      for (let k = 0; k < end$1; k = __dados_int_add(k, 1)) {
        if (k > 0) {
          list = list + ",";
        }
        list = list + game.shipyard_model(planet, k);
      }
    }
    game.set_condition("test: api9 shipyard " + __dados_str_int(n) + " " + list, 1);
    let bad = game.shipyard_count("Nowhere") === 0 && game.shipyard_model(planet, n) === "" && game.shipyard_model(planet, -1) === "";
    game.set_condition("test: api9 shipyard bad", bad ? 1 : 0);
    game.set_condition("test: api9 model " + game.model_name("Frigate") + "|" + game.model_category("Frigate") + "|" + game.model_licenses("Frigate"), 1);
    game.set_condition("test: api9 cost Frigate", game.model_cost("Frigate"));
    let unknown = game.model_name("Nope") === "" && game.model_cost("Nope") === 0 && game.model_category("Nope") === "" && game.model_licenses("Nope") === "";
    game.set_condition("test: api9 model bad", unknown ? 1 : 0);
    game.set_ship_stock(planet, "Bounder", 3);
    game.set_condition("test: api9 stock set", game.ship_stock(planet, "Bounder"));
    game.set_ship_stock(planet, "Bounder", -1);
    game.set_condition("test: api9 stock untracked", game.ship_stock(planet, "Bounder"));
    game.set_ship_stock("Nowhere", "Bounder", 5);
    game.set_ship_stock(planet, "Nope", 5);
    game.set_condition("test: api9 stock unknown", game.ship_stock("Nowhere", "Bounder"));
    game.set_ship_stock(planet, "Star Barge", 2);
    game.ship_order_note(planet, "Frigate", "Order one at Alpha Station.");
    game.ship_order_note("Nowhere", "Frigate", "Nope.");
    game.set_condition("test: api9 buy in enter", game.buy_ship("Bounder", "Sneaky") ? 1 : 0);
    game.map_label("Delta", "Kestrel Refits", 1, 0.8, 0.2);
    game.map_label("Nowhere", "Lost", 1, 1, 1);
    game.map_label("Delta", "", 1, 1, 1);
    game.map_ring("Delta", 1.5, 1, 0.8, 0.2);
    game.map_ring("Delta", 10, 1, 0.8, 0.2);
    game.map_ring("Nowhere", 1.5, 1, 0.8, 0.2);
    game.set_condition("test: api9 in stock barge", game.ship_in_stock("Star Barge"));
    game.set_condition("test: api9 in stock unknown", game.ship_in_stock("Nope"));
  }
  on_planet_button(game) {
    if (game.condition("test: api9") === 0) {
      return;
    }
    game.set_condition("test: api9 buy bounder", game.buy_ship("Bounder", "Ace") ? 1 : 0);
    game.set_condition("test: api9 buy frigate unlicensed", game.buy_ship("Frigate", "") ? 1 : 0);
    game.set_condition("license: Navy", 1);
    game.set_condition("license: Militia", 1);
    game.set_condition("test: api9 buy frigate broke", game.buy_ship("Frigate", "") ? 1 : 0);
    game.set_condition("test: api9 buy unknown", game.buy_ship("Nope", "") ? 1 : 0);
    game.set_condition("test: api9 buy barge", game.buy_ship("Star Barge", "") ? 1 : 0);
  }
  on_step(game, step) {
    if (game.condition("test: api9") === 0) {
      return;
    }
    let n = game.losses();
    {
      const end$2 = n;
      for (let k = 0; k < end$2; k = __dados_int_add(k, 1)) {
        let by = game.loss_by_player(k) ? "1" : "0";
        game.set_condition("test: api9 loss " + game.loss_model(k) + "|" + game.loss_government(k) + "|" + by, 1);
      }
    }
    game.set_condition("test: api9 losses", __dados_int_add(game.condition("test: api9 losses"), n));
    game.set_condition("test: api9 in stock flying", game.ship_in_stock("Star Barge") === 0 ? 1 : 0);
  }
};
__dados_lines("api9_probe/api9_probe.dados", ["main.Api9Probe.name", "main.Api9Probe.on_enter", "main.Api9Probe.on_planet_button", "main.Api9Probe.on_step"], [
  6,
  0,
  0,
  -1,
  12,
  11,
  5,
  0,
  13,
  0,
  0,
  -1,
  16,
  14,
  5,
  1,
  17,
  15,
  9,
  1,
  18,
  14,
  5,
  1,
  19,
  16,
  5,
  1,
  20,
  17,
  5,
  1,
  21,
  18,
  5,
  1,
  22,
  19,
  5,
  1,
  23,
  20,
  5,
  1,
  26,
  21,
  9,
  1,
  27,
  22,
  13,
  1,
  28,
  21,
  9,
  1,
  29,
  23,
  9,
  1,
  30,
  20,
  5,
  1,
  32,
  24,
  5,
  1,
  33,
  25,
  5,
  1,
  34,
  26,
  5,
  1,
  35,
  27,
  5,
  1,
  36,
  28,
  5,
  1,
  37,
  29,
  5,
  1,
  38,
  30,
  5,
  1,
  39,
  31,
  5,
  1,
  40,
  32,
  5,
  1,
  41,
  33,
  5,
  1,
  42,
  34,
  5,
  1,
  43,
  35,
  5,
  1,
  44,
  36,
  5,
  1,
  45,
  37,
  5,
  1,
  46,
  38,
  5,
  1,
  47,
  39,
  5,
  1,
  48,
  40,
  5,
  1,
  49,
  41,
  5,
  1,
  50,
  42,
  5,
  1,
  51,
  43,
  5,
  1,
  52,
  44,
  5,
  1,
  53,
  45,
  5,
  1,
  54,
  46,
  5,
  1,
  55,
  47,
  5,
  1,
  56,
  48,
  5,
  1,
  57,
  49,
  5,
  1,
  58,
  0,
  0,
  -1,
  61,
  52,
  5,
  2,
  62,
  53,
  9,
  2,
  63,
  52,
  5,
  2,
  64,
  54,
  5,
  2,
  65,
  55,
  5,
  2,
  66,
  56,
  5,
  2,
  67,
  57,
  5,
  2,
  68,
  58,
  5,
  2,
  69,
  59,
  5,
  2,
  70,
  60,
  5,
  2,
  71,
  0,
  0,
  -1,
  74,
  63,
  5,
  3,
  75,
  64,
  9,
  3,
  76,
  63,
  5,
  3,
  77,
  65,
  5,
  3,
  78,
  66,
  5,
  3,
  81,
  67,
  9,
  3,
  82,
  68,
  9,
  3,
  83,
  66,
  5,
  3,
  85,
  69,
  5,
  3,
  86,
  70,
  5,
  3,
  87,
  0,
  0,
  -1
]);
export {
  Api9Probe
};
