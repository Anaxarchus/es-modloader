// In a source whose path ends in ".zip": the loader skips it, so this never runs.
export class Zipped extends Mod {
    on_load(game) { game.set_condition("test: zipped ran", 1); }
}
