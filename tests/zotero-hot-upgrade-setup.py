"""Prepare a project-local disposable Zotero profile for same-process plugin upgrades."""
from pathlib import Path
from zipfile import ZipFile
import argparse
import hashlib
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]


def setup(old_xpi, intermediate_xpi, new_xpi, test_name="zotero-test-v218", port=9223):
    if not test_name.startswith("zotero-test-") or not all(char.isascii() and (char.isalnum() or char == "-") for char in test_name):
        raise ValueError("Test name must be a plain zotero-test-* directory name")
    test_root = ROOT / "tmp" / test_name
    profile, data = test_root / "profile", test_root / "data"
    if (profile / "prefs.js").exists() or (data / "zotero.sqlite").exists():
        raise ValueError("Use a fresh isolated test directory; existing evidence is never overwritten")
    stages = []
    for source in (old_xpi, intermediate_xpi, new_xpi):
        if source is None:
            continue
        package = Path(source).resolve()
        with ZipFile(package) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("applications", {}).get("zotero", {}).get("id") != "reading-flow@local":
            raise ValueError("Only Reading flow test packages are allowed")
        stages.append({"path": str(package), "version": manifest["version"], "sha256": hashlib.sha256(package.read_bytes()).hexdigest()})
    if len(stages) < 2 or len({stage["version"] for stage in stages}) != len(stages):
        raise ValueError("Provide at least two different Reading flow versions")
    for folder in (profile / "extensions", data):
        folder.mkdir(parents=True, exist_ok=True)
    prefs = {
        "extensions.zotero.useDataDir": True, "extensions.zotero.dataDir": str(data),
        "extensions.autoDisableScopes": 0, "extensions.startupScanScopes": 1,
        "browser.dom.window.dump.enabled": True, "extensions.logging.enabled": True,
        "devtools.chrome.enabled": True, "devtools.debugger.remote-enabled": True,
        "devtools.debugger.prompt-connection": False, "devtools.debugger.force-local": True, "devtools.debugger.remote-port": port,
        "extensions.zotero.firstRun2": False, "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.showPostUpgradeBanner": False, "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.httpServer.enabled": False, "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.retractions.enabled": False, "extensions.zotero.streaming.enabled": False,
        "extensions.zotero.triggerProxyAuthentication": False,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True, "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "app.update.auto": False, "extensions.update.enabled": False, "browser.shell.checkDefaultBrowser": False,
    }
    (profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()) + "\n", encoding="utf-8")
    fixture = test_root / "reader-fixture.pdf"
    runpy.run_path(str(ROOT / "tests" / "zotero-smoke-setup.py"))["write_reader_fixture"](fixture)
    result = test_root / "result.json"
    source = (ROOT / "tests" / "zotero-hot-upgrade-bootstrap.js").read_text(encoding="utf-8")
    for token, value in {"__EXPECTED_PROFILE__": str(profile), "__EXPECTED_DATA__": str(data), "__RESULT_PATH__": str(result), "__PACKAGE_STAGES__": stages, "__PDF_FIXTURE_PATH__": str(fixture)}.items():
        source = source.replace(token, json.dumps(value))
    (test_root / "runner.js").write_text('const { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");\n' + source + '\nZotero.__readingFlowSmokePromise = runSmokeTest();\n', encoding="utf-8")
    result.write_text(json.dumps({"status": "awaiting-startup", "scenario": "hot-upgrade", "profile": str(profile), "data": str(data), "packages": stages}), encoding="utf-8")
    (test_root / "test-settings.json").write_text(json.dumps({"scenario": "v2", "port": port, "resultFilename": result.name}), encoding="utf-8")
    (test_root / "package-stages.json").write_text(json.dumps(stages, indent=2), encoding="utf-8")
    print(json.dumps({"profile": str(profile), "data": str(data), "packages": stages}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-xpi", required=True)
    parser.add_argument("--intermediate-xpi")
    parser.add_argument("--new-xpi", required=True)
    parser.add_argument("--test-name", default="zotero-test-v218")
    parser.add_argument("--port", type=int, default=9223)
    args = parser.parse_args()
    setup(args.old_xpi, args.intermediate_xpi, args.new_xpi, args.test_name, args.port)
