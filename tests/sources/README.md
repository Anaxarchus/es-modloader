# Test sources

The sources `tools/dado-mods.sh test` hands the fake host (`tests/fake_host.cpp`),
in this order, as the game hands its loaders the resources folder and then
each enabled plugin:

- `resources/`: the game's resources (name ""), with an `override_me` mod.
- `Test Mods/`: every example and test mod, built into its `scripts/` by the
  test, plus the plain JavaScript mods here: mods built on the global `Mod`,
  mods that never return (the watchdog), one that does not compile, and files
  that are not mods (`.hidden.js`, `notes.txt`, the folder `folder.js`).
- `Zipped.zip/`: a folder whose name ends in `.zip`, standing in for a zipped
  plugin, which the loader skips.
- `Override/`: a later `override_me`, which replaces the resources' one.
