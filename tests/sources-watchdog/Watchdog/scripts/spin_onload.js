// on_load never returns.
export class SpinOnload extends Mod {
    on_load(game) { for (;;) {} }
}
