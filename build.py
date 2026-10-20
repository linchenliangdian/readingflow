"""Build a deterministic, dependency-free Zotero XPI from reviewed source files."""
import argparse
import json
import os
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_STORED
import xml.etree.ElementTree as ET
from scripts.release import repository_name, update_url

ROOT = Path(__file__).resolve().parent
FILES = ["manifest.json", "bootstrap.js", "content/integration.js", "content/core.js", "content/sync.js", "content/file-sync.js", "content/app.xhtml", "content/app.js", "content/style.css", "content/icons/pyramid.svg", "LICENSE"]

def validate_resource_versions(source, version):
    document = ET.parse(source).getroot()
    namespace = {"h": "http://www.w3.org/1999/xhtml"}
    urls = [node.get("href") for node in document.findall("h:head/h:link[@rel='stylesheet']", namespace)]
    urls += [node.get("src") for node in document.findall("h:head/h:script[@src]", namespace)]
    expected = [f"{name}?v={version}" for name in ("style.css", "core.js", "app.js")]
    if urls != expected:
        raise ValueError("Sidebar stylesheet and script URLs must use the current manifest version to avoid cached resources")


def build(repository=None):
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if repository:
        manifest["applications"]["zotero"]["update_url"] = update_url(repository_name(repository))
    assert manifest["applications"]["zotero"]["strict_min_version"] == "9.0"
    assert manifest["applications"]["zotero"]["strict_max_version"] == "10.0.*"
    feed = manifest["applications"]["zotero"]["update_url"]
    assert feed.startswith("https://github.com/") and feed.endswith("/releases/latest/download/updates.json"), "A public GitHub update feed is required; use --repository OWNER/REPO"
    assert {"32", "48", "96"}.issubset(manifest["icons"])
    for filename in set(manifest["icons"].values()):
        assert filename in FILES, f"Manifest icon is missing from the package: {filename}"
        assert (ROOT / filename).is_file(), f"Manifest icon does not exist: {filename}"
        if filename.endswith(".svg"):
            assert ET.parse(ROOT / filename).getroot().tag == "{http://www.w3.org/2000/svg}svg"
    validate_resource_versions(ROOT / "content/app.xhtml", manifest["version"])
    out = ROOT / "output" / f"reading-flow-{manifest['version']}.xpi"
    out.parent.mkdir(exist_ok=True)
    # Store the small text files directly so zlib versions cannot change hashes.
    with ZipFile(out, "w", compression=ZIP_STORED) as archive:
        for filename in FILES:
            text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n" if filename == "manifest.json" else (ROOT / filename).read_text(encoding="utf-8")
            data = text.encode("utf-8")
            info = ZipInfo(filename, date_time=(2026, 10, 7, 0, 0, 0))
            info.create_system = 3
            info.compress_type = ZIP_STORED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    with ZipFile(out) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(FILES)
    print(f"Built: {out} ({out.stat().st_size:,} bytes)")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"), help="Public GitHub OWNER/REPO for the update feed")
    build(parser.parse_args().repository)
