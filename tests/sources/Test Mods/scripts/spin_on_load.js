// Never returns from on_load: stopped, and not loaded.
export class SpinOnLoad extends Mod {
    on_load(game) { for (;;) {} }
}
