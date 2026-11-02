#!/usr/bin/env python3
"""Build and package the mini-notes-summarizer Executa as Anna binary archives.

Archive layout (one archive per platform key):

    manifest.json                    <- archive root manifest (runtime.binary.entrypoint ...)
    bin/mini-notes-summarizer        <- entrypoint (mode 0755)         [darwin / linux]
    bin/mini-notes-summarizer.exe    <- entrypoint                     [windows]

Release assets:   <name>-<platform>.tar.gz   (darwin-*, linux-*)
                  <name>-<platform>.zip      (windows-*)

Usage:
    python3 scripts/package_executa.py                 # THIS machine's platform only
    python3 scripts/package_executa.py --all           # darwin-arm64, darwin-x86_64, windows-x86_64
    python3 scripts/package_executa.py --target darwin-arm64 --target windows-x86_64
    python3 scripts/package_executa.py --verify dist-executa/<archive>

Only the Python standard library and a Go toolchain are required. Go
cross-compiles with CGO disabled, so every platform can be built from any host.
The packaged binary of the host's own platform is also executed (smoke test);
binaries for other platforms cannot run here, so they are instead checked by
reading their executable header (format + CPU architecture).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXECA_DIR = ROOT / "executas" / "mini-notes-summarizer"

# Anna platform key -> (GOOS, GOARCH, archive format, exe suffix)
PLATFORMS: dict[str, tuple[str, str, str, str]] = {
    "darwin-arm64": ("darwin", "arm64", "tar.gz", ""),
    "darwin-x86_64": ("darwin", "amd64", "tar.gz", ""),
    "windows-x86_64": ("windows", "amd64", "zip", ".exe"),
    # Convenience only (e.g. building/testing on a Linux box); not released by CI.
    "linux-x86_64": ("linux", "amd64", "tar.gz", ""),
    "linux-aarch64": ("linux", "arm64", "tar.gz", ""),
}
RELEASE_PLATFORMS = ["darwin-arm64", "darwin-x86_64", "windows-x86_64"]

FIXED_MTIME = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))  # reproducible archives


# ── platform detection ───────────────────────────────────────────────
def host_platform_key() -> str:
    """Anna platform key of the machine running this script."""
    system = platform.system().lower()  # darwin | linux | windows
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x86_64", "amd64": "x86_64"}.get(machine)

    # A Python running under Rosetta 2 reports x86_64 on an Apple Silicon Mac;
    # ask the kernel for the real hardware.
    if system == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True, timeout=5)
            if out.returncode == 0 and out.stdout.strip() == "1":
                arch = "arm64"
        except (OSError, subprocess.SubprocessError):
            pass

    if system == "linux" and arch == "arm64":
        arch = "aarch64"  # Anna's linux key spelling
    key = f"{system}-{arch}"
    if arch is None or key not in PLATFORMS:
        sys.exit(f"unsupported host platform: {platform.system()} {platform.machine()} (key {key!r}); "
                 f"supported: {', '.join(PLATFORMS)}")
    return key


# ── building ─────────────────────────────────────────────────────────
def require_go() -> None:
    if shutil.which("go") is None:
        sys.exit("Go toolchain not found on PATH. Install Go 1.21+ (https://go.dev/dl/).")


def go_build(out: Path, goos: str | None = None, goarch: str | None = None) -> None:
    env = dict(os.environ, CGO_ENABLED="0")
    if goos:
        env["GOOS"] = goos
    if goarch:
        env["GOARCH"] = goarch
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(out), "."],
        cwd=EXECA_DIR, env=env, check=True,
    )


def jsonrpc_once(exe: Path, method: str) -> dict:
    """Send one JSON-RPC request to the binary, close stdin, return the result."""
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method}) + "\n"
    p = subprocess.run([str(exe)], input=req, capture_output=True, text=True, timeout=30)
    line = next((l for l in p.stdout.splitlines() if l.strip()), "")
    if not line:
        raise RuntimeError(f"{exe} produced no stdout for {method!r}; stderr: {p.stderr.strip()}")
    msg = json.loads(line)  # raises if stdout is polluted with non-JSON
    if "result" not in msg:
        raise RuntimeError(f"{method} failed: {msg}")
    return msg["result"]


# ── archive manifest ─────────────────────────────────────────────────
def archive_manifest(described: dict) -> dict:
    """Archive-root manifest.json. Identity fields come straight from the
    binary's own `describe`, so name/version can never drift from the code."""
    name = described["name"]
    exe_posix = f"bin/{name}"
    return {
        "name": name,
        "display_name": described["display_name"],
        "version": described["version"],
        "description": described["description"],
        "author": described.get("author", ""),
        "runtime": {
            "binary": {
                "entrypoint": {
                    "default": exe_posix,
                    "windows-x86_64": exe_posix + ".exe",
                },
                "permissions": {exe_posix: "0o755"},
            }
        },
    }


# ── archive writers (deterministic) ──────────────────────────────────
def write_targz(path: Path, files: list[tuple[str, bytes, int]]) -> None:
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=FIXED_MTIME, compresslevel=9) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
                _tar_dir(tar, "bin")
                for arcname, data, mode in files:
                    info = tarfile.TarInfo(arcname)
                    info.size, info.mode, info.mtime = len(data), mode, FIXED_MTIME
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    tar.addfile(info, fileobj=_BytesReader(data))


def _tar_dir(tar: tarfile.TarFile, name: str) -> None:
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, FIXED_MTIME
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    tar.addfile(info)


class _BytesReader:
    def __init__(self, data: bytes):
        self._d, self._i = data, 0

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = len(self._d) - self._i
        chunk = self._d[self._i:self._i + n]
        self._i += len(chunk)
        return chunk


def write_zip(path: Path, files: list[tuple[str, bytes, int]]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        d = zipfile.ZipInfo("bin/", date_time=(1980, 1, 1, 0, 0, 0))
        d.external_attr = (0o40755 << 16) | 0x10
        zf.writestr(d, b"")
        for arcname, data, mode in files:
            zi = zipfile.ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o100000 | mode) << 16
            zf.writestr(zi, data)


# ── verification ─────────────────────────────────────────────────────
def binary_matches_platform(data: bytes, key: str) -> str | None:
    """Return None if the executable header matches the platform key, else why not."""
    goos = PLATFORMS[key][0]
    arch = key.split("-", 1)[1]
    if goos == "darwin":
        if data[:4] != b"\xcf\xfa\xed\xfe":  # MH_MAGIC_64, little-endian
            return f"not a 64-bit Mach-O (magic={data[:4].hex()})"
        cputype = struct.unpack("<I", data[4:8])[0]
        want = {"arm64": 0x0100000C, "x86_64": 0x01000007}[arch]
        return None if cputype == want else f"Mach-O cputype {cputype:#x}, want {want:#x}"
    if goos == "windows":
        if data[:2] != b"MZ":
            return "not a PE executable (missing MZ)"
        pe = struct.unpack("<I", data[0x3C:0x40])[0]
        if data[pe:pe + 4] != b"PE\0\0":
            return "bad PE signature"
        machine = struct.unpack("<H", data[pe + 4:pe + 6])[0]
        return None if machine == 0x8664 else f"PE machine {machine:#x}, want 0x8664 (AMD64)"
    if goos == "linux":
        if data[:4] != b"\x7fELF":
            return "not an ELF executable"
        machine = struct.unpack("<H", data[18:20])[0]
        want = {"x86_64": 0x3E, "aarch64": 0xB7}[arch]
        return None if machine == want else f"ELF e_machine {machine:#x}, want {want:#x}"
    return f"no header check for {goos}"


def platform_from_filename(path: Path) -> str:
    stem = path.name
    for suffix in (".tar.gz", ".zip"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    for key in PLATFORMS:
        if stem.endswith("-" + key):
            return key
    sys.exit(f"cannot derive platform key from archive name {path.name!r}")


def verify_archive(path: Path) -> list[str]:
    """Validate structure + root manifest.json. Returns the listing; exits on failure."""
    key = platform_from_filename(path)
    members: dict[str, tuple[bytes, int]] = {}
    if path.name.endswith(".zip"):
        with zipfile.ZipFile(path) as zf:
            for zi in zf.infolist():
                if not zi.is_dir():
                    members[zi.filename] = (zf.read(zi), (zi.external_attr >> 16) & 0o777)
            names = zf.namelist()
    else:
        with tarfile.open(path, "r:gz") as tar:
            names = tar.getnames()
            for ti in tar.getmembers():
                if ti.isfile():
                    members[ti.name] = (tar.extractfile(ti).read(), ti.mode & 0o777)

    def fail(msg: str) -> None:
        sys.exit(f"VERIFY FAILED ({path.name}): {msg}")

    bad = [n for n in names if n.startswith(("./", "/")) or ".." in Path(n).parts]
    if bad:
        fail(f"entries must be relative to the archive root without './': {bad}")
    if "manifest.json" not in members:
        fail("manifest.json is not at the archive root")
    manifest = json.loads(members["manifest.json"][0])
    for k in ("name", "display_name", "version", "description", "runtime"):
        if not manifest.get(k):
            fail(f"manifest.json missing {k!r}")
    binary = manifest["runtime"].get("binary") or fail("manifest.runtime.binary missing")
    entry_map = binary["entrypoint"]
    entry = entry_map.get(key) or entry_map["default"]
    if entry not in members:
        fail(f"entrypoint {entry!r} for {key} is not in the archive (have: {sorted(members)})")
    data, mode = members[entry]
    if PLATFORMS[key][0] != "windows" and not (mode & 0o111):
        fail(f"entrypoint {entry} is not executable (mode {mode:o})")
    if key.startswith("windows") and not entry.endswith(".exe"):
        fail("windows entrypoint must end with .exe")
    why = binary_matches_platform(data, key)
    if why:
        fail(f"entrypoint is not a {key} binary: {why}")
    perm = binary.get("permissions", {}).get(entry_map["default"])
    if perm != "0o755":
        fail(f"manifest permissions for {entry_map['default']!r} should be '0o755', got {perm!r}")
    return names


def smoke_test(archive: Path, key: str) -> None:
    """Extract the archive and run the entrypoint: describe must answer with JSON-RPC."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        if archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(td_path)
        else:
            with tarfile.open(archive, "r:gz") as tar:
                if hasattr(tarfile, "data_filter"):  # Python 3.12+: refuse unsafe members
                    tar.extractall(td_path, filter="data")
                else:
                    tar.extractall(td_path)
        manifest = json.loads((td_path / "manifest.json").read_text("utf-8"))
        em = manifest["runtime"]["binary"]["entrypoint"]
        exe = td_path / (em.get(key) or em["default"])
        if not exe.exists():
            sys.exit(f"SMOKE FAILED: {exe} missing after extraction")
        if os.name != "nt":
            exe.chmod(exe.stat().st_mode | 0o111)
        described = jsonrpc_once(exe, "describe")
        if described.get("name") != manifest["name"] or described.get("version") != manifest["version"]:
            sys.exit(f"SMOKE FAILED: describe {described.get('name')}@{described.get('version')} "
                     f"!= manifest {manifest['name']}@{manifest['version']}")
        if described.get("host_capabilities") != ["llm.sample"]:
            sys.exit(f"SMOKE FAILED: host_capabilities = {described.get('host_capabilities')}")


# ── packaging ────────────────────────────────────────────────────────
def package(key: str, out_dir: Path, manifest: dict, host_key: str) -> Path:
    goos, goarch, fmt, suffix = PLATFORMS[key]
    name = manifest["name"]
    exe_name = name + suffix

    with tempfile.TemporaryDirectory() as td:
        built = Path(td) / exe_name
        print(f"==> [{key}] go build (GOOS={goos} GOARCH={goarch} CGO_ENABLED=0)")
        go_build(built, goos, goarch)
        binary = built.read_bytes()

    manifest_bytes = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    files = [("manifest.json", manifest_bytes, 0o644), (f"bin/{exe_name}", binary, 0o755)]

    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / f"{name}-{key}.{fmt}"
    (write_zip if fmt == "zip" else write_targz)(archive, files)

    names = verify_archive(archive)
    print(f"    archive: {archive}  ({archive.stat().st_size:,} bytes)")
    print("    layout:  " + ", ".join(names))
    print("    verify:  OK (root manifest.json, entrypoint, permissions, executable header matches platform)")

    if key == host_key:
        smoke_test(archive, key)
        print("    smoke:   OK (extracted entrypoint answered `describe` over stdio)")
    else:
        print(f"    smoke:   skipped (cannot execute {key} binaries on {host_key})")
    return archive


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", action="append", choices=sorted(PLATFORMS), help="platform key (repeatable)")
    ap.add_argument("--all", action="store_true", help="build the three release platforms: " + ", ".join(RELEASE_PLATFORMS))
    ap.add_argument("--out", default=str(ROOT / "dist-executa"), help="output directory (default: dist-executa)")
    ap.add_argument("--verify", metavar="ARCHIVE", help="only verify an existing archive and exit")
    args = ap.parse_args()

    if args.verify:
        names = verify_archive(Path(args.verify))
        print(f"OK {args.verify}: " + ", ".join(names))
        return

    require_go()
    host_key = host_platform_key()
    targets = RELEASE_PLATFORMS if args.all else (args.target or [host_key])
    print(f"host platform: {host_key}")
    print(f"targets:       {', '.join(targets)}\n")

    # Identity (name/version/...) is taken from the binary's own `describe`.
    with tempfile.TemporaryDirectory() as td:
        host_bin = Path(td) / ("probe.exe" if os.name == "nt" else "probe")
        go_build(host_bin)  # native build of this host
        manifest = archive_manifest(jsonrpc_once(host_bin, "describe"))

    out_dir = Path(args.out)
    archives = [package(k, out_dir, manifest, host_key) for k in targets]

    sums = []
    for a in archives:
        h = hashlib.sha256(a.read_bytes()).hexdigest()
        sums.append(f"{h}  {a.name}")
    (out_dir / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")

    print("\nSHA-256:")
    print("\n".join("  " + s for s in sums))
    print(f"\nDone. {len(archives)} archive(s) in {out_dir}")


if __name__ == "__main__":
    main()
