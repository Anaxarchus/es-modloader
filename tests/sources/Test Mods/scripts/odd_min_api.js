// A mod whose min_api answers no whole number: the loader logs it, takes it as
// 1, and runs the mod.
export class OddMinApi extends Mod {
    min_api() { return 1.5; }
    on_load(game) { game.set_condition("test: odd min api ran", 1); }
}
