// Replaces resources/scripts/override_me.js.
export class OverrideMe extends Mod {
    on_load(game) { game.set_condition("test: override", 2); }
}
