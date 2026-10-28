// A mod as one built before mod API 10 would look, built for a newer API than
// the loader's: it has no min_api, so the loader checks its api_version, as
// loaders always did, and refuses it.
export class LegacyFuture {
    api_version() { return 999; }
    name() { return "legacy future"; }
    on_load(game) { game.set_condition("test: legacy future ran", 1); }
}
