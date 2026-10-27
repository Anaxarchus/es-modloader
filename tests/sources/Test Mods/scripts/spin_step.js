// Never returns from on_step once "test: spin" is set: the watchdog stops it.
export class SpinStep extends Mod {
    on_step(game, step) {
        if (game.condition("test: spin") !== 0)
            for (;;) {}
    }
}
