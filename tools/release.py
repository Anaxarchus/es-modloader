#!/usr/bin/env python3
"""Helpers for tools/release.sh, in Python so they behave the same on macOS and
Linux and need no binutils, LLVM tools or GNU flags:

  release.py inspect <lib> --arch A[,A] [--version V] [--minos A=X.Y ...]
                     [--glibc-max X.Y]
      Checks a built loader: its format and architecture (Mach-O, fat Mach-O,
      ELF or PE), that it exports es_loader_init and nothing else, that it
      names "Dado loader <V>", the minimum macOS of each Mach-O slice, the
      newest GLIBC_ symbol version an ELF library asks for, and the DLLs a PE
      library imports (system DLLs only). Exits 1 on a failed check.
  release.py lipo <out> <thin.dylib>...
      Writes a universal (fat) Mach-O from thin ones, laid out as Apple's lipo
      does (slices in order of alignment, each page-aligned). For hosts with
      neither lipo nor llvm-lipo.
  release.py pack <out.zip|out.tar.gz> --mtime N --root DIR <name>=<path>...
      A reproducible archive: entries sorted, under DIR/, every timestamp N
      (seconds since 1970), owner 0, fixed modes (0755 for libraries).
  release.py sums <dir> <file>...
      Prints "<sha256>  <file>" lines, as shasum -a 256 / sha256sum do.
"""
import argparse, gzip, hashlib, io, os, struct, sys, tarfile, time, zipfile

EXPORT = "es_loader_init"

def fail(msg):
    print("  FAIL: " + msg)
    return False

def ok(msg):
    print("  ok: " + msg)
    return True

# ---------------------------------------------------------------- Mach-O
CPU = {0x0100000C: "aarch64", 0x01000007: "x86_64"}
LINKER_SYMBOLS = {"_mh_dylib_header", "__dso_handle", "_mh_execute_header"}

def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if not x & 0x80:
            return r, i

def trie_exports(b, start, size):
    out = []
    def walk(off, prefix, depth):
        if depth > 64 or off >= size:
            return
        i = start + off
        tsize, i = uleb(b, i)
        if tsize:
            out.append(prefix)
        i += tsize
        n = b[i]; i += 1
        for _ in range(n):
            e = b.index(b"\0", i)
            edge = b[i:e].decode("latin-1"); i = e + 1
            child, i = uleb(b, i)
            walk(child, prefix + edge, depth + 1)
    walk(0, "", 0)
    return out

def vers(v):
    return "%d.%d" % (v >> 16, (v >> 8) & 0xFF) + ("" if not v & 0xFF else ".%d" % (v & 0xFF))

def macho_slice(b, base, want_arch, minos_want):
    good = True
    magic, cpu, sub, ftype, ncmds, sizeofcmds, flags, _ = struct.unpack_from("<IiiIIIII", b, base)
    if magic != 0xFEEDFACF:
        return fail("slice at %d is not a 64-bit little-endian Mach-O" % base)
    arch = CPU.get(cpu & 0xFFFFFFFF, hex(cpu))
    good &= ok("Mach-O %s dylib" % arch) if ftype == 6 and arch == want_arch else \
        fail("Mach-O filetype %d arch %s, expected a dylib for %s" % (ftype, arch, want_arch))
    i = base + 32
    minos = None; exports = None; syms = []; dylibs = []; signed = False
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", b, i)
        if cmd == 0x32:  # LC_BUILD_VERSION
            platform, mo, sdk = struct.unpack_from("<III", b, i + 8)
            minos = vers(mo)
        elif cmd == 0x24:  # LC_VERSION_MIN_MACOSX
            minos = vers(struct.unpack_from("<I", b, i + 8)[0])
        elif cmd in (0x22, 0x80000022):  # LC_DYLD_INFO(_ONLY)
            eo, es = struct.unpack_from("<II", b, i + 40)
            if es:
                exports = trie_exports(b, base + eo, es)
        elif cmd == 0x80000033:  # LC_DYLD_EXPORTS_TRIE
            eo, es = struct.unpack_from("<II", b, i + 8)
            if es:
                exports = trie_exports(b, base + eo, es)
        elif cmd == 0x2:  # LC_SYMTAB
            so, ns, sto, sts = struct.unpack_from("<IIII", b, i + 8)
            for k in range(ns):
                strx, typ, sect, desc, val = struct.unpack_from("<IBBHQ", b, base + so + 16 * k)
                if typ & 0xE0 or not typ & 1 or typ & 0x10 or (typ & 0x0E) != 0x0E:
                    continue  # stabs, local, private extern, undefined
                e = b.index(b"\0", base + sto + strx)
                syms.append(b[base + sto + strx:e].decode("latin-1"))
        elif cmd in (0xC, 0x80000018, 0x8000001F):  # LC_LOAD_DYLIB, weak, reexport
            off = struct.unpack_from("<I", b, i + 8)[0]
            e = b.index(b"\0", i + off)
            dylibs.append(b[i + off:e].decode("latin-1"))
        elif cmd == 0x1D:
            signed = True
        i += size
    names = sorted(n[1:] if n.startswith("_") else n for n in (exports if exports is not None else syms))
    src = "export trie" if exports is not None else "symbol table"
    # Symbols the linker itself defines in every image (zig's linker lists
    # them in the trie); no code of the loader is reachable through them.
    synth = [n for n in names if n in LINKER_SYMBOLS]
    names = [n for n in names if n not in LINKER_SYMBOLS]
    note = "; plus the linker's %s" % ", ".join(synth) if synth else ""
    good &= ok("exports only %s (%s%s)" % (EXPORT, src, note)) if names == [EXPORT] else \
        fail("exports %s (%s), expected only %s" % (names, src, EXPORT))
    if minos_want:
        good &= ok("minos %s" % minos) if minos == minos_want else \
            fail("minos %s, expected %s" % (minos, minos_want))
    else:
        print("  minos %s" % minos)
    bad = [d for d in dylibs if not (d.startswith("/usr/lib/") or d.startswith("/System/"))]
    good &= ok("links only system libraries: %s" % ", ".join(dylibs)) if not bad else \
        fail("links non-system libraries: %s" % bad)
    if arch == "aarch64":
        good &= ok("code signature present (ad hoc)") if signed else fail("arm64 slice is not signed")
    return good

def inspect_macho(b, archs, minos):
    good = True
    if struct.unpack_from(">I", b, 0)[0] == 0xCAFEBABE:
        n = struct.unpack_from(">I", b, 4)[0]
        slices = [struct.unpack_from(">iiIII", b, 8 + 20 * k) for k in range(n)]
        got = [CPU.get(s[0] & 0xFFFFFFFF, hex(s[0])) for s in slices]
        print("  universal Mach-O: %s" % ", ".join(got))
        good &= ok("slices %s" % got) if sorted(got) == sorted(archs) else \
            fail("slices %s, expected %s" % (got, archs))
        for (cpu, sub, off, size, align), arch in zip(slices, got):
            print(" [%s slice]" % arch)
            good &= macho_slice(b, off, arch, minos.get(arch))
        return good
    return macho_slice(b, 0, archs[0], minos.get(archs[0])) if len(archs) == 1 else \
        fail("a thin Mach-O, expected slices %s" % archs)

# ---------------------------------------------------------------- ELF
ELF_MACHINE = {0xB7: "aarch64", 0x3E: "x86_64"}

def inspect_elf(b, archs, glibc_max):
    good = True
    if b[4] != 2 or b[5] != 1:
        return fail("not a 64-bit little-endian ELF")
    etype, mach = struct.unpack_from("<HH", b, 16)
    arch = ELF_MACHINE.get(mach, hex(mach))
    good &= ok("ELF %s shared object" % arch) if etype == 3 and [arch] == archs else \
        fail("ELF type %d arch %s, expected a shared object for %s" % (etype, arch, archs))
    shoff, = struct.unpack_from("<Q", b, 40)
    shentsize, shnum = struct.unpack_from("<HH", b, 58)
    secs = [struct.unpack_from("<IIQQQQIIQQ", b, shoff + k * shentsize) for k in range(shnum)]
    def strat(sec, off):
        o = sec[4] + off
        return b[o:b.index(b"\0", o)].decode("latin-1")
    exports = []; needed = []; glibc = []
    for s in secs:
        name, typ, flags, addr, off, size, link, info, align, entsize = s
        if typ == 11:  # SHT_DYNSYM
            strs = secs[link]
            for k in range(1, size // 24):
                st_name, st_info, st_other, st_shndx, val, sz = struct.unpack_from("<IBBHQQ", b, off + 24 * k)
                if st_shndx != 0 and (st_info >> 4) in (1, 2) and (st_other & 3) in (0, 3) and (st_info & 0xF) != 4:
                    exports.append(strat(strs, st_name))
        elif typ == 6:  # SHT_DYNAMIC
            strs = secs[link]
            for k in range(size // 16):
                tag, val = struct.unpack_from("<qQ", b, off + 16 * k)
                if tag == 1:
                    needed.append(strat(strs, val))
        elif typ == 0x6FFFFFFE:  # SHT_GNU_verneed
            strs = secs[link]; o = off
            while True:
                ver, cnt, file_, aux, nxt = struct.unpack_from("<HHIII", b, o)
                a = o + aux
                for _ in range(cnt):
                    h, fl, other, nm, anext = struct.unpack_from("<IHHII", b, a)
                    glibc.append((strat(strs, file_), strat(strs, nm)))
                    if not anext:
                        break
                    a += anext
                if not nxt:
                    break
                o += nxt
    exports = sorted(set(exports))
    good &= ok("exports only %s" % EXPORT) if exports == [EXPORT] else \
        fail("exports %s, expected only %s" % (exports, EXPORT))
    allowed = ("libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1")
    bad = [n for n in needed if n not in allowed and not n.startswith("ld-linux")]
    good &= ok("needs only %s" % ", ".join(needed)) if not bad else fail("needs non-system libraries %s" % bad)
    def key(v):
        return tuple(int(x) for x in v.split("_", 1)[1].split("."))
    gv = sorted({v for f, v in glibc if v.startswith("GLIBC_") and v[6:7].isdigit()}, key=key)
    newest = gv[-1] if gv else None
    if glibc_max:
        good &= ok("newest glibc symbol version %s (max GLIBC_%s)" % (newest, glibc_max)) \
            if newest is None or key(newest) <= key("GLIBC_" + glibc_max) else \
            fail("asks for %s, newer than GLIBC_%s" % (newest, glibc_max))
    else:
        print("  newest glibc symbol version %s" % newest)
    return good

# ---------------------------------------------------------------- PE
PE_MACHINE = {0x8664: "x86_64", 0xAA64: "aarch64"}
SYSTEM_DLLS = {"kernel32.dll", "ntdll.dll", "msvcrt.dll", "ucrtbase.dll", "advapi32.dll", "user32.dll",
               "ws2_32.dll", "bcrypt.dll", "bcryptprimitives.dll", "shell32.dll", "ole32.dll", "userenv.dll",
               "synchronization.dll"}

def inspect_pe(b, archs):
    good = True
    pe = struct.unpack_from("<I", b, 0x3C)[0]
    if b[pe:pe + 4] != b"PE\0\0":
        return fail("no PE signature")
    mach, nsec, stamp, _, _, optsize, chars = struct.unpack_from("<HHIIIHH", b, pe + 4)
    arch = PE_MACHINE.get(mach, hex(mach))
    opt = pe + 24
    magic = struct.unpack_from("<H", b, opt)[0]
    good &= ok("PE32+ %s DLL" % arch) if chars & 0x2000 and magic == 0x20B and [arch] == archs else \
        fail("PE machine %s characteristics %#x magic %#x, expected a PE32+ DLL for %s" % (arch, chars, magic, archs))
    print("  COFF timestamp %d%s" % (stamp, " (zero: reproducible)" if stamp == 0 else ""))
    ndirs = struct.unpack_from("<I", b, opt + 108)[0]
    dirs = [struct.unpack_from("<II", b, opt + 112 + 8 * k) for k in range(ndirs)]
    sects = [struct.unpack_from("<8sIIII", b, opt + optsize + 40 * k) for k in range(nsec)]
    def off(rva):
        for name, vsize, va, rsize, raw in sects:
            if va <= rva < va + max(vsize, rsize):
                return rva - va + raw
        raise ValueError("rva %#x in no section" % rva)
    def cstr(rva):
        o = off(rva)
        return b[o:b.index(b"\0", o)].decode("latin-1")
    exports = []
    if ndirs > 0 and dirs[0][0]:
        e = off(dirs[0][0])
        nnames, _, names_rva = struct.unpack_from("<III", b, e + 24)
        nfuncs = struct.unpack_from("<I", b, e + 20)[0]
        for k in range(nnames):
            exports.append(cstr(struct.unpack_from("<I", b, off(names_rva) + 4 * k)[0]))
        if nfuncs != nnames:
            exports.append("(%d exported by ordinal only)" % (nfuncs - nnames))
    exports.sort()
    good &= ok("exports only %s" % EXPORT) if exports == [EXPORT] else \
        fail("exports %s, expected only %s" % (exports, EXPORT))
    imports = []
    for d, size in ((1, 20), (13, 32)):  # imports, delay-load imports
        if ndirs > d and dirs[d][0]:
            o = off(dirs[d][0])
            while True:
                ent = b[o:o + size]
                if ent == b"\0" * size:
                    break
                imports.append(cstr(struct.unpack_from("<I", ent, 12 if d == 1 else 4)[0]))
                o += size
    bad = [i for i in imports if i.lower() not in SYSTEM_DLLS and not i.lower().startswith("api-ms-win-")]
    good &= ok("imports only system DLLs: %s" % ", ".join(imports)) if not bad else \
        fail("imports non-system DLLs %s (the game does not search beside the loader)" % bad)
    return good

def cmd_inspect(a):
    b = open(a.lib, "rb").read()
    archs = a.arch.split(",")
    minos = dict(m.split("=", 1) for m in a.minos)
    print("%s (%d bytes)" % (a.lib, len(b)))
    m4 = b[:4]
    if m4 in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        good = inspect_macho(b, archs, minos)
    elif m4 == b"\x7fELF":
        good = inspect_elf(b, archs, a.glibc_max)
    elif b[:2] == b"MZ":
        good = inspect_pe(b, archs)
    else:
        good = fail("not a Mach-O, ELF or PE file")
    if a.version:
        name = ("Dado loader " + a.version).encode()
        # NUL-terminated, so 0.1.0 is not found inside 0.1.0-test.
        good &= ok("names \"%s\"" % name.decode()) if name + b"\0" in b else \
            fail("does not name \"%s\"" % name.decode())
    return 0 if good else 1

# ---------------------------------------------------------------- lipo
def cmd_lipo(a):
    thins = []
    for p in a.inputs:
        b = open(p, "rb").read()
        magic, cpu, sub = struct.unpack_from("<Iii", b, 0)
        if magic != 0xFEEDFACF:
            sys.exit("release.py lipo: %s is not a thin 64-bit Mach-O" % p)
        align = 14 if cpu & 0xFFFFFFFF == 0x0100000C else 12
        thins.append((align, cpu & 0xFFFFFFFF, sub & 0xFFFFFFFF, b))
    thins.sort(key=lambda t: (t[0], t[1]))
    head = struct.pack(">II", 0xCAFEBABE, len(thins))
    offset = 8 + 20 * len(thins)
    arches = b""; body = b""
    for align, cpu, sub, b in thins:
        pad = (-offset) % (1 << align)
        body += b"\0" * pad; offset += pad
        arches += struct.pack(">IIIII", cpu, sub, offset, len(b), align)
        body += b; offset += len(b)
    with open(a.out, "wb") as f:
        f.write(head + arches + body)
    return 0

# ---------------------------------------------------------------- pack
def cmd_pack(a):
    entries = []
    for spec in a.files:
        name, path = spec.split("=", 1)
        entries.append((a.root + "/" + name, open(path, "rb").read()))
    entries.sort()
    def mode(name):
        return 0o755 if name.endswith((".dylib", ".so", ".dll")) else 0o644
    if a.out.endswith(".zip"):
        dt = time.gmtime(max(a.mtime, 315532800))[:6]
        with zipfile.ZipFile(a.out, "w") as z:
            dirs = sorted({n.rsplit("/", 1)[0] + "/" for n, _ in entries})
            for d in dirs:
                zi = zipfile.ZipInfo(d, dt); zi.create_system = 3
                zi.external_attr = (0o40755 << 16) | 0x10
                z.writestr(zi, b"")
            for name, data in entries:
                zi = zipfile.ZipInfo(name, dt); zi.create_system = 3
                zi.external_attr = (0o100000 | mode(name)) << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, data, compresslevel=9)
    elif a.out.endswith(".tar.gz"):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as t:
            def info(name, typ, m, size=0):
                ti = tarfile.TarInfo(name); ti.type = typ; ti.mode = m; ti.size = size
                ti.mtime = a.mtime; ti.uid = ti.gid = 0; ti.uname = ti.gname = ""
                return ti
            for d in sorted({n.rsplit("/", 1)[0] for n, _ in entries}):
                t.addfile(info(d, tarfile.DIRTYPE, 0o755))
            for name, data in entries:
                t.addfile(info(name, tarfile.REGTYPE, mode(name), len(data)), io.BytesIO(data))
        with open(a.out, "wb") as f:
            with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=a.mtime, compresslevel=9) as g:
                g.write(raw.getvalue())
    else:
        sys.exit("release.py pack: %s is neither .zip nor .tar.gz" % a.out)
    return 0

def cmd_sums(a):
    for f in a.files:
        h = hashlib.sha256(open(os.path.join(a.dir, f), "rb").read()).hexdigest()
        print("%s  %s" % (h, f))
    return 0

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("inspect"); i.add_argument("lib"); i.add_argument("--arch", required=True)
    i.add_argument("--version"); i.add_argument("--minos", action="append", default=[])
    i.add_argument("--glibc-max")
    l = sp.add_parser("lipo"); l.add_argument("out"); l.add_argument("inputs", nargs="+")
    k = sp.add_parser("pack"); k.add_argument("out"); k.add_argument("--mtime", type=int, required=True)
    k.add_argument("--root", required=True); k.add_argument("files", nargs="+")
    s = sp.add_parser("sums"); s.add_argument("dir"); s.add_argument("files", nargs="+")
    a = p.parse_args()
    return {"inspect": cmd_inspect, "lipo": cmd_lipo, "pack": cmd_pack, "sums": cmd_sums}[a.cmd](a)

if __name__ == "__main__":
    sys.exit(main())
