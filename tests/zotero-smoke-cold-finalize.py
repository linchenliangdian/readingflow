"""Read-only final verification after all isolated cold-restart processes exit."""
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile
import hashlib
import json
import shutil
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "tmp" / "zotero-test-v2"
OUTPUT = ROOT / "output"


def finalize():
    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    exit_evidence = json.loads((TEST_ROOT / "cold-process-exit-check.json").read_text(encoding="utf-8-sig"))
    if exit_evidence.get("remainingCount") != 0 or Path(exit_evidence.get("profile", "")) != TEST_ROOT / "profile" or Path(exit_evidence.get("data", "")) != TEST_ROOT / "data":
        raise RuntimeError("Verified exit of the exact isolated profile/data is required")
    modes = ("deleted-recovery", "relinked-reuse", "missing-tag")
    runs = []
    for mode in modes:
        path = OUTPUT / f"zotero-cold-{mode}-{version}.json"
        run = json.loads(path.read_text(encoding="utf-8"))
        if run.get("status") != "passed" or run.get("pluginVersion") != version or not all(check["passed"] for check in run["checks"]):
            raise RuntimeError("Cold run must pass: " + mode)
        runs.append({"mode": mode, "result": path.name, "checks": len(run["checks"]), "finishedAt": run["finishedAt"]})
    result = {"status": "running", "pluginVersion": version, "runs": runs, "functionalChecks": sum(run["checks"] for run in runs), "postExitChecks": []}

    def check(name, passed, evidence=None):
        result["postExitChecks"].append({"name": name, "passed": bool(passed), "evidence": evidence})
        if not passed:
            raise RuntimeError(name)

    check("all isolated cold test processes exited", exit_evidence["remainingCount"] == 0, exit_evidence)
    package = OUTPUT / f"reading-flow-{version}.xpi"
    with ZipFile(package) as archive:
        comparisons = {name: archive.read(name) == (ROOT / name).read_text(encoding="utf-8").encode("utf-8") for name in archive.namelist()}
    package_bytes = package.read_bytes()
    check("installed package and all runtime files equal final source", bool(comparisons) and all(comparisons.values()) and package_bytes == (TEST_ROOT / "profile" / "extensions" / "reading-flow@local.xpi").read_bytes(), comparisons)
    result["package"] = {"filename": package.name, "bytes": len(package_bytes), "sha256": hashlib.sha256(package_bytes).hexdigest(), "runtimeFileCount": len(comparisons), "sourceComparisons": comparisons}
    draft_root = TEST_ROOT / "data" / "reading-flow"
    trash = json.loads((draft_root / "cold-fixture-deleted.json").read_text(encoding="utf-8"))
    missing_tag = json.loads((draft_root / "cold-fixture-missing-tag.json").read_text(encoding="utf-8"))
    current_draft = json.loads((draft_root / f"{trash['parent']['libraryID']}-{trash['parent']['key']}.json").read_text(encoding="utf-8"))
    database = TEST_ROOT / "data" / "zotero.sqlite"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
        old_html = db.execute("SELECT note FROM itemNotes WHERE itemID=?", (trash["oldNote"]["id"],)).fetchone()[0]
        old_deleted = db.execute("SELECT itemID FROM deletedItems WHERE itemID=?", (trash["oldNote"]["id"],)).fetchone()
        check("original trash body survives all restarts unchanged", old_html == trash["oldNote"]["html"] and old_deleted is not None)
        active = db.execute("SELECT I.key,N.parentItemID FROM items I JOIN itemNotes N USING(itemID) LEFT JOIN deletedItems D USING(itemID) WHERE N.parentItemID=? AND D.itemID IS NULL", (trash["parent"]["id"],)).fetchall()
        check("recovered draft points to exactly one live child note", active == [(current_draft["noteKey"], trash["parent"]["id"])] and current_draft["noteKey"] != trash["oldNote"]["key"], active)
        check("paused timer and complete pyramid survive final exit", current_draft["timers"] == trash["draft"]["timers"] and current_draft["phase"] == trash["draft"]["phase"] and current_draft["pyramid"] == trash["draft"]["pyramid"])
        tag_note = db.execute("SELECT note FROM itemNotes WHERE itemID=?", (missing_tag["oldNote"]["id"],)).fetchone()[0]
        tag_present = db.execute("SELECT T.name FROM itemTags IT JOIN tags T USING(tagID) WHERE IT.itemID=? AND T.name=?", (missing_tag["oldNote"]["id"], "Reading Flow · sidebar")).fetchone()
        tag_deleted = db.execute("SELECT itemID FROM deletedItems WHERE itemID=?", (missing_tag["oldNote"]["id"],)).fetchone()
        tag_draft = json.loads((draft_root / f"{missing_tag['parent']['libraryID']}-{missing_tag['parent']['key']}.json").read_text(encoding="utf-8"))
        check("tag removal preserves the live bound note prose image and annotation", tag_note == missing_tag["oldNote"]["html"] and tag_present is None and tag_deleted is None and tag_draft["noteKey"] == missing_tag["oldNote"]["key"])
    trash_run = json.loads((OUTPUT / f"zotero-cold-deleted-recovery-{version}.json").read_text(encoding="utf-8"))
    backups = trash_run["relinkBackups"]
    check("pre-relink backup is byte-identical to the original JSON including extra fields", len(backups) == 1 and Path(backups[0]).read_bytes() == trash["draftRaw"].encode("utf-8") and "unknownBackupSentinel" in json.loads(Path(backups[0]).read_text(encoding="utf-8")))
    shutdown = {}
    for mode in modes:
        stdout = (OUTPUT / f"zotero-cold-{mode}-{version}-stdout.log").read_text(encoding="utf-8", errors="replace")
        begin = stdout.rfind("Reading Flow: early shutdown cleanup begins")
        complete = stdout.rfind("Reading Flow: early shutdown cleanup complete before database close")
        close = stdout.rfind("Closing database")
        shutdown[mode] = {"beginOffset": begin, "completeOffset": complete, "databaseCloseOffset": close, "passed": 0 <= begin < complete < close}
    check("owned cold cleanup always completes before database close", all(item["passed"] for item in shutdown.values()), shutdown)
    result["status"] = "passed"
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    preview = TEST_ROOT / f"native-sidebar-recovery-preview-{version}.png"
    if not preview.is_file() or preview.stat().st_size < 1000:
        raise RuntimeError("Actual recovery preview missing")
    shutil.copyfile(preview, OUTPUT / preview.name)
    result["recoveryPreview"] = preview.name
    path = OUTPUT / f"zotero-cold-results-{version}.json"
    path.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"status": result["status"], "nativeColdChecks": result["functionalChecks"], "postExitChecks": len(result["postExitChecks"]), "package": result["package"], "result": str(path)}, ensure_ascii=False))


if __name__ == "__main__":
    finalize()
