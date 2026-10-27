// The mod object is a Proxy whose get trap never returns for on_panel: stopped while loading.
export class ProxySpin extends Mod {
    constructor() {
        super();
        return new Proxy(this, {
            get(target, key, receiver) {
                if (key === "on_panel") for (;;) {}
                return Reflect.get(target, key, receiver);
            },
        });
    }
}
