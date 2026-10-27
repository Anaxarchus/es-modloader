#!/bin/sh
# Builds the loader for every platform the game runs on, checks and packages
# it, and (with --publish) makes a GitHub release of it. Runs on macOS (the
# main host) and Linux; every target is built with zig, the native one too.
#
#   tools/release.sh [options] <version>        e.g. 0.2.0, or 0.2.0-beta.1 (a prerelease)
#
#   --publish        after packaging, run `gh release create` (otherwise the
#                    command is printed)
#   --allow-dirty    build even though the git worktree has changes (or no commits)
#   --skip-tests     do not run the fake-host test on the host's own build
#   --no-universal   ship the two macOS builds separately, not as one universal dylib
#   --targets LIST   build only these (comma-separated, from: macos-arm64,
#                    macos-x86_64, linux-x86_64, linux-aarch64, windows-x86_64)
#   --repo OWNER/R   the GitHub repository ($ES_MODLOADER_REPO, default Anaxarchus/es-modloader)
#
# Environment: ZIG (zig to use; default ~/dado/zig/*/zig, then PATH), ES_GAME (the
# game's repository, default ../endless-sky), ES_GLIBC (oldest glibc, default
# 2.28), SOURCE_DATE_EPOCH (archive timestamps; default the HEAD commit's time).
#
# Builds in build-release/<target>/, writes dist/<version>/: one archive per
# platform, SHA256SUMS and RELEASE_NOTES.md. Needs Dado (dado, dadoc), cmake,
# ninja (or make), python3, and for the test a C++ compiler and Node (npx).
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
PATH="$PATH:$HOME/.local/bin:$HOME/dado:/opt/homebrew/bin:/usr/local/bin"
REPO=${ES_MODLOADER_REPO:-Anaxarchus/es-modloader}
GAME_RELEASES=${ES_GAME_RELEASES:-github.com/Anaxarchus/endless-sky/releases}
GLIBC=${ES_GLIBC:-2.28}
ALL_TARGETS="macos-arm64 macos-x86_64 linux-x86_64 linux-aarch64 windows-x86_64"

say() { printf '%s\n' "$*"; }
warn() { printf 'release: warning: %s\n' "$*" >&2; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }

PUBLISH=0 ALLOW_DIRTY=0 SKIP_TESTS=0 UNIVERSAL=1 TARGETS=$ALL_TARGETS VERSION=
while [ $# -gt 0 ]; do
	case $1 in
	--publish) PUBLISH=1 ;;
	--allow-dirty) ALLOW_DIRTY=1 ;;
	--skip-tests) SKIP_TESTS=1 ;;
	--no-universal) UNIVERSAL=0 ;;
	--targets) [ $# -ge 2 ] || die "--targets needs a list"; TARGETS=$(printf '%s' "$2" | tr ',' ' '); shift ;;
	--repo) [ $# -ge 2 ] || die "--repo needs OWNER/REPO"; REPO=$2; shift ;;
	-h|--help) usage; exit 0 ;;
	-*) die "unknown option $1 (see --help)" ;;
	*) [ -z "$VERSION" ] || die "one version only"; VERSION=$1 ;;
	esac
	shift
done
[ -n "$VERSION" ] || { usage >&2; exit 2; }
VERSION=${VERSION#v}
# SemVer: MAJOR.MINOR.PATCH, optionally -prerelease (dot-separated [0-9A-Za-z-]).
printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' \
	|| die "\"$VERSION\" is not a version like 1.2.3 or 1.2.3-beta.1"
for t in $TARGETS; do
	case " $ALL_TARGETS " in *" $t "*) ;; *) die "unknown target $t (known: $ALL_TARGETS)" ;; esac
done
case $REPO in */*) ;; *) die "--repo wants OWNER/REPO, not \"$REPO\"" ;; esac

# ---- tools -------------------------------------------------------------------
command -v python3 >/dev/null 2>&1 || die "python3 is needed (for checking and packaging)"
command -v cmake >/dev/null 2>&1 || die "cmake is needed"
if ! command -v dado >/dev/null 2>&1 || ! command -v dadoc >/dev/null 2>&1; then
	die "the Dado toolchain (dado, dadoc) is not on PATH (see README.md, Building)"
fi
GENERATOR="Unix Makefiles"
command -v ninja >/dev/null 2>&1 && GENERATOR=Ninja
if [ -z "${ZIG:-}" ]; then
	for z in "$HOME"/dado/zig/*/zig; do if [ -x "$z" ]; then ZIG=$z; fi; done
fi
[ -n "${ZIG:-}" ] || ZIG=$(command -v zig 2>/dev/null) || die "no zig: set ZIG, or install Dado (it ships one in ~/dado/zig)"
[ -x "$ZIG" ] || die "ZIG=$ZIG is not an executable"
case $ZIG in /*) ;; *) ZIG=$(cd "$(dirname "$ZIG")" && pwd)/$(basename "$ZIG") ;; esac
# On PATH too: Dado's engine build archives with `zig ar` when it finds zig
# (the host's ar does not index Windows objects).
PATH="$(dirname "$ZIG"):$PATH"
export ZIG PATH
REL=python3
RELPY="$HERE/tools/release.py"
API=$(sed -n 's/^#define ES_API_VERSION \([0-9][0-9]*\).*/\1/p' "$HERE/include/es_api.h")
[ -n "$API" ] || die "no ES_API_VERSION in include/es_api.h"
say "release: Dado loader $VERSION, mod API $API, zig $("$ZIG" version) ($ZIG)"

if [ "$PUBLISH" = 1 ]; then
	command -v gh >/dev/null 2>&1 || die "--publish needs the GitHub CLI, gh (brew install gh)"
	gh auth status >/dev/null 2>&1 || die "gh is not logged in: run gh auth login"
fi

# ---- the worktree ------------------------------------------------------------
COMMIT=
if git -C "$HERE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	if git -C "$HERE" rev-parse -q --verify HEAD >/dev/null 2>&1; then
		COMMIT=$(git -C "$HERE" rev-parse HEAD)
	else
		warn "the repository has no commits yet; the release is not tied to one"
	fi
	DIRTY=$(git -C "$HERE" status --porcelain)
	if [ -n "$DIRTY" ] || [ -z "$COMMIT" ]; then
		if [ "$ALLOW_DIRTY" = 1 ]; then
			[ -z "$DIRTY" ] || warn "the worktree has uncommitted changes ($(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ') files); building them anyway"
		else
			if [ -n "$DIRTY" ]; then printf '%s\n' "$DIRTY" | sed -n '1,20p' >&2; fi
			die "the worktree is not a clean commit; commit first, or pass --allow-dirty"
		fi
	fi
else
	warn "$HERE is not a git repository; skipping the worktree check"
	[ "$ALLOW_DIRTY" = 1 ] || die "pass --allow-dirty to release from outside git"
fi

# ---- the API header ----------------------------------------------------------
set +e
sh "$HERE/tools/sync-api.sh" --check
rc=$?
set -e
case $rc in
0) ;;
77) warn "the game's es_api.h was not found (set ES_GAME); include/es_api.h (API $API) is unchecked" ;;
*) die "include/es_api.h differs from the game's; run tools/sync-api.sh, rebuild and commit" ;;
esac

# ---- build -------------------------------------------------------------------
# Host compiler flags (e.g. Homebrew LLVM's LDFLAGS/CPPFLAGS) are for this machine,
# not for the cross targets, so keep them out of every build.
unset CFLAGS CPPFLAGS CXXFLAGS LDFLAGS
# name -> zig target, toolchain file, library, arch, min OS check
target_info() {
	case $1 in
	macos-arm64) T=aarch64-macos.11.0 TC=zig-macos.cmake LIB=libesdado.dylib ARCH=aarch64 CHECK="--minos aarch64=11.0" ;;
	macos-x86_64) T=x86_64-macos.10.15 TC=zig-macos.cmake LIB=libesdado.dylib ARCH=x86_64 CHECK="--minos x86_64=10.15" ;;
	linux-x86_64) T=x86_64-linux-gnu.$GLIBC TC=zig-linux.cmake LIB=libesdado.so ARCH=x86_64 CHECK="--glibc-max $GLIBC" ;;
	linux-aarch64) T=aarch64-linux-gnu.$GLIBC TC=zig-linux.cmake LIB=libesdado.so ARCH=aarch64 CHECK="--glibc-max $GLIBC" ;;
	windows-x86_64) T=x86_64-windows-gnu TC=zig-windows.cmake LIB=esdado.dll ARCH=x86_64 CHECK= ;;
	esac
}

BUILD="$HERE/build-release"
mkdir -p "$BUILD"
for t in $TARGETS; do
	target_info "$t"
	B="$BUILD/$t"
	say "== building $t ($T)"
	# From clean, in the same folder each time: Dado's engine cache is keyed by
	# the compiler wrapper's path, so the engine builds once per target.
	rm -rf "$B"
	mkdir -p "$B"
	# Inside the build folder: zig's compiler checks leave a.o where they run.
	if ! (cd "$B" && ZIG_TARGET=$T cmake -S "$HERE" -B "$B" -G "$GENERATOR" \
			-DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
			-DCMAKE_TOOLCHAIN_FILE="$HERE/tools/$TC" -DLOADER_VERSION="$VERSION" \
			&& cmake --build "$B") >"$BUILD/$t.log" 2>&1; then
		tail -n 40 "$BUILD/$t.log" >&2
		die "$t did not build (the whole log: $BUILD/$t.log)"
	fi
	[ -f "$B/$LIB" ] || die "$t built no $LIB"
done

# ---- check -------------------------------------------------------------------
FAILED=
for t in $TARGETS; do
	target_info "$t"
	say "== checking $t"
	if command -v file >/dev/null 2>&1; then say "  file: $(file -b "$BUILD/$t/$LIB")"; fi
	# shellcheck disable=SC2086
	$REL "$RELPY" inspect "$BUILD/$t/$LIB" --arch "$ARCH" --version "$VERSION" $CHECK || FAILED="$FAILED $t"
done
[ -z "$FAILED" ] || die "checks failed for:$FAILED"

# ---- macOS: one universal dylib ------------------------------------------------
UNI=
case " $TARGETS " in *" macos-arm64 "*) case " $TARGETS " in *" macos-x86_64 "*) UNI=$UNIVERSAL ;; esac ;; esac
if [ "$UNI" = 1 ]; then
	U="$BUILD/macos-universal"
	rm -rf "$U"; mkdir -p "$U"
	A="$BUILD/macos-arm64/libesdado.dylib" X="$BUILD/macos-x86_64/libesdado.dylib"
	# /usr/bin/lipo on a Mac without the command-line tools is a stub that asks
	# to install them; use it only when they are there.
	HAVE_LIPO=0
	if command -v lipo >/dev/null 2>&1; then
		if [ "$(uname -s)" != Darwin ] || xcode-select -p >/dev/null 2>&1; then HAVE_LIPO=1; fi
	fi
	if [ "$HAVE_LIPO" = 1 ] && lipo -create -output "$U/libesdado.dylib" "$X" "$A" 2>/dev/null; then
		HOW=lipo
	elif command -v llvm-lipo >/dev/null 2>&1 && llvm-lipo -create -output "$U/libesdado.dylib" "$X" "$A"; then
		HOW=llvm-lipo
	else
		# zig has no lipo; the fat format is two headers and the slices.
		$REL "$RELPY" lipo "$U/libesdado.dylib" "$X" "$A"
		HOW="tools/release.py lipo"
	fi
	say "== checking macos-universal (made with $HOW)"
	if command -v file >/dev/null 2>&1; then say "  file: $(file -b "$U/libesdado.dylib")"; fi
	$REL "$RELPY" inspect "$U/libesdado.dylib" --arch aarch64,x86_64 --version "$VERSION" \
		--minos aarch64=11.0 --minos x86_64=10.15 || die "the universal dylib failed its checks"
fi

# ---- test on this host -----------------------------------------------------------
HOST=
case "$(uname -s)-$(uname -m)" in
Darwin-arm64) HOST=macos-arm64 ;;
Darwin-x86_64) HOST=macos-x86_64 ;;
Linux-x86_64) HOST=linux-x86_64 ;;
Linux-aarch64|Linux-arm64) HOST=linux-aarch64 ;;
esac
TESTED=
if [ "$SKIP_TESTS" = 1 ]; then
	warn "--skip-tests: no test was run"
elif [ -z "$HOST" ] || ! case " $TARGETS " in *" $HOST "*) true ;; *) false ;; esac; then
	warn "none of the targets built runs on this host ($(uname -s) $(uname -m)); no test was run"
else
	TESTLIB="$BUILD/$HOST/$( target_info "$HOST"; printf '%s' "$LIB" )"
	# On a Mac, the dylib that ships: the universal one.
	case $HOST in macos-*) if [ "$UNI" = 1 ]; then TESTLIB="$BUILD/macos-universal/libesdado.dylib"; fi ;; esac
	say "== testing $TESTLIB in the fake host (tools/dado-mods.sh test)"
	ESDADO_LIB=$TESTLIB sh "$HERE/tools/dado-mods.sh" test >"$BUILD/test.log" 2>&1 || {
		tail -n 40 "$BUILD/test.log" >&2
		die "the fake-host test failed (the whole log: $BUILD/test.log)"
	}
	tail -n 3 "$BUILD/test.log" | sed 's/^/  /'
	TESTED=$HOST
fi

# ---- package ---------------------------------------------------------------------
DIST="$HERE/dist/$VERSION"
rm -rf "$DIST"
mkdir -p "$DIST/.stage"
STAGE="$DIST/.stage"
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then MTIME=$SOURCE_DATE_EPOCH
elif [ -n "$COMMIT" ]; then MTIME=$(git -C "$HERE" log -1 --format=%ct "$COMMIT")
else MTIME=315532800   # 1980-01-01, the earliest a zip can say
fi

cat > "$STAGE/INSTALL.txt" <<EOF
Dado loader $VERSION for Endless Sky (mod API $API)

This is a mod loader: a library the game opens from a "modloaders" folder.
It needs an Endless Sky build with mod API $API: Argosy, from
https://$GAME_RELEASES
Argosy's releases already include a version of this loader; install this one
only to use a different version.

Copy the library into the modloaders folder of Argosy's config folder (make
the folder if it is not there). A library there replaces the bundled one:

  macOS    ~/Library/Application Support/argosy/modloaders/libesdado.dylib
  Linux    ~/.local/share/argosy/modloaders/libesdado.so
           (or \$XDG_DATA_HOME/argosy/modloaders)
  Windows  %APPDATA%\\argosy\\modloaders\\esdado.dll

The game also reads the "modloaders" folder next to its data folder. Mods go
in a plugin's scripts/ folder; see README.md.

macOS: a library downloaded with a browser is quarantined, and macOS will
not load it into the game. Clear the flag after copying it:

  xattr -d com.apple.quarantine ~/Library/Application\\ Support/argosy/modloaders/libesdado.dylib

The library is signed ad hoc, not notarized. A game built with the hardened
runtime loads it only with library validation disabled; a game you build
yourself loads it as is.

The game's log names each loader it opens, and this one logs each mod it
loads ("dado: loaded mod ...").

Minimum systems: macOS 11 (Apple Silicon) or 10.15 (Intel); Linux with
glibc $GLIBC or later (x86_64, aarch64); Windows 10 x86_64 (untested in
the game).
EOF

# Licences of what is linked in: Dado's runtime (in the harness) and QuickJS-ng.
EXTRA=
DADO_ROOT=$(dado where --no-update-check 2>/dev/null | sed -n 's/^root=//p')
if [ -n "$DADO_ROOT" ] && [ -f "$DADO_ROOT/LICENSE" ]; then
	cp "$DADO_ROOT/LICENSE" "$STAGE/Dado-LICENSE.txt"
	EXTRA="$EXTRA licenses/Dado.txt=$STAGE/Dado-LICENSE.txt"
else
	warn "Dado's LICENSE was not found; packages ship without it"
fi
QJS=
# shellcheck disable=SC2086
first=$(set -- $TARGETS; printf '%s' "$1")
ENGINE=$(sed -n 's/.*esdado: script engine in //p' "$BUILD/$first.log" | tail -n 1)
if [ -n "$ENGINE" ] && [ -f "$ENGINE/PROVENANCE" ]; then
	PS=$(sed -n 's/^patchset=//p' "$ENGINE/PROVENANCE")
	CACHE=$(dirname "$(dirname "$(dirname "$ENGINE")")")
	if [ -f "$CACHE/tree/$PS/LICENSE" ]; then QJS="$CACHE/tree/$PS/LICENSE"; fi
fi
if [ -n "$QJS" ]; then
	cp "$QJS" "$STAGE/QuickJS-LICENSE.txt"
	EXTRA="$EXTRA licenses/QuickJS-ng.txt=$STAGE/QuickJS-LICENSE.txt"
else
	warn "QuickJS-ng's LICENSE was not found in the engine cache; packages ship without it"
fi
LICENSE=
for f in LICENSE LICENSE.txt LICENSE.md COPYING; do
	if [ -f "$HERE/$f" ]; then LICENSE="$f=$HERE/$f"; break; fi
done
[ -n "$LICENSE" ] || warn "the repository has no LICENSE file: the packages ship without one (add one before publishing)"

pack() {   # pack <platform> <archive ext> <library path>
	name="es-modloader-$VERSION-$1"
	# shellcheck disable=SC2086
	$REL "$RELPY" pack "$DIST/$name.$2" --mtime "$MTIME" --root "$name" \
		"$(basename "$3")=$3" "README.md=$HERE/README.md" "INSTALL.txt=$STAGE/INSTALL.txt" $LICENSE $EXTRA
	ASSETS="$ASSETS $name.$2"
}
ASSETS=
if [ "$UNI" = 1 ]; then
	pack macos-universal zip "$BUILD/macos-universal/libesdado.dylib"
else
	for t in macos-arm64 macos-x86_64; do
		case " $TARGETS " in *" $t "*) pack "$t" zip "$BUILD/$t/libesdado.dylib" ;; esac
	done
fi
for t in linux-x86_64 linux-aarch64; do
	case " $TARGETS " in *" $t "*) pack "$t" tar.gz "$BUILD/$t/libesdado.so" ;; esac
done
case " $TARGETS " in *" windows-x86_64 "*) pack windows-x86_64 zip "$BUILD/windows-x86_64/esdado.dll" ;; esac
rm -rf "$STAGE"
# shellcheck disable=SC2086
$REL "$RELPY" sums "$DIST" $ASSETS > "$DIST/SHA256SUMS"
ASSETS="$ASSETS SHA256SUMS"

# ---- release notes -------------------------------------------------------------
NOTES="$DIST/RELEASE_NOTES.md"
{
	say "Dado loader $VERSION for Endless Sky: runs mods written in DadoScript or plain JavaScript."
	say
	say "**Requires an Endless Sky build with mod API $API**, e.g. from $GAME_RELEASES."
	say
	say "| | |"
	say "|---|---|"
	say "| Loader version | $VERSION |"
	say "| Mod API | $API |"
	if [ -n "$COMMIT" ]; then say "| Commit | $COMMIT |"; fi
	say "| Built with | zig $("$ZIG" version), $(dadoc --version 2>/dev/null | head -n 1 || echo 'dadoc ?') |"
	say
	say "| Download | Platform | Minimum |"
	say "|---|---|---|"
	for a in $ASSETS; do
		case $a in
		*macos-universal*) say "| \`$a\` | macOS, Apple Silicon and Intel (universal) | macOS 11 (arm64), 10.15 (x86_64) |" ;;
		*macos-arm64*) say "| \`$a\` | macOS, Apple Silicon | macOS 11 |" ;;
		*macos-x86_64*) say "| \`$a\` | macOS, Intel | macOS 10.15 |" ;;
		*linux-x86_64*) say "| \`$a\` | Linux x86_64 | glibc $GLIBC |" ;;
		*linux-aarch64*) say "| \`$a\` | Linux aarch64 | glibc $GLIBC |" ;;
		*windows-x86_64*) say "| \`$a\` | Windows x86_64 (not yet tried in the game) | Windows 10 |" ;;
		esac
	done
	say
	say "Argosy's releases bundle a version of this loader. To use this one instead, copy the library into"
	say "the \`modloaders\` folder of Argosy's config folder (INSTALL.txt in each archive names it for each"
	say "system). On macOS, clear the download quarantine first:"
	say "\`xattr -d com.apple.quarantine libesdado.dylib\`."
	say
	if [ -n "$TESTED" ]; then
		say "Tested: the $TESTED build passed the loader's fake-host test suite before release."
		say
	fi
	say "SHA-256:"
	say
	say '```'
	cat "$DIST/SHA256SUMS"
	say '```'
} > "$NOTES"

say
say "== dist/$VERSION"
for a in $ASSETS; do
	say "  $a ($(wc -c < "$DIST/$a" | tr -d ' ') bytes)"
done
say "  RELEASE_NOTES.md"

# ---- publish ---------------------------------------------------------------------
# Run from the repository, with paths relative to it.
set -- release create "v$VERSION"
for a in $ASSETS; do set -- "$@" "dist/$VERSION/$a"; done
set -- "$@" --repo "$REPO" --title "Dado loader $VERSION" --notes-file "dist/$VERSION/RELEASE_NOTES.md"
case $VERSION in *-*) set -- "$@" --prerelease ;; esac
if git -C "$HERE" rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
	set -- "$@" --verify-tag     # the tag must already be on GitHub: git push origin v$VERSION
elif [ -n "$COMMIT" ]; then
	set -- "$@" --target "$COMMIT"   # the commit must already be on GitHub: git push
fi
if [ "$PUBLISH" = 1 ]; then
	[ -n "$LICENSE" ] || warn "publishing without a LICENSE"
	say "== publishing v$VERSION to $REPO"
	(cd "$HERE" && gh "$@")
	say "published: https://github.com/$REPO/releases/tag/v$VERSION"
else
	say
	say "Not published. To publish, rerun with --publish, or run (from $HERE):"
	line="gh"
	for w in "$@"; do
		case $w in
		*[!A-Za-z0-9_./:=+-]*) line="$line '$(printf '%s' "$w" | sed "s/'/'\\\\''/g")'" ;;
		*) line="$line $w" ;;
		esac
	done
	say "  $line"
fi
