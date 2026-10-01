"""Refresh the installed dependency payload when vsce cannot spawn in the sandbox."""

from pathlib import Path
import json
import re
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "dsh-ide-0.4.4.vsix"
TARGET = ROOT / "dsh-ide-0.4.5.vsix"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
assert VERSION == "0.4.5", VERSION

replacements = {
    "extension/package.json": ROOT / "package.json",
    "extension/readme.md": ROOT / "README.md",
    "extension/dist/extension.js": ROOT / "dist/extension.js",
    "extension/media/sidebar.js": ROOT / "media/sidebar.js",
    "extension/media/sidebar.css": ROOT / "media/sidebar.css",
    "extension/media/MaterialSymbolsRounded.woff2": ROOT / "media/MaterialSymbolsRounded.woff2",
    "extension/media/MATERIAL_SYMBOLS_LICENSE.txt": ROOT / "media/MATERIAL_SYMBOLS_LICENSE.txt",
}

with zipfile.ZipFile(SOURCE) as old, zipfile.ZipFile(TARGET, "w", allowZip64=True) as new:
    names = set(old.namelist())
    assert "extension.vsixmanifest" in names
    manifest = old.read("extension.vsixmanifest")
    manifest, count = re.subn(rb'Version="0\.4\.4"', b'Version="0.4.5"', manifest)
    assert count == 1
    content_types = old.read("[Content_Types].xml")
    if b'Extension=".woff2"' not in content_types:
        content_types = content_types.replace(
            b"</Types>",
            b'<Default Extension=".woff2" ContentType="font/woff2"/></Types>',
        )
    for entry in old.infolist():
        if entry.filename in replacements or entry.filename in ("extension.vsixmanifest", "[Content_Types].xml"):
            continue
        with old.open(entry) as contents, new.open(entry, "w", force_zip64=entry.file_size > 2**31) as output:
            while chunk := contents.read(1024 * 1024):
                output.write(chunk)
    for name, path in replacements.items():
        if not path.is_file():
            raise FileNotFoundError(path)
        new.write(path, name, compress_type=zipfile.ZIP_DEFLATED)
    new.writestr("extension.vsixmanifest", manifest, compress_type=zipfile.ZIP_DEFLATED)
    new.writestr("[Content_Types].xml", content_types, compress_type=zipfile.ZIP_DEFLATED)

with zipfile.ZipFile(TARGET) as package:
    assert package.testzip() is None
    assert json.loads(package.read("extension/package.json"))["version"] == VERSION
    assert b'Id="dsh-ide" Version="0.4.5"' in package.read("extension.vsixmanifest")
    assert b"font/woff2" in package.read("[Content_Types].xml")
    for name, path in replacements.items():
        assert package.read(name) == path.read_bytes(), name
    assert any(name.startswith("extension/node_modules/@deepseek-ai/dsh/") for name in package.namelist())
print(f"Verified {TARGET.name}: {TARGET.stat().st_size:,} bytes, {len(package.namelist()):,} entries")
