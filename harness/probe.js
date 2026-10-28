// JavaScript the harness calls (harness.dado's `foreign "probe.js"` block).

// Asks what a loaded mod object offers, so the harness calls only the hooks it has.
export function has_method(o, name) {
    return o !== null && o !== undefined && typeof o[name] === "function";
}

// Running a mod's hooks by name. Every mod has an engine of its own, so this
// module holds one mod: bind_mod names it (and the Game it is handed), and
// name_hook gives a hook name an id (the loader's), looks the method up and
// answers whether the mod has it. invoke_int and invoke_str then run hook `id`
// with one argument, invoke_json with the arguments a JSON array holds.
// invoke_str and invoke_json answer -4 when the mod has no such hook, else 1
// when the hook answered something truthy (can_outfitter's true) and 0 when
// not; invoke_int, the hot path (on_step, every engine step), answers nothing.
let boundMod = null;
let boundGame = null;
const hookFns = [];
const hookNames = [];
export function bind_mod(o, game) {
    boundMod = o;
    boundGame = game;
}
export function name_hook(id, name) {
    hookNames[id] = name;
    const f = boundMod === null || boundMod === undefined ? undefined : boundMod[name];
    hookFns[id] = typeof f === "function" ? f : null;
    return hookFns[id] !== null;
}
export function hook_name(id) {
    return hookNames[id] ?? "hook " + id;
}
// (A method call, boundMod[name](...), is faster in QuickJS than f.call(...).)
export function invoke_int(id, a) {
    if (hookFns[id]) boundMod[hookNames[id]](boundGame, a);
}
export function invoke_str(id, s) {
    if (!hookFns[id]) return -4;
    return boundMod[hookNames[id]](boundGame, s) ? 1 : 0;
}
export function invoke_json(id, args) {
    if (!hookFns[id]) return -4;
    const list = JSON.parse(args);
    return boundMod[hookNames[id]](boundGame, ...(Array.isArray(list) ? list : [])) ? 1 : 0;
}

// The mod API a loaded mod says it needs (Mod.min_api, mod API 10), or -1 when
// it has no min_api (a mod built before it), and then the loader checks its
// api_version as it always did; -2 when min_api answered something that is not
// a whole number of at least 1, which the harness logs and takes as 1.
export function min_api_of(o) {
    if (typeof o.min_api !== "function") return -1;
    const v = Number(o.min_api());
    return Number.isInteger(v) && v >= 1 ? v : -2;
}

// The globals a mod written in plain JavaScript builds on, defined in the mod's
// own engine before it loads: `Mod`, the same base class as the SDK's `es.Mod`
// (sdk/es/Mod.dados), `MOD_API`, the mod API this loader speaks, and `es`,
// holding both, so `class X extends es.Mod` reads as it does in DadoScript.
//
//     export class ShieldWall extends Mod {
//         name() { return "shield wall"; }
//         on_step(game, step) {
//             if (this.every(step, 1.0))
//                 for (const i of this.player_ships(game))
//                     game.set_shields(i, game.shields(i) + 10.0);
//         }
//     }
//
// A bundled mod carries its own copy of es.Mod and does not use these. They are
// read-only, and every mod's engine has its own.
export function install_globals(api) {
    if (Object.prototype.hasOwnProperty.call(globalThis, "Mod")) return;
    const MOD_API = Number(api);
    class Mod {
        // The mod API this mod was built against: the loader's. Informational.
        api_version() { return MOD_API; }
        // The oldest mod API this mod runs on (mod API 10). Override it to need more.
        min_api() { return 1; }
        // The mod's name, used by `log`. Override it.
        name() { return "unnamed mod"; }
        on_load(game) {}
        on_step(game, step) {}
        on_day(game, day) {}
        on_enter(game, system) {}
        on_planet_button(game) {}
        on_panel(game, button) {}
        can_outfitter(game, outfit) { return true; }
        on_outfitter(game, outfit) {}
        on_confirm(game, token) {}
        on_panel_row(game, row) {}
        on_panel_header(game, column) {}
        on_number(game, token, value) {}
        on_save(game) {}
        on_pilot_loaded(game) {}
        on_notification(game, name, payload, sender) {}
        // Write a line to the game's log, prefixed with the mod's name.
        log(game, text) { game.log(this.name() + ": " + text); }
        // True once every `seconds` of game time, for spreading work out over steps.
        every(step, seconds) {
            const period = Math.trunc(seconds * 60);
            if (period < 1) return true;
            return step % period === 0;
        }
        // The indices of the player's ships in the current system that are not disabled.
        player_ships(game) {
            const out = [];
            const n = game.ship_count();
            for (let i = 0; i < n; i++)
                if (game.is_player(i) && !game.is_disabled(i)) out.push(i);
            return out;
        }
    }
    const es = Object.freeze({ Mod, MOD_API });
    for (const [key, value] of [["Mod", Mod], ["MOD_API", MOD_API], ["es", es]])
        Object.defineProperty(globalThis, key, { value, writable: false, enumerable: false, configurable: false });
}
