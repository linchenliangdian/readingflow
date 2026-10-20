"""Verify final isolated test evidence and copy deliverable artifacts to output."""
from pathlib import Path
from zipfile import ZipFile
import hashlib
import json
import re
import shutil
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "tmp" / "zotero-test-v2"
OUTPUT = ROOT / "output"


def utf16_slice(value, start, end):
    return value.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


def finalize():
    exit_evidence = json.loads((TEST_ROOT / "process-exit-check.json").read_text(encoding="utf-8-sig"))
    if not exit_evidence.get("passed") or exit_evidence.get("IsolatedCount") != 0:
        raise RuntimeError("The isolated process must have exited before reading SQLite")
    if Path(exit_evidence.get("expectedProfile", "")) != TEST_ROOT / "profile" or Path(exit_evidence.get("expectedData", "")) != TEST_ROOT / "data":
        raise RuntimeError("Process-exit evidence describes another profile or database")
    result = json.loads((TEST_ROOT / "result.json").read_text(encoding="utf-8"))
    if result.get("status") != "passed" or not result.get("checks") or not all(check["passed"] for check in result["checks"]):
        raise RuntimeError("The final functional run must pass before publication")
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if result.get("pluginVersion") != manifest["version"]:
        raise RuntimeError("The test result is for another plugin version")
    package = OUTPUT / f"reading-flow-{manifest['version']}.xpi"
    with ZipFile(package) as archive:
        comparisons = {name: archive.read(name) == (ROOT / name).read_text(encoding="utf-8").encode("utf-8") for name in archive.namelist()}
    if not all(comparisons.values()):
        raise RuntimeError("Source changed after the final XPI was built")
    stdout = (TEST_ROOT / "stdout.log").read_text(encoding="utf-8", errors="replace")
    starts = [index for index in range(len(stdout)) if stdout.startswith("Reading Flow: early shutdown cleanup begins", index)]
    complete = stdout.rfind("Reading Flow: early shutdown cleanup complete before database close")
    close_database = stdout.rfind("Closing database")
    cleanup_check = {
        "name": "owned cleanup completes before database close",
        "passed": bool(starts and starts[-1] < complete < close_database),
        "evidence": {"beginOffset": starts[-1] if starts else None, "completeOffset": complete, "databaseCloseOffset": close_database},
    }
    database_path = TEST_ROOT / "data" / "zotero.sqlite"
    with sqlite3.connect(database_path.as_uri() + "?mode=ro", uri=True) as connection:
        notes = connection.execute("SELECT note FROM itemNotes WHERE parentItemID=?", (result["items"][0]["id"],)).fetchall()
    note_html = "\n".join(row[0] for row in notes)
    persisted_check = {
        "name": "native prose image and PDF annotation survive application exit",
        "passed": all(text in note_html for text in ("实机原生编辑：此段必须在切换及插图后保留。", "实机 PDF 批注加入当前阅读笔记", "data-attachment-key=")),
        "evidence": "Read-only SQLite query after the verified isolated process exited",
    }
    parent = result["items"][0]
    draft = json.loads((TEST_ROOT / "data" / "reading-flow" / f"{parent['libraryID']}-{parent['key']}.json").read_text(encoding="utf-8"))
    root_check = {
        "name": "single root question answer and edits survive application exit",
        "passed": draft["framing"]["question"] == "" and all(draft["pyramid"]["text"].count(value) == 1 for value in ("旧版 SCQ", "总论点：旧版证据支持结论", "单框实机编辑内容")),
        "evidence": "Read-only persisted draft after verified isolated process exit",
    }
    formatting_check = {
        "name": "pyramid bold and top annotations survive application exit",
        "passed": any(draft["pyramid"]["text"][span["start"]:span["end"]] == "单框实机编辑内容" for span in draft["pyramid"].get("boldRanges", []))
        and "实机背景批注" in draft["framing"]["situation"] and "实机冲突批注" in draft["framing"]["complication"],
        "evidence": "Read-only persisted draft after verified isolated process exit",
    }
    framing_bold_fixture = result.get("framingBold")
    if not framing_bold_fixture or framing_bold_fixture.get("ownerKey") != parent["key"] or framing_bold_fixture.get("libraryID") != parent["libraryID"]:
        raise RuntimeError("The native background/complication partial-bold regression must target the first original note")
    framing_bold_check = {
        "name": "background and complication partial bold survive application exit",
        "passed": all(any(utf16_slice(draft["framing"][field], span["start"], span["end"]) == framing_bold_fixture[field] for span in draft["framing"].get(field + "BoldRanges", [])) for field in ("situation", "complication")),
        "evidence": "Read-only persisted annotation plain strings and UTF-16 range metadata after verified isolated process exit",
    }
    standalone_fixtures = result.get("standaloneNotes", [])
    if len(standalone_fixtures) != 2:
        raise RuntimeError("The standalone-note regression must verify two original notes")
    standalone_note_passed = True
    standalone_draft_passed = True
    standalone_image_passed = True
    with sqlite3.connect(database_path.as_uri() + "?mode=ro", uri=True) as connection:
        for index, fixture in enumerate(standalone_fixtures):
            row = connection.execute("SELECT parentItemID,note FROM itemNotes WHERE itemID=?", (fixture["id"],)).fetchone()
            markers = [fixture["original"], fixture["editorText"]] + ([fixture["builtinText"]] if fixture.get("builtinText") else [])
            standalone_note_passed = standalone_note_passed and bool(row and row[0] is None and all(marker in row[1] for marker in markers))
            independent_draft = json.loads((TEST_ROOT / "data" / "reading-flow" / f"{fixture['libraryID']}-{fixture['key']}.json").read_text(encoding="utf-8"))
            standalone_draft_passed = standalone_draft_passed and independent_draft["item"]["key"] == fixture["key"] and independent_draft["noteKey"] == fixture["key"]
            if index == 0:
                standalone_note_passed = standalone_note_passed and bool(row and fixture["imageKey"] in row[1] and "data-attachment-key=" in row[1])
                standalone_draft_passed = standalone_draft_passed and independent_draft["pyramid"]["text"] == fixture["rootText"] and any(independent_draft["pyramid"]["text"][span["start"]:span["end"]] == fixture["boldText"] for span in independent_draft["pyramid"].get("boldRanges", []))
                standalone_draft_passed = standalone_draft_passed and independent_draft["timers"]["analysis"]["deadline"] == fixture["analysisDeadline"] and independent_draft["timers"]["inspection"]["status"] == "paused" and "独立背景 A" in independent_draft["framing"]["situation"] and "独立冲突 A" in independent_draft["framing"]["complication"] and independent_draft["pyramid"]["children"][0]["text"] == "独立论点 A：支持核心观点。"
                image_row = connection.execute("SELECT a.parentItemID,a.contentType FROM itemAttachments a JOIN items i USING(itemID) WHERE i.libraryID=? AND i.key=?", (fixture["libraryID"], fixture["imageKey"])).fetchone()
                standalone_image_passed = standalone_image_passed and bool(image_row and image_row == (fixture["id"], "image/png"))
            else:
                standalone_note_passed = standalone_note_passed and bool(row and "data-attachment-key=" not in row[1])
                standalone_draft_passed = standalone_draft_passed and independent_draft["pyramid"]["text"] == "" and independent_draft["timers"]["analysis"]["status"] == "idle" and independent_draft["framing"]["situation"] == ""
    standalone_prose_check = {"name": "original standalone note identities and independent prose survive exit", "passed": standalone_note_passed, "evidence": "Read-only SQLite query for the two original note IDs after verified process exit"}
    standalone_draft_check = {"name": "standalone timers bold pyramid and annotations survive exit independently", "passed": standalone_draft_passed, "evidence": "Two persisted note-key draft JSON files read after verified process exit"}
    standalone_image_check = {"name": "standalone pyramid PNG remains attached to exact original note", "passed": standalone_image_passed, "evidence": "Read-only SQLite attachment parent and content type check after verified process exit"}
    reader_standalone = result.get("readerStandaloneNote")
    if not reader_standalone:
        raise RuntimeError("The native PDF-context independent-note creation scenario must pass")
    with sqlite3.connect(database_path.as_uri() + "?mode=ro", uri=True) as connection:
        reader_note_row = connection.execute("SELECT parentItemID,note FROM itemNotes WHERE itemID=?", (reader_standalone["id"],)).fetchone()
        reader_image_row = connection.execute("SELECT a.parentItemID,a.contentType FROM itemAttachments a JOIN items i USING(itemID) WHERE i.libraryID=? AND i.key=?", (reader_standalone["libraryID"], reader_standalone["imageKey"])).fetchone()
    reader_note_passed = bool(reader_note_row and reader_note_row[0] is None and all(marker in reader_note_row[1] for marker in (reader_standalone["editorText"], reader_standalone["imageKey"], "data-attachment-key=")) and reader_image_row == (reader_standalone["id"], "image/png"))
    reader_draft = json.loads((TEST_ROOT / "data" / "reading-flow" / f"{reader_standalone['libraryID']}-{reader_standalone['key']}.json").read_text(encoding="utf-8"))
    reader_draft_passed = reader_draft["item"]["key"] == reader_standalone["key"] and reader_draft["noteKey"] == reader_standalone["key"] and reader_draft["pyramid"]["text"] == reader_standalone["rootText"] and reader_draft["timers"]["inspection"]["deadline"] == reader_standalone["inspectionDeadline"] and "PDF 旁的独立背景记录。" in reader_draft["framing"]["situation"]
    reader_note_check = {"name": "new PDF-context original independent note prose and PNG survive exit", "passed": reader_note_passed, "evidence": "Read-only SQLite original note ID and image parent check after verified process exit"}
    reader_draft_check = {"name": "new PDF-context independent tools survive exit on their original note key", "passed": reader_draft_passed, "evidence": "Persisted original note-key draft JSON after verified process exit"}
    height_preference = result.get("heightPreference", {})
    expected_height = height_preference.get("value")
    preferences = (TEST_ROOT / "profile" / "prefs.js").read_text(encoding="utf-8")
    preference_pattern = r'user_pref\("' + re.escape(height_preference.get("key", "")) + r'",\s*' + str(expected_height) + r'\);'
    height_check = {"name": "chosen pyramid viewport height survives application exit", "passed": isinstance(expected_height, int) and 64 <= expected_height <= 1600 and height_preference.get("key") == "extensions.zotero.readingFlow.pyramidHeight" and bool(re.search(preference_pattern, preferences)), "evidence": "Read-only isolated profile prefs.js after verified process exit"}
    result["cleanupChecks"] = [cleanup_check, persisted_check, root_check, formatting_check, framing_bold_check, standalone_prose_check, standalone_draft_check, standalone_image_check, reader_note_check, reader_draft_check, height_check]
    font_fixture = result.get("pyramidFontSize")
    if font_fixture:
        font_draft = json.loads((TEST_ROOT / "data" / "reading-flow" / f"{font_fixture['libraryID']}-{font_fixture['ownerKey']}.json").read_text(encoding="utf-8"))
        result["cleanupChecks"].append({"name": "chosen pyramid font size survives process exit", "passed": font_draft.get("pyramidFontSize") == font_fixture["value"], "evidence": "Read-only persisted font-size preference inside this note draft"})
    result["isolatedProcessExit"] = exit_evidence
    result["package"] = {"filename": package.name, "bytes": package.stat().st_size, "sha256": hashlib.sha256(package.read_bytes()).hexdigest(), "runtimeFileCount": len(comparisons), "sourceComparisons": comparisons}
    result["shutdownBaseline"] = {
        "result": "shutdown-baseline-result.json",
        "finding": "The run with Reading Flow disabled is recorded separately. Compare its logs with this run before attributing host or other-plugin shutdown errors.",
    }
    if not all(check["passed"] for check in result["cleanupChecks"]):
        raise RuntimeError(json.dumps(result["cleanupChecks"], ensure_ascii=False))
    for source_name in ("native-sidebar-preview.png", "native-sidebar-text-preview.png", "native-sidebar-expanded-preview.png", "native-framing-preview.png", "native-standalone-preview.png", "native-reader-standalone-preview.png", "native-pyramid-height-preview.png"):
        source = TEST_ROOT / source_name
        if not source.is_file() or source.stat().st_size < 1000:
            raise RuntimeError("Expected real native preview was not captured: " + source_name)
        shutil.copyfile(source, OUTPUT / source_name)
        shutil.copyfile(source, OUTPUT / f"{source.stem}-{manifest['version']}{source.suffix}")
    for name in ("shutdown-baseline-result.json",):
        shutil.copyfile(TEST_ROOT / name, OUTPUT / name)
    output_result = OUTPUT / "zotero-smoke-results.json"
    output_result.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUTPUT / f"zotero-smoke-results-{manifest['version']}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUTPUT / "reading-flow-package.sha256").write_text(result["package"]["sha256"] + "  " + package.name + "\n", encoding="utf-8")
    (OUTPUT / f"reading-flow-package-{manifest['version']}.sha256").write_text(result["package"]["sha256"] + "  " + package.name + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "functionalChecks": len(result["checks"]), "cleanupChecks": result["cleanupChecks"], "package": result["package"], "result": str(output_result)}, ensure_ascii=False))


if __name__ == "__main__":
    finalize()
