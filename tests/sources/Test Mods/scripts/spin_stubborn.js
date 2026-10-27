// Catches the watchdog's stop and goes on spinning: the watchdog forces it.
export class SpinStubborn extends Mod {
    on_step(game, step) {
        if (game.condition("test: spin") === 0) return;
        for (;;) {
            try { for (;;) {} } catch (e) { game.set_condition("test: stubborn caught", 1); }
        }
    }
}
