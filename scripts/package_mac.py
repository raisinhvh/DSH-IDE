"""Build the macOS VSIXes (darwin-arm64, darwin-x64) from a Windows or macOS machine.

The VSIX bundles platform-specific native packages (esbuild, koffi, sharp, node-addon-system, ...), so each platform
needs its own build. For each architecture this copies the built extension into a temporary folder, cross-installs the
production dependencies for macOS with `npm ci --os=darwin --cpu=<arch>`, packages it with `vsce --target`, then
restores the executable bit on Mach-O binaries and scripts (a zip written on Windows has none, so node-pty's
spawn-helper and esbuild would fail to start on a Mac).

Run `npm run package:mac`, which type-checks and builds dist/ first. Pass architectures to build only some:
`python scripts/package_mac.py arm64`.
"""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
ARCHITECTURES = sys.argv[1:] or ["arm64", "x64"]
COPIED = ["package.json", "package-lock.json", "README.md", "LICENSE", ".vscodeignore", "media", "dist"]
MACH_O_MAGICS = {
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
}
EXECUTABLE = 0o100755 << 16
REGULAR = 0o100644 << 16
DIRECTORY = (0o040755 << 16) | 0x10
WINDOWS_ONLY_PACKAGES = [
    "extension/node_modules/@esbuild/win32-x64/",
    "extension/node_modules/@koromix/koffi-win32-x64/",
    "extension/node_modules/@img/sharp-win32-x64/",
    "extension/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/",
]


def command(name: str) -> str:
    return f"{name}.cmd" if os.name == "nt" else name


def run(arguments: list[str], cwd: Path) -> None:
    print("+", " ".join(arguments), flush=True)
    subprocess.run(arguments, cwd=cwd, check=True)


def stage_extension(stage: Path, arch: str) -> None:
    for name in COPIED:
        source = ROOT / name
        if not source.exists():
            raise FileNotFoundError(source)
        if source.is_dir():
            shutil.copytree(source, stage / name)
        else:
            shutil.copy2(source, stage / name)
    # Install scripts are skipped: they would run for this machine, not the Mac. The packages ship prebuilt binaries.
    run([command("npm"), "ci", "--os=darwin", f"--cpu={arch}", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage)


def needs_executable_bit(header: bytes) -> bool:
    return header[:4] in MACH_O_MAGICS or header[:2] == b"#!"


def restore_modes(source: Path, target: Path) -> int:
    """Rewrite the VSIX with Unix modes: 755 for Mach-O binaries and scripts, 644 for everything else."""
    executables = 0
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as new:
        for entry in old.infolist():
            data = old.read(entry)
            info = zipfile.ZipInfo(entry.filename, entry.date_time)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            if entry.is_dir():
                info.external_attr = DIRECTORY
            elif needs_executable_bit(data[:4]):
                info.external_attr = EXECUTABLE
                executables += 1
            else:
                info.external_attr = REGULAR
            new.writestr(info, data)
    return executables


def verify(package: Path, arch: str) -> None:
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        entries = {entry.filename: entry for entry in archive.infolist()}
        manifest = archive.read("extension.vsixmanifest")
        assert f'Version="{VERSION}"'.encode() in manifest, "manifest version"
        assert f'TargetPlatform="darwin-{arch}"'.encode() in manifest, "manifest target platform"
        assert json.loads(archive.read("extension/package.json"))["version"] == VERSION
        assert archive.read("extension/dist/extension.js") == (ROOT / "dist" / "extension.js").read_bytes()
        for required in [
            f"extension/node_modules/@esbuild/darwin-{arch}/bin/esbuild",
            f"extension/node_modules/node-pty/prebuilds/darwin-{arch}/spawn-helper",
        ]:
            assert required in entries, f"missing {required}"
            assert (entries[required].external_attr >> 16) & 0o111, f"{required} is not executable"
        for prefix in WINDOWS_ONLY_PACKAGES:
            assert not any(name.startswith(prefix) for name in entries), f"Windows package bundled: {prefix}"
        assert any(name.startswith(f"extension/node_modules/@deepseek-ai/node-addon-system-darwin-{arch}/") for name in entries)
        assert any(name.startswith("extension/node_modules/@deepseek-ai/dsh/") for name in entries)
    print(f"Verified {package.name}: {package.stat().st_size:,} bytes, {len(entries):,} entries", flush=True)


def build(arch: str) -> None:
    target = ROOT / f"dsh-ide-{VERSION}-darwin-{arch}.vsix"
    stage = Path(tempfile.mkdtemp(prefix=f"dsh-ide-darwin-{arch}-"))
    try:
        stage_extension(stage, arch)
        packaged = stage / "packaged.vsix"
        vsce = ROOT / "node_modules" / "@vscode" / "vsce" / "vsce"
        run(["node", str(vsce), "package", "--target", f"darwin-{arch}", "--allow-missing-repository", "-o", str(packaged)], stage)
        executables = restore_modes(packaged, target)
        print(f"Marked {executables} files executable", flush=True)
        verify(target, arch)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    if not (ROOT / "dist" / "extension.js").is_file():
        raise SystemExit("dist/extension.js is missing: run `npm run package:mac`, which builds first.")
    for architecture in ARCHITECTURES:
        if architecture not in ("arm64", "x64"):
            raise SystemExit(f"Unknown architecture {architecture}; use arm64 or x64.")
        build(architecture)
