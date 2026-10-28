// min_api never returns: stopped while loading. (Since mod API 10 the loader
// asks min_api, which the global Mod defines, rather than api_version.)
export class ApiSpin extends Mod {
    min_api() { for (;;) {} }
}
