// Its first on_step never returns.
export class SpinFirstStep extends Mod {
    on_step(game, step) { for (;;) {} }
}
