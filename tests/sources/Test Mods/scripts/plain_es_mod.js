// A plain JavaScript mod extending es.Mod, as a DadoScript mod reads.
export class PlainEsMod extends es.Mod {
    on_load(game) {
        game.set_condition("test: plain es mod", 1);
        game.set_data("who", "plain_es_mod");
        globalThis.esLeak = 1;
        let readOnly = 0;
        try { globalThis.Mod = null; } catch (e) { readOnly = 1; }
        game.set_condition("test: globals read-only", readOnly && typeof Mod === "function" ? 1 : 0);
    }
}
