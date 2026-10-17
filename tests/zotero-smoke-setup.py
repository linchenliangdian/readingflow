"""Prepare an isolated Zotero smoke test. Never uses the user's profile or library."""
from pathlib import Path
import argparse
import json
import shutil
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
TEST_ID = "z-reading-flow-test@local"

def write_reader_fixture(path):
    """A local one-page PDF for exercising the reader, with no user document data."""
    stream = b"BT /F1 18 Tf 50 740 Td (Reading Flow isolated test document) Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(str(index).encode() + b" 0 obj\n" + obj + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    path.write_bytes(pdf)

def setup(scenario="v2", better_notes=None, port=9223, preview_hold=0, shutdown_baseline=False, capture_previews=False, cold_seed=None, cold_mode="valid"):
    manifest_source = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    cold_seed_path = Path(cold_seed).absolute() if cold_seed else ROOT / "output" / "zotero-smoke-results-2.0.1.json"
    if scenario == "cold" and (cold_mode == "valid" or cold_mode.startswith("prepare-")):
        manifest_source["version"] = json.loads(cold_seed_path.read_text(encoding="utf-8"))["pluginVersion"]
    package = ROOT / "output" / f"reading-flow-{manifest_source['version']}.xpi"
    if not package.is_file():
        raise FileNotFoundError(f"Build the current plugin first: {package}")
    TEST_ROOT = ROOT / "tmp" / ("zotero-test-sync" if scenario == "sync" else "zotero-test-v2" if scenario in ("v2", "cold") else "zotero-test")
    PROFILE = TEST_ROOT / "profile"
    DATA = TEST_ROOT / "data"
    RESULT = TEST_ROOT / ("cold-result.json" if scenario == "cold" else "result.json")
    # Retain previously verified evidence before a new build reuses this isolated profile.
    if RESULT.is_file():
        previous_result = json.loads(RESULT.read_text(encoding="utf-8"))
        previous_version = previous_result.get("pluginVersion", "")
        if previous_result.get("status") == "passed" and previous_version and all(char.isdigit() or char == "." for char in previous_version):
            for name in ("result.json", "stdout.log", "stderr.log", "native-sidebar-preview.png", "native-sidebar-text-preview.png", "process-exit-check.json"):
                previous_file = TEST_ROOT / name
                if previous_file.is_file():
                    shutil.copyfile(previous_file, TEST_ROOT / f"verified-{previous_version}-{name}")
    EXTENSIONS = PROFILE / "extensions"
    for folder in (EXTENSIONS, DATA):
        folder.mkdir(parents=True, exist_ok=True)
    better_notes_path = None
    if better_notes:
        source_xpi = Path(better_notes).absolute()
        with ZipFile(source_xpi) as archive:
            bn_manifest = json.loads(archive.read("manifest.json"))
        if bn_manifest.get("applications", {}).get("zotero", {}).get("id") != "Knowledge4Zotero@windingwind.com":
            raise ValueError("The optional coexistence XPI must be Better Notes")
        better_notes_path = TEST_ROOT / f"better-notes-{bn_manifest['version']}.xpi"
        # Read the installed package; never alter the original profile or extension.
        shutil.copyfile(source_xpi, better_notes_path)
    prefs = {
        "extensions.zotero.useDataDir": True,
        "extensions.zotero.dataDir": str(DATA),
        "extensions.autoDisableScopes": 0,
        "extensions.startupScanScopes": 1,
        "extensions.logging.enabled": True,
        "browser.dom.window.dump.enabled": True,
        "devtools.chrome.enabled": True,
        "devtools.debugger.remote-enabled": True,
        "devtools.debugger.prompt-connection": False,
        "devtools.debugger.force-local": True,
        "devtools.debugger.remote-port": port,
        "extensions.zotero.firstRun2": False,
        "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.showPostUpgradeBanner": False,
        "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.retractions.enabled": False,
        "extensions.zotero.streaming.enabled": False,
        "extensions.zotero.triggerProxyAuthentication": False,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "app.update.auto": False,
        "extensions.update.enabled": False,
        "browser.shell.checkDefaultBrowser": False,
        # Suppress only the optional plugin's tutorial in this disposable test profile.
        "extensions.zotero.Knowledge4Zotero.latestTourVersion": 1,
        # Reinstalling Better Notes otherwise leaves its old 30s timer to show
        # an unrelated "auto-sync stopped" progress window during our UI run.
        "extensions.zotero.Knowledge4Zotero.syncPeriodSeconds": 0,
    }
    (PROFILE / "user.js").write_text(
        "\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()) + "\n",
        encoding="utf-8",
    )
    runner_name = "zotero-sync-bootstrap.js" if scenario == "sync" else "zotero-smoke-cold-bootstrap.js" if scenario == "cold" else "zotero-smoke-v2-bootstrap.js" if scenario == "v2" else "zotero-smoke-bootstrap.js"
    source = (ROOT / "tests" / runner_name).read_text(encoding="utf-8")
    source = source.replace("__EXPECTED_PROFILE__", json.dumps(str(PROFILE)))
    source = source.replace("__EXPECTED_DATA__", json.dumps(str(DATA)))
    source = source.replace("__RESULT_PATH__", json.dumps(str(RESULT)))
    source = source.replace("__PACKAGE_PATH__", json.dumps(str(package)))
    source = source.replace("__COLD_SEED_PATH__", json.dumps(str(cold_seed_path)))
    source = source.replace("__COLD_MODE__", json.dumps(cold_mode))
    source = source.replace("__BETTER_NOTES_PATH__", json.dumps(str(better_notes_path) if better_notes_path else None))
    fixture_path = TEST_ROOT / "reader-fixture.pdf"
    write_reader_fixture(fixture_path)
    source = source.replace("__PDF_FIXTURE_PATH__", json.dumps(str(fixture_path)))
    source = source.replace("__PREVIEW_HOLD_MS__", str(preview_hold * 1000))
    source = source.replace("__SHUTDOWN_BASELINE__", json.dumps(shutdown_baseline))
    source = source.replace("__CAPTURE_PREVIEWS__", json.dumps(capture_previews or preview_hold > 0))
    manifest = {
        "manifest_version": 2, "name": "Reading Flow isolated smoke test", "version": "1.0.0",
        "applications": {"zotero": {"id": TEST_ID, "update_url": "https://reading-flow.invalid/updates.json", "strict_min_version": "9.0", "strict_max_version": "9.0.*"}},
    }
    with ZipFile(TEST_ROOT / "harness.xpi", "w", ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("bootstrap.js", source)
    (TEST_ROOT / "runner.js").write_text(
        'const { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");\n' + source + '\nZotero.__readingFlowSmokePromise = runSmokeTest();\n',
        encoding="utf-8",
    )
    (TEST_ROOT / "runner.xhtml").write_text(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Isolated Reading Flow test</title>'
        '<script src="runner.js" defer="defer"></script></head><body>Isolated plugin test</body></html>', encoding="utf-8",
    )
    RESULT.write_text(json.dumps({"status": "awaiting-startup", "scenario": scenario, "profile": str(PROFILE), "data": str(DATA), "package": str(package), "betterNotes": str(better_notes_path) if better_notes_path else None}), encoding="utf-8")
    (TEST_ROOT / "test-settings.json").write_text(json.dumps({"scenario": scenario, "port": port, "resultFilename": RESULT.name}), encoding="utf-8")
    print("Isolated profile:", PROFILE)
    print("Isolated data:", DATA)
    print("Result:", RESULT)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("v1", "v2", "cold", "sync"), default="v2")
    parser.add_argument("--cold-seed", help="Previously passed isolated smoke result whose persisted note should be reopened")
    parser.add_argument("--cold-mode", choices=("valid", "prepare-deleted", "reset-deleted", "deleted-recovery", "relinked-reuse", "prepare-missing-tag", "missing-tag-recovery"), default="valid")
    parser.add_argument("--better-notes", help="Optional existing Better Notes XPI to read and install only in the isolated profile")
    parser.add_argument("--port", type=int, default=9223)
    parser.add_argument("--preview-hold", type=int, choices=range(0, 61), default=0, metavar="0..60", help="Hold the verified sidebar briefly for an actual UI preview before exiting")
    parser.add_argument("--shutdown-baseline", action="store_true", help="Disable Reading Flow before quitting to distinguish existing Zotero/Better Notes cleanup errors")
    parser.add_argument("--capture-previews", action="store_true", help="Capture actual native sidebar images inside the isolated Zotero window")
    args = parser.parse_args()
    setup(args.scenario, args.better_notes, args.port, args.preview_hold, args.shutdown_baseline, args.capture_previews, args.cold_seed, args.cold_mode)
