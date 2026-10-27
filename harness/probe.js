// JavaScript the harness calls (harness.dado's `foreign "probe.js"` block).

// Asks what a loaded mod object offers, so the harness calls only the hooks it has.
export function has_method(o, name) {
    return o !== null && o !== undefined && typeof o[name] === "function";
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
        // The mod API this mod was built against: the loader's. Do not override.
        api_version() { return MOD_API; }
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
