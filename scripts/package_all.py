"""Validate and package every release asset: Windows x64 and both macOS architectures.

Run `npm run package:all` after updating package.json and package-lock.json.
Requires Node/npm and Python 3.10+. Only release inputs are staged, so local files
and development dependencies cannot leak into the Windows VSIX.
"""

from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import zipfile

from package_mac import COPIED, ROOT, VERSION, build, command, run


def build_windows() -> Path:
    target = ROOT / f"dsh-ide-{VERSION}.vsix"
    with tempfile.TemporaryDirectory(prefix="dsh-ide-win32-x64-") as folder:
        stage = Path(folder)
        for name in COPIED:
            source = ROOT / name
            if source.is_dir():
                shutil.copytree(source, stage / name)
            else:
                shutil.copy2(source, stage / name)
        run([
            command("npm"), "ci", "--os=win32", "--cpu=x64", "--omit=dev",
            "--ignore-scripts", "--no-audit", "--no-fund",
        ], stage)
        vsce = ROOT / "node_modules" / "@vscode" / "vsce" / "vsce"
        # Keep the historical Windows asset name/manifest for the built-in updater.
        run(["node", str(vsce), "package", "--allow-missing-repository", "-o", str(target)], stage)
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None, "corrupt Windows VSIX"
        assert json.loads(archive.read("extension/package.json"))["version"] == VERSION
        assert f'Version="{VERSION}"'.encode() in archive.read("extension.vsixmanifest")
        assert archive.read("extension/dist/extension.js") == (ROOT / "dist/extension.js").read_bytes()
        assert "extension/node_modules/@esbuild/win32-x64/esbuild.exe" in archive.namelist()
        assert any(name.startswith("extension/node_modules/@deepseek-ai/dsh/") for name in archive.namelist())
    print(f"Verified {target.name}: {target.stat().st_size:,} bytes", flush=True)
    return target


def main() -> None:
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    if lock["version"] != VERSION or lock["packages"][""]["version"] != VERSION:
        raise SystemExit("package.json and package-lock.json versions must match")
    for script in ("check", "test", "build"):
        run([command("npm"), "run", script], ROOT)
    assets = [build_windows()]
    for arch in ("arm64", "x64"):
        build(arch)
        assets.append(ROOT / f"dsh-ide-{VERSION}-darwin-{arch}.vsix")
    checksums = []
    for asset in assets:
        digest = hashlib.sha256()
        with asset.open("rb") as contents:
            while chunk := contents.read(1024 * 1024):
                digest.update(chunk)
        checksums.append(f"{digest.hexdigest()}  {asset.name}\n")
    checksum_file = ROOT / f"dsh-ide-{VERSION}-SHA256SUMS.txt"
    checksum_file.write_text("".join(checksums), encoding="utf-8")
    print(f"Release assets ready; checksums: {checksum_file.name}", flush=True)


if __name__ == "__main__":
    main()
