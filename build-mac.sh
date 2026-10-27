#!/bin/sh
# Builds the macOS loader, libesdado.dylib.
#
#   ./build-mac.sh            on a Mac: a native build with Apple's clang, in build/
#                             anywhere else: a cross build with zig, in build-mac/
#   ZIG_TARGET=x86_64-macos.10.15 ./build-mac.sh    an Intel Mac's library (cross build)
#
# Either way it needs the Dado toolchain (dado, dadoc), cmake and ninja (or make).
# The cross build (tools/zig-macos.cmake) needs zig on PATH (the Dado installer ships one, in ~/dado/zig/<version>,
# which this script finds), or ZIG naming it. On a Mac this is the same as
#   cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build
# Then install it with tools/install.sh (or `cmake --build build --target install-loader`).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PATH="$PATH:$HOME/.local/bin:$HOME/dado:/opt/homebrew/bin:/usr/local/bin"
GEN=
command -v ninja >/dev/null 2>&1 && GEN="-G Ninja"
if [ "$(uname -s)" = Darwin ] && [ -z "${ZIG_TARGET:-}" ]; then
	cmake -S "$HERE" -B "$HERE/build" $GEN -DCMAKE_BUILD_TYPE=Release
	cmake --build "$HERE/build"
	echo "built $HERE/build/libesdado.dylib"
	exit 0
fi
if [ -z "${ZIG:-}" ] && ! command -v zig >/dev/null 2>&1; then
	for z in "$HOME"/dado/zig/*/zig; do [ -x "$z" ] && PATH="$(dirname "$z"):$PATH"; done
fi
command -v "${ZIG:-zig}" >/dev/null 2>&1 || { echo "build-mac: no zig (put it on PATH or set ZIG)" >&2; exit 1; }
OUT=${OUT:-$HERE/build-mac}
# From inside the build folder: zig's compiler checks leave files (a.o) in the
# folder they run in.
mkdir -p "$OUT"
cd "$OUT"
cmake -S "$HERE" -B "$OUT" $GEN -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE="$HERE/tools/zig-macos.cmake"
cmake --build "$OUT"
file "$OUT/libesdado.dylib" 2>/dev/null || echo "built $OUT/libesdado.dylib"
