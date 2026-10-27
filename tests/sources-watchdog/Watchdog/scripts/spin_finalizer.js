// Registers a finalizer that would never return for an object it keeps alive,
// so it could only run when the engine is torn down: shutdown must not run it.
export class SpinFinalizer extends Mod {
    on_load(game) {
        globalThis.kept = {};
        globalThis.registry = new FinalizationRegistry(() => { for (;;) {} });
        globalThis.registry.register(globalThis.kept, 0);
    }
    on_step(game, step) { game.set_condition("test: finalizer steps", game.condition("test: finalizer steps") + 1); }
}
