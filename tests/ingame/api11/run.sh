#!/bin/sh
# Mod API 11 end to end: the real game, this loader, and a DadoScript mod built
# with the mod SDK, on the integration test "Dado API 11".
#
#   tests/ingame/api11/run.sh <game executable> [<game repository>] [<loader library>]
#
# <game repository> is the game's source tree, the resources and the
# integration-test config (default: $ES_GAME, or ../endless-sky beside this
# repository); <loader library> defaults to the one in build/. The mod SDK is
# $ES_SDK, or ../endless-sky-mod-sdk (with `npm install` done; DadoScript
# needs dadoc on PATH).
#
# 1. Builds api11_e2e/ (a plugin: plugin.txt, data/, src/api11_e2e.dados)
#    with the SDK: `npm run build` gives dist/Dado API 11 test/scripts/api11_e2e.js.
# 2. Makes a scratch config: the game's tests/integration/config, that plugin,
#    and the loader in modloaders/ (Files::Config()/modloaders).
# 3. Runs the game on "Dado API 11" (headless, with xvfb-run on Linux).
# 4. Checks the save that test wrote: the runtime definitions come before the
#    ships, and a fresh game without the loader parses it with no errors.
# KEEP=1 keeps the scratch folder.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
die() { echo "api11: $*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: tests/ingame/api11/run.sh <game executable> [<game repository>] [<loader library>]"
GAME_EXE=$1
GAME=${2:-${ES_GAME:-$ROOT/../endless-sky}}
LIB=${3:-}
SDK=${ES_SDK:-$ROOT/../endless-sky-mod-sdk}
if [ -z "$LIB" ]; then
	for f in "$ROOT"/build/libesdado.so "$ROOT"/build/libesdado.dylib; do
		[ -f "$f" ] && { LIB=$f; break; }
	done
fi
[ -x "$GAME_EXE" ] || die "no game executable at $GAME_EXE"
[ -d "$GAME/tests/integration/config" ] || die "no integration-test config in $GAME (pass the game's repository)"
[ -n "$LIB" ] && [ -f "$LIB" ] || die "no loader library (build it, or pass it)"
[ -f "$SDK/tools/esmod.mjs" ] || die "no mod SDK at $SDK (set ES_SDK)"
GAME=$(cd "$GAME" && pwd)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/esdado-api11.XXXXXX")
[ -n "${KEEP:-}" ] || trap 'rm -rf "$WORK"' EXIT

# 1. The mod, built with the SDK.
PLUGIN_NAME="Dado API 11 test"
(cd "$SDK" && npm run --silent build -- "$HERE/api11_e2e") || die "the SDK could not build the mod"
BUILT="$SDK/dist/$PLUGIN_NAME"
[ -f "$BUILT/scripts/api11_e2e.js" ] || die "the build wrote no $BUILT/scripts/api11_e2e.js"

# 2. The resources (the game's, without its plugins and mod loaders) and the config.
RES="$WORK/resources"
mkdir -p "$RES"
for entry in "$GAME"/*; do
	case $(basename "$entry") in
	plugins|modloaders|build) continue ;;
	esac
	ln -s "$entry" "$RES/$(basename "$entry")"
done
CONFIG="$WORK/config"
mkdir -p "$CONFIG"
cp -R "$GAME/tests/integration/config/." "$CONFIG/"
mkdir -p "$CONFIG/plugins" "$CONFIG/modloaders"
cp -R "$BUILT" "$CONFIG/plugins/"
cp "$LIB" "$CONFIG/modloaders/"

# 3. The test.
run() {
	if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
		xvfb-run --auto-servernum --server-args="+extension GLX +render -noreset" "$@"
	else
		"$@"
	fi
}
TEST="Dado API 11"
echo "api11: running \"$TEST\" with $(basename "$LIB") (scratch $WORK)"
status=0
run timeout 600 "$GAME_EXE" --resources "$RES" --config "$CONFIG" --test "$TEST" > "$WORK/test.log" 2>&1 || status=$?
grep -E "dado: |API11E FAIL|Test (passed|failed)|[Ff]ailed" "$WORK/test.log" || true
if [ $status -ne 0 ]; then
	[ -f "$CONFIG/errors.txt" ] && sed 's/^/api11:   /' "$CONFIG/errors.txt"
	die "FAILED: \"$TEST\" ($status; log $WORK/test.log)"
fi
echo "ok  : \"$TEST\" passed"

# 4. The save it wrote: the definitions before the ships, and it parses without the loader.
SAVE=$(sed -n 1p "$CONFIG/recent.txt")
defs=$(grep -n '^"runtime definitions"' "$SAVE" | head -1 | cut -d: -f1)
ship=$(grep -n '^ship ' "$SAVE" | head -1 | cut -d: -f1)
if [ -z "$defs" ] || [ -z "$ship" ] || [ "$defs" -ge "$ship" ]; then
	die "FAILED: the save's runtime definitions do not come before its ships ($SAVE)"
fi
for name in '"API11E Core"' '"API11E Battery"' '"API11E Laser"' '"API11E Barge"' '"API11E Barge Mk2"'; do
	grep -q "$name" "$SAVE" || die "FAILED: the save does not name $name"
done
echo "ok  : the save's runtime definitions (line $defs) come before its ships (line $ship), under api11_e2e"
rm -f "$CONFIG/modloaders/$(basename "$LIB")"
if ! "$GAME_EXE" --resources "$RES" --config "$CONFIG" --parse-save > "$WORK/parse.log" 2>&1 \
		|| ! grep -q "Parse completed with no error(s)." "$WORK/parse.log"; then
	cat "$WORK/parse.log"
	die "FAILED: the saved pilot does not parse cleanly without the loader"
fi
echo "ok  : the saved pilot parses with no errors without the loader"
echo "api11: PASSED"
