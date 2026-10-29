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
function __dados_int_mul(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    const r = a * b;
    if (r >= -MAX_SAFE && r <= MAX_SAFE) return r + 0;
  }
  return wide(a, b, 2);
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
        return 11;
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

// main/Api11Probe.js
var Api11Probe = class extends Mod$class() {
  $fields() {
    super.$fields();
  }
  name() {
    return "api11 probe";
  }
  record(game, key, value) {
    game.set_condition("test: api11 " + key, value);
  }
  yes(value) {
    return value ? 1 : 0;
  }
  core() {
    return 'outfit "Shield Core"\n	category "Systems"\n	mass 10\n	"shield generation" 2\n';
  }
  on_enter(game, system) {
    if (game.condition("test: api11") === 0 || game.planet() === "") {
      return;
    }
    this.record(game, "define", game.define('ship "Star Barge" "Core Barge"\n	outfits\n		"Shield Core"\n' + this.core()));
    this.record(game, "define same", game.define(this.core()));
    this.record(game, "define other text", game.define('outfit "Shield Core"\n	mass 11\n'));
    this.record(game, "define data name", game.define('outfit "Laser"\n	mass 1\n'));
    this.record(game, "define other node", game.define('fleet "Nope"\n'));
    this.record(game, "define unknown outfit", game.define('ship "Bad Barge"\n	outfits\n		"Nope"\n'));
    this.record(game, "defined", __dados_int_add(__dados_int_add(__dados_int_add(__dados_int_mul(game.defined("outfit", "Shield Core"), 1e3), __dados_int_mul(game.defined("ship", "Core Barge"), 100)), __dados_int_mul(game.defined("outfit", "Laser"), 10)), game.defined("ship", "Star Barge")));
    this.record(game, "defined unknown", __dados_int_add(__dados_int_add(game.defined("outfit", "Nope"), game.defined("planet", "Alpha I")), game.defined("ship", "Bad Barge")));
    this.record(game, "core shields", __dados_int_of_float(game.outfit_attribute("Shield Core", "shield generation")));
    this.record(game, "outfit variant", this.yes(game.define_outfit_variant("Laser Mk2", "Laser", '"display name" "Laser Mk II"\ncost 2500\n')));
    this.record(game, "outfit variant again", this.yes(game.define_outfit_variant("Laser Mk2", "Laser", '"display name" "Laser Mk II"\ncost 2500\n')));
    this.record(game, "outfit variant changed", this.yes(game.define_outfit_variant("Laser Mk2", "Laser", "cost 9\n")));
    this.record(game, "variant", __dados_int_add(__dados_int_mul(this.yes(game.outfit_name("Laser Mk2") === "Laser Mk II" && game.outfit_is_weapon("Laser Mk2")), 1e4), __dados_int_of_float(game.outfit_attribute("Laser Mk2", "cost"))));
    this.record(game, "variant unknown base", this.yes(game.define_outfit_variant("Nope Mk2", "Nope", "")));
    this.record(game, "ship variant", this.yes(game.define_ship_variant("Barge Mk2", "Star Barge", '"display name" "Barge Mk II"\n')));
    this.record(game, "ship variant name", this.yes(game.model_name("Barge Mk2") === "Barge Mk II" && game.model_category("Barge Mk2") === "Light Freighter"));
    this.record(game, "give storage", game.outfit_give("Shield Core", 3, "storage"));
    this.record(game, "take storage", game.outfit_take("Shield Core", 5, "storage"));
    this.record(game, "give cargo", game.outfit_give("Battery", 4, "cargo"));
    this.record(game, "take any", game.outfit_take("Battery", 1, "any"));
    this.record(game, "take nowhere", __dados_int_add(game.outfit_take("Battery", 1, "elsewhere"), game.outfit_take("Battery", -3, "cargo")));
    this.record(game, "give unknown", game.outfit_give("Nope", 1, "cargo"));
    this.record(game, "replace in enter", game.ship_replace_outfit("uuid-b", "Battery", "Shield Core", 1));
  }
  on_planet_button(game) {
    if (game.condition("test: api11 old") !== 0) {
      this.record(game, "old define", game.define(this.core()));
      this.record(game, "old variants", __dados_int_add(this.yes(game.define_outfit_variant("A", "Laser", "")), this.yes(game.define_ship_variant("B", "Star Barge", ""))));
      this.record(game, "old defined", game.defined("outfit", "Laser"));
      this.record(game, "old replace", game.ship_replace_outfit("uuid-b", "Battery", "Laser", 1));
      this.record(game, "old move", __dados_int_add(game.outfit_give("Battery", 1, "cargo"), game.outfit_take("Battery", 1, "any")));
      this.record(game, "old done", 1);
      return;
    }
    if (game.condition("test: api11") === 0) {
      return;
    }
    this.record(game, "replace", game.ship_replace_outfit("uuid-b", "Battery", "Shield Core", 5));
    this.record(game, "replaced", __dados_int_add(__dados_int_mul(game.ship_outfit_count("uuid-b", "Shield Core"), 10), game.ship_outfit_count("uuid-b", "Battery")));
    this.record(game, "replace none left", game.ship_replace_outfit("uuid-b", "Battery", "Shield Core", 1));
    this.record(game, "replace weapon", game.ship_replace_outfit("uuid-b", "Shield Core", "Laser Mk2", 1));
    this.record(game, "replace zero", game.ship_replace_outfit("uuid-b", "Shield Core", "Battery", 0));
    this.record(game, "replace unknown", game.ship_replace_outfit("uuid-z", "Shield Core", "Battery", 1));
  }
  on_step(game, step) {
    if (game.condition("test: api11") === 0 || game.condition("test: api11 stepped") !== 0) {
      return;
    }
    this.record(game, "stepped", 1);
    let flagship = game.flagship();
    this.record(game, "distance flagship", __dados_int_of_float(game.ship_distance(flagship)));
    this.record(game, "distance", __dados_int_of_float(game.ship_distance(1)));
    this.record(game, "position", __dados_int_add(__dados_int_mul(__dados_int_of_float(game.ship_x(1)), 1e3), __dados_int_of_float(game.ship_y(1))));
    this.record(game, "distance bad", __dados_int_add(__dados_int_of_float(game.ship_distance(99)), __dados_int_of_float(game.ship_distance(-1))));
    let wreck = -1;
    {
      const end$1 = game.ship_count();
      for (let i = 0; i < end$1; i = __dados_int_add(i, 1)) {
        if (game.is_disabled(i) && !game.is_player(i)) {
          wreck = i;
        }
      }
    }
    this.record(game, "wreck", wreck);
    this.record(game, "reactivate player", this.yes(game.ship_reactivate(flagship, "", "")));
    this.record(game, "reactivate bad government", this.yes(game.ship_reactivate(wreck, "Nowhere", "")));
    this.record(game, "still disabled", this.yes(game.is_disabled(wreck)));
    this.record(game, "reactivate", this.yes(game.ship_reactivate(wreck, "Merchant", "heroic")));
    this.record(game, "awake", this.yes(!game.is_disabled(wreck) && game.ship_government(wreck) === "Merchant"));
    this.record(game, "reactivate again", this.yes(game.ship_reactivate(wreck, "", "")));
    this.record(game, "flight give", game.outfit_give("Battery", 2, "cargo"));
    this.record(game, "flight storage", __dados_int_add(game.outfit_give("Battery", 2, "storage"), game.outfit_take("Battery", 1, "storage")));
  }
};
__dados_lines("api11_probe/api11_probe.dados", ["main.Api11Probe.name", "main.Api11Probe.record", "main.Api11Probe.yes", "main.Api11Probe.core", "main.Api11Probe.on_enter", "main.Api11Probe.on_planet_button", "main.Api11Probe.on_step"], [
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
  28,
  5,
  4,
  32,
  29,
  5,
  4,
  33,
  30,
  5,
  4,
  34,
  31,
  5,
  4,
  35,
  32,
  5,
  4,
  36,
  33,
  5,
  4,
  37,
  34,
  5,
  4,
  38,
  36,
  5,
  4,
  39,
  37,
  5,
  4,
  40,
  38,
  5,
  4,
  41,
  39,
  5,
  4,
  42,
  40,
  5,
  4,
  43,
  41,
  5,
  4,
  44,
  43,
  5,
  4,
  45,
  44,
  5,
  4,
  46,
  45,
  5,
  4,
  47,
  46,
  5,
  4,
  48,
  47,
  5,
  4,
  49,
  48,
  5,
  4,
  50,
  49,
  5,
  4,
  51,
  50,
  5,
  4,
  52,
  51,
  5,
  4,
  53,
  52,
  5,
  4,
  54,
  0,
  0,
  -1,
  57,
  55,
  5,
  5,
  58,
  57,
  9,
  5,
  59,
  58,
  9,
  5,
  60,
  59,
  9,
  5,
  61,
  60,
  9,
  5,
  62,
  61,
  9,
  5,
  63,
  62,
  9,
  5,
  64,
  63,
  9,
  5,
  65,
  55,
  5,
  5,
  66,
  64,
  5,
  5,
  67,
  65,
  9,
  5,
  68,
  64,
  5,
  5,
  69,
  66,
  5,
  5,
  70,
  67,
  5,
  5,
  71,
  68,
  5,
  5,
  72,
  69,
  5,
  5,
  73,
  70,
  5,
  5,
  74,
  71,
  5,
  5,
  75,
  0,
  0,
  -1,
  78,
  74,
  5,
  6,
  79,
  75,
  9,
  6,
  80,
  74,
  5,
  6,
  81,
  76,
  5,
  6,
  82,
  77,
  5,
  6,
  83,
  78,
  5,
  6,
  84,
  79,
  5,
  6,
  85,
  80,
  5,
  6,
  86,
  81,
  5,
  6,
  87,
  82,
  5,
  6,
  88,
  83,
  5,
  6,
  91,
  84,
  9,
  6,
  92,
  85,
  13,
  6,
  93,
  84,
  9,
  6,
  94,
  83,
  5,
  6,
  96,
  86,
  5,
  6,
  97,
  87,
  5,
  6,
  98,
  88,
  5,
  6,
  99,
  89,
  5,
  6,
  100,
  90,
  5,
  6,
  101,
  91,
  5,
  6,
  102,
  92,
  5,
  6,
  103,
  93,
  5,
  6,
  104,
  94,
  5,
  6,
  105,
  0,
  0,
  -1
]);
export {
  Api11Probe
};
