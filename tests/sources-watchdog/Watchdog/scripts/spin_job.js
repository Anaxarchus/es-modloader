// on_load queues a job that never returns: it runs inside the on_load call, under the watchdog.
export class SpinJob extends Mod {
    on_load(game) { Promise.resolve().then(() => { for (;;) {} }); }
}
