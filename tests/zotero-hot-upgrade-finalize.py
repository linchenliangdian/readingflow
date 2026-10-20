"""Verify same-process upgrade evidence after its isolated Zotero process has exited."""
from pathlib import Path
from zipfile import ZipFile
import argparse
import hashlib
import json
import sqlite3

ROOT = Path(__file__).resolve().parents[1]


def finalize(test_name):
    test_root = (ROOT / "tmp" / test_name).resolve()
    if not test_root.is_relative_to((ROOT / "tmp").resolve()) or test_root == (ROOT / "tmp").resolve():
        raise ValueError("Only a project-local disposable test directory is allowed")
    exit_evidence = json.loads((test_root / "process-exit-check.json").read_text(encoding="utf-8-sig"))
    result = json.loads((test_root / "result.json").read_text(encoding="utf-8"))
    if not exit_evidence.get("passed") or exit_evidence.get("IsolatedCount") != 0 or exit_evidence.get("verifiedDebuggerPID") != result.get("processID"):
        raise RuntimeError("The exact debugger-verified isolated process must have exited before reading SQLite")
    if Path(exit_evidence.get("expectedProfile", "")) != test_root / "profile" or Path(exit_evidence.get("expectedData", "")) != test_root / "data":
        raise RuntimeError("Process-exit evidence points at another profile/data directory")
    if result.get("status") != "passed" or not result.get("checks") or not all(check["passed"] for check in result["checks"]):
        raise RuntimeError("All live same-process upgrade checks must pass")
    fixture = result["fixture"]
    with sqlite3.connect((test_root / "data" / "zotero.sqlite").as_uri() + "?mode=ro", uri=True) as connection:
        owner_id = connection.execute("SELECT itemID FROM items WHERE libraryID=? AND key=?", (fixture["libraryID"], fixture["ownerKey"])).fetchone()
        note = connection.execute("SELECT n.note,n.parentItemID,i.key FROM itemNotes n JOIN items i USING(itemID) WHERE itemID=?", (fixture["noteID"],)).fetchone()
    draft = json.loads((test_root / "data" / "reading-flow" / f"{fixture['libraryID']}-{fixture['ownerKey']}.json").read_text(encoding="utf-8"))
    stages = json.loads((test_root / "package-stages.json").read_text(encoding="utf-8"))
    package = Path(stages[-1]["path"])
    with ZipFile(package) as archive:
        comparisons = {name: archive.read(name) == (ROOT / name).read_bytes() for name in archive.namelist()}
    checks = [
        {"name": "same debugger PID runs every version and context", "passed": all(stage["processID"] == result["processID"] for stage in result["stages"])},
        {"name": "original note identity and native prose survive process exit", "passed": bool(owner_id and note and note[1] == owner_id[0] and note[2] == fixture["noteKey"] and fixture["nativeText"] in note[0])},
        {"name": "root text and formatted background/conflict survive process exit", "passed": draft["pyramid"]["text"] == fixture["rootText"] and draft["noteKey"] == fixture["noteKey"] and draft["framing"] == fixture["framing"]},
        {"name": "final package matches its selected hash and every current runtime source", "passed": hashlib.sha256(package.read_bytes()).hexdigest() == stages[-1]["sha256"] and all(comparisons.values())},
    ]
    if not all(check["passed"] for check in checks):
        raise RuntimeError(json.dumps(checks))
    result["postExitChecks"] = checks
    result["isolatedProcessExit"] = exit_evidence
    result["package"] = {"filename": package.name, "bytes": package.stat().st_size, "sha256": stages[-1]["sha256"], "sourceComparisons": comparisons}
    output = ROOT / "output" / f"zotero-hot-upgrade-results-{result['pluginVersion']}.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "liveChecks": len(result["checks"]), "postExitChecks": checks, "oldCache": result.get("unversionedResourceCache"), "package": result["package"], "result": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-name", default="zotero-test-v218")
    finalize(parser.parse_args().test_name)
