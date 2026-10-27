# Watchdog test sources

`tools/dado-mods.sh test` runs `fake_host --watchdog <library> <load ms> <hook ms>
<this folder>/Watchdog` twice: with a 2000 ms load limit and a 250 ms hook limit,
and with a hook limit longer than the load limit. Each mod here runs code that
never returns at a different point of loading or running, and the fake host
times how long each stop took from the `hook_timing` brackets. Mods load in
name order, so a short deadline is armed while the watchdog sleeps until a
longer one (an `on_load` after a load, the first `on_step` after the last load).
