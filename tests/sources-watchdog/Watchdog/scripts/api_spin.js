// api_version never returns: stopped while loading.
export class ApiSpin extends Mod {
    api_version() { for (;;) {} }
}
