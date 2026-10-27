#!/bin/sh
# Copies the built loader into the game's "modloaders" folder for this user:
#   macOS    ~/Library/Application Support/endless-sky/modloaders
#   Linux    ${XDG_DATA_HOME:-~/.local/share}/endless-sky/modloaders
#   Windows  %APPDATA%/endless-sky/modloaders
#
#   tools/install.sh [--to <dir>] [<library>]
#
# <library> defaults to the one in build/. The game also reads the modloaders
# folder of its resources (next to its data folder).
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
TO=
LIB=
while [ $# -gt 0 ]; do
	case $1 in
	--to) TO=$2; shift 2 ;;
	-h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) LIB=$1; shift ;;
	esac
done
if [ -z "$LIB" ]; then
	for f in "$HERE"/build/libesdado.dylib "$HERE"/build/libesdado.so "$HERE"/build/esdado.dll; do
		[ -f "$f" ] && { LIB=$f; break; }
	done
fi
[ -n "$LIB" ] && [ -f "$LIB" ] || { echo "install: no library (build first, or name it)" >&2; exit 1; }
if [ -z "$TO" ]; then
	case $(uname -s) in
	Darwin) TO="$HOME/Library/Application Support/endless-sky/modloaders" ;;
	MINGW*|MSYS*|CYGWIN*) TO="${APPDATA:?}/endless-sky/modloaders" ;;
	*) TO="${XDG_DATA_HOME:-$HOME/.local/share}/endless-sky/modloaders" ;;
	esac
fi
mkdir -p "$TO"
cp "$LIB" "$TO/"
echo "installed $(basename "$LIB") in $TO"
