// A well-behaved mod, loaded last: its hooks run whatever the others do.
export class ZzOk extends Mod {
    on_step(game, step) { game.set_condition("test: ok steps", game.condition("test: ok steps") + 1); }
}
