// A hidden file: not a mod.
export class Hidden extends Mod {
    on_load(game) { game.set_condition("test: hidden ran", 1); }
}
