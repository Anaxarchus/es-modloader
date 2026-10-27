#!/bin/sh
# The Dado loader's in-game test: runs the game's integration-test runner on
# "Dado mods - Hull regen example" with this loader installed.
#
#   tests/ingame/run.sh <game executable> [<game repository>] [<loader library>]
#
# <game repository> is the game's source tree, used as its resources and for its
# integration-test config (default: ../endless-sky beside this repository, or
# $ES_GAME); <loader library> defaults to the one in build/. The test runs in a
# temporary copy of the game's tests/integration/config, with:
#   plugins/Dado mod tests/        plugin.txt, data/tests/tests_dado_mods.txt and
#                                  scripts/*.js (tests/ingame here)
#   modloaders/<loader library>    the loader, where the game looks (Files::Config())
# The game's own plugins/ and modloaders/ are left out: the game runs with a
# temporary resources folder that links every other top-level entry of
# <game repository> (data, images, sounds, ...), so only this test's plugin
# and this loader take part, whatever is installed in the repository.
# On Linux without a display it runs under xvfb-run when that is installed.
# KEEP=1 keeps the temporary config.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
die() { echo "ingame: $*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: tests/ingame/run.sh <game executable> [<game repository>] [<loader library>]"
GAME_EXE=$1
GAME=${2:-${ES_GAME:-$ROOT/../endless-sky}}
LIB=${3:-}
if [ -z "$LIB" ]; then
	for f in "$ROOT"/build/libesdado.dylib "$ROOT"/build/libesdado.so "$ROOT"/build/esdado.dll; do
		[ -f "$f" ] && { LIB=$f; break; }
	done
fi
[ -x "$GAME_EXE" ] || die "no game executable at $GAME_EXE"
[ -d "$GAME/tests/integration/config" ] || die "no integration-test config in $GAME (pass the game's repository)"
[ -n "$LIB" ] && [ -f "$LIB" ] || die "no loader library (build it, or pass it)"
GAME=$(cd "$GAME" && pwd)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/esdado-ingame.XXXXXX")
[ -n "${KEEP:-}" ] || trap 'rm -rf "$WORK"' EXIT
# The resources: links to the game's, without its plugins and mod loaders.
RES="$WORK/resources"
mkdir -p "$RES"
for entry in "$GAME"/*; do
	case $(basename "$entry") in
	plugins|modloaders|build) continue ;;
	esac
	ln -s "$entry" "$RES/$(basename "$entry")"
done
[ -d "$RES/data" ] || die "no data folder in $GAME"
CONFIG="$WORK/config"
mkdir -p "$CONFIG"
cp -R "$GAME/tests/integration/config/." "$CONFIG/"
PLUGIN="$CONFIG/plugins/Dado mod tests"
mkdir -p "$PLUGIN/data/tests" "$PLUGIN/scripts" "$CONFIG/modloaders"
cp "$HERE/plugin/plugin.txt" "$PLUGIN/"
cp "$HERE/tests_dado_mods.txt" "$PLUGIN/data/tests/"
cp "$HERE"/scripts/*.js "$PLUGIN/scripts/"
cp "$LIB" "$CONFIG/modloaders/"

TEST="Dado mods - Hull regen example"
"$GAME_EXE" --tests --resources "$RES" --config "$CONFIG" 2>/dev/null | grep -Fqx "$TEST" \
	|| die "the game does not list \"$TEST\" (is the plugin installed? see $CONFIG)"
run() {
	if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
		xvfb-run --auto-servernum --server-args="+extension GLX +render -noreset" "$@"
	else
		"$@"
	fi
}
echo "ingame: running \"$TEST\" with $(basename "$LIB") (config $CONFIG)"
if run "$GAME_EXE" --resources "$RES" --config "$CONFIG" --test "$TEST"; then
	echo "ingame: PASSED"
else
	status=$?
	echo "ingame: FAILED ($status)"
	[ -f "$CONFIG/errors.txt" ] && sed 's/^/ingame:   /' "$CONFIG/errors.txt"
	exit 1
fi
