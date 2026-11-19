from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
FILES = (
    "启动 Qs echo.cmd", "安装本机语音识别.cmd",
    "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md",
    "THIRD_PARTY_NOTICES.md", "WhatsApp导出与接入说明.md",
    "server.mjs", "tools/install-voice.ps1", "runtime/node.exe", "runtime/LICENSE.txt",
    "lib/echo.mjs", "lib/import.mjs", "lib/offline-voice.mjs", "lib/openai.mjs",
    "public/index.html", "public/app.js", "public/app.css", "skill/qs-echo/SKILL.md",
)


def main():
    missing = [name for name in FILES if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit("Missing release files: " + ", ".join(missing))

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    package = dist / "Qs-echo-Windows-x64.zip"
    with TemporaryDirectory(dir=dist) as stage:
        temporary = Path(stage) / package.name
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            for name in FILES:
                source = ROOT / name
                if source.suffix == ".cmd":
                    contents = source.read_text(encoding="utf-8").replace("\n", "\r\n")
                    archive.writestr("Qs-echo/" + name, contents.encode("utf-8"))
                else:
                    archive.write(source, "Qs-echo/" + name)
        with ZipFile(temporary) as archive:
            corrupt = archive.testzip()
            if corrupt:
                raise SystemExit(f"Corrupted ZIP entry: {corrupt}")
        temporary.replace(package)
    print(f"{package} ({package.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
