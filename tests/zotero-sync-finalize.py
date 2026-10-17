"""Check durable sync records after the verified disposable Zotero process exits."""
from pathlib import Path
from zipfile import ZipFile
import base64
import hashlib
import html
import json
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "tmp" / "zotero-test-sync"


def finalize():
    evidence = json.loads((TEST_ROOT / "process-exit-check.json").read_text(encoding="utf-8-sig"))
    if not evidence.get("passed") or evidence.get("IsolatedCount") != 0:
        raise RuntimeError("Verified isolated process exit is required before reading SQLite")
    if Path(evidence["expectedProfile"]) != TEST_ROOT / "profile" or Path(evidence["expectedData"]) != TEST_ROOT / "data":
        raise RuntimeError("Unexpected isolated profile/data")
    result = json.loads((TEST_ROOT / "result.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if result.get("status") != "passed" or result.get("pluginVersion") != manifest["version"] or not all(check["passed"] for check in result["checks"]):
        raise RuntimeError("A complete current-version native sync pass is required")
    final_checks = []

    def check(name, condition):
        final_checks.append({"name": name, "passed": bool(condition)})
        if not condition:
            raise RuntimeError(name)

    package = ROOT / "output" / f"reading-flow-{manifest['version']}.xpi"
    check("installed native package is identical to the deliverable", package.read_bytes() == (TEST_ROOT / "profile" / "extensions" / "reading-flow@local.xpi").read_bytes())
    with ZipFile(package) as archive:
        check("all packaged runtime files match final source", archive.testzip() is None and all(archive.read(name) == (ROOT / name).read_bytes() for name in archive.namelist()))
    check("both child and standalone notes completed cache-free recovery", len(result.get("cacheRecoveryFixtures", [])) == 2)
    with sqlite3.connect((TEST_ROOT / "data" / "zotero.sqlite").as_uri() + "?mode=ro", uri=True) as database:
        for fixture, recovered in zip(result["fixtures"], result["cacheRecoveryFixtures"]):
            prose = database.execute("SELECT note FROM itemNotes WHERE itemID=?", (fixture["noteID"],)).fetchone()[0]
            check("durable prose and embedded image remain on exact note " + fixture["noteKey"], fixture["marker"] in prose and fixture["imageKey"] in prose)
            image_path = Path(fixture["imagePath"])
            check("native PNG survives exit " + fixture["imageKey"], image_path.is_relative_to(TEST_ROOT / "data") and image_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            check("original local JSON backup remains available " + recovered["ownerKey"], Path(recovered["backupPath"]).is_relative_to(TEST_ROOT / "data") and Path(recovered["backupPath"]).is_file())
            cache = json.loads((TEST_ROOT / "data" / "reading-flow" / f"{fixture['libraryID']}-{recovered['ownerKey']}.json").read_text(encoding="utf-8"))
            check("cache records a completed native-data save " + recovered["ownerKey"], cache.get("readingFlowSync", {}).get("pending") is False and cache["pyramid"]["text"].endswith("恢复后继续编辑"))
            states = []
            for key in recovered["headKeys"]:
                row = database.execute("SELECT note FROM itemNotes JOIN items USING(itemID) WHERE libraryID=? AND key=?", (fixture["libraryID"], key)).fetchone()
                if not row:
                    continue
                encoded = re.search(r"<pre\b[^>]*>([\s\S]*?)</pre>", row[0])
                envelope = json.loads(html.unescape(encoded.group(1)))
                if envelope.get("data"):
                    states.append(json.loads(base64.b64decode(envelope["data"])))
            check("editable hierarchy and formatting persist in Zotero notes " + recovered["ownerKey"], any(state["pyramid"] == cache["pyramid"] and state["framing"] == cache["framing"] and state["noteKey"] == fixture["noteKey"] for state in states))
    log = (TEST_ROOT / "stdout.log").read_text(encoding="utf-8", errors="replace")
    check("owned cleanup completes before database close", 0 <= log.rfind("Reading Flow: early shutdown cleanup begins") < log.rfind("Reading Flow: early shutdown cleanup complete before database close") < log.rfind("Closing database"))
    result["finalChecks"] = final_checks
    result["exitEvidence"] = evidence
    result["packageSHA256"] = hashlib.sha256(package.read_bytes()).hexdigest()
    destination = ROOT / "output" / f"zotero-sync-results-{manifest['version']}.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Native sync: {len(result['checks'])} checks; post-exit: {len(final_checks)} checks. Saved {destination}")


if __name__ == "__main__":
    finalize()
