// A mod in plain JavaScript, not bundled: it builds on the globals the loader
// defines (Mod, MOD_API, es).
export class PlainMod extends Mod {
    name() { return "plain"; }
    on_load(game) {
        this.log(game, "hello from plain JavaScript");
        game.set_condition("test: plain api", MOD_API);
        game.set_condition("test: plain es", es.Mod === Mod && es.MOD_API === MOD_API ? 1 : 0);
        game.set_data("who", "plain_mod");
        // plain_es_mod (loaded first) set a global in its own realm.
        game.set_condition("test: isolated", typeof globalThis.esLeak === "undefined" ? 1 : 0);
    }
    on_step(game, step) {
        if (game.condition("dado example: enabled") === 0) return;
        if (this.every(step, 1.0))
            game.set_condition("test: plain seconds", game.condition("test: plain seconds") + 1);
        game.set_condition("test: plain ships", this.player_ships(game).length);
    }
}
