// The hook check (has_method) reads on_day, a getter that never returns: stopped while loading.
export class GetterSpin extends Mod {
    get on_day() { for (;;) {} }
}
