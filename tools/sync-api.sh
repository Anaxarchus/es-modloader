#!/bin/sh
# Keeps include/es_api.h a copy of the game's API header, the single source of
# truth (source/modding/es_api.h in the game's repository).
#
#   tools/sync-api.sh            copy the game's header here; fails (exit 1) when
#                                the copy here differed, so the change gets noticed,
#                                rebuilt and committed
#   tools/sync-api.sh --check    copy nothing; fail when the two differ
#
# The game's repository is ../endless-sky beside this one, or $ES_GAME. Exits 77
# (skipped) when it is not there.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
GAME=${ES_GAME:-$HERE/../endless-sky}
SRC=$GAME/source/modding/es_api.h
DST=$HERE/include/es_api.h
CHECK=0
[ "${1:-}" = --check ] && CHECK=1
if [ ! -f "$SRC" ]; then
	echo "sync-api: no $SRC (set ES_GAME to the game's repository)" >&2
	exit 77
fi
if cmp -s "$SRC" "$DST"; then
	echo "sync-api: include/es_api.h matches the game's"
	exit 0
fi
if [ "$CHECK" = 1 ]; then
	echo "sync-api: include/es_api.h differs from $SRC; run tools/sync-api.sh" >&2
	diff -u "$DST" "$SRC" >&2 || true
	exit 1
fi
cp "$SRC" "$DST"
echo "sync-api: include/es_api.h differed from the game's and was updated; rebuild, test and commit it" >&2
exit 1
