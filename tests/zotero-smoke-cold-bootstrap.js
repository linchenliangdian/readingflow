/* Read persisted test data in a genuinely restarted isolated Zotero process. */
const expectedProfile = __EXPECTED_PROFILE__;
const expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__;
const packagePath = __PACKAGE_PATH__;
const coldSeedPath = __COLD_SEED_PATH__;
const coldMode = __COLD_MODE__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSmokeTest() {
  const result = { status: "running", scenario: "cold-restart-note-recovery", mode: coldMode, version: Zotero.version, checks: [], startedAt: new Date().toISOString() };
  let safeToQuit = false, handle = null;
  function check(name, condition, detail) { result.checks.push({ name, passed: !!condition, detail: detail ?? null }); if (!condition) throw new Error("Failed: " + name); }
  async function waitFor(test, label, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(100); } throw new Error("Timeout: " + label); }
  async function clickRail(candidate, parent) {
    const dialogs = result.promptAlerts ||= [];
    const observer = { observe(window, topic) {
      if (topic !== "domwindowopened") return;
      const inspect = () => {
        const url = window.document?.documentURI || "";
        if (/commonDialog\.(?:xhtml|xul)/.test(url)) dialogs.push({ url, title: window.document.title });
      };
      window.addEventListener("DOMContentLoaded", inspect, { once: true });
    } };
    Services.ww.registerNotification(observer);
    try {
      candidate.button.click();
      await waitFor(() => candidate.item?.key === parent.key && candidate.note && candidate.deck.selectedPanel === candidate.panel, "actual cold rail click opens note");
      await waitFor(() => candidate.toolsWindow?.ReadingFlowApp?.getState()?.item.key === parent.key, "actual rail tools ready");
      await delay(100);
    }
    finally { Services.ww.unregisterNotification(observer); }
    check("actual rail recovery shows no blocking alert", dialogs.length === 0, dialogs);
  }
  async function captureNativeWindow(host, filename) {
    const path = PathUtils.join(PathUtils.parent(resultPath), filename);
    const screenshot = await host.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "rgb(255,255,255)", false);
    const canvas = host.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = screenshot.width; canvas.height = screenshot.height;
    canvas.getContext("2d").drawImage(screenshot, 0, 0); screenshot.close();
    const bytes = Uint8Array.from(host.atob(canvas.toDataURL("image/png").split(",")[1]), character => character.charCodeAt(0));
    await IOUtils.write(path, bytes, { tmpPath: path + ".tmp" }); return path;
  }
  try {
    await Promise.race([Zotero.initializationPromise, delay(30000).then(() => { throw new Error("Initialization timeout"); })]);
    check("isolated profile", PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile), Zotero.Profile.dir);
    check("isolated data directory", PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData), Zotero.DataDirectory.dir);
    safeToQuit = true;
    const seed = JSON.parse(await IOUtils.readUTF8(coldSeedPath));
    const parentSeed = seed.items[0];
    const draftPath = PathUtils.join(expectedData, "reading-flow", parentSeed.libraryID + "-" + parentSeed.key + ".json");
    const draftBefore = JSON.parse(await IOUtils.readUTF8(draftPath));
    const host = await waitFor(() => Zotero.getMainWindow(), "main window");
    const api = await waitFor(() => Zotero.ReadingFlow?.openItem && Zotero.ReadingFlow, "existing plugin startup");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("reading-flow@local"); result.pluginVersion = addon.version;
    const [expectedBytes, installedBytes] = await Promise.all([IOUtils.read(packagePath), IOUtils.read(PathUtils.join(expectedProfile, "extensions", "reading-flow@local.xpi"))]);
    check("cold-start installed package matches seed build", expectedBytes.length === installedBytes.length && expectedBytes.every((byte, index) => installedBytes[index] === byte));
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(parentSeed.libraryID, parentSeed.key);
    const note = await Zotero.Items.getByLibraryAndKeyAsync(parentSeed.libraryID, draftBefore.noteKey);
    result.beforeOpen = { parentID: parent?.id, parentKey: parent?.key, noteID: note?.id, noteKey: note?.key, isNote: note?.isNote(), deleted: note?.deleted, noteParentID: note?.parentID, tagsLoaded: note?._loaded.tags, tags: null, hasSidebarTag: null };
    try { result.beforeOpen.tags = note.getTags(); result.beforeOpen.hasSidebarTag = note.hasTag("Reading Flow · sidebar"); }
    catch (error) { result.beforeOpen.tagAccessError = error.message || String(error); }
    result.databaseTags = await Zotero.DB.columnQueryAsync("SELECT T.name FROM itemTags IT JOIN tags T USING(tagID) WHERE IT.itemID=?", [note.id]);
    const noteHTML = await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [note.id]);
    const noteIDsBefore = await Zotero.DB.columnQueryAsync("SELECT itemID FROM itemNotes WHERE parentItemID=?", [parent.id]);
    const kind = coldMode.includes("missing-tag") ? "missing-tag" : "deleted";
    const fixturePath = PathUtils.join(expectedData, "reading-flow", "cold-fixture-" + kind + ".json");
    if (coldMode === "reset-deleted") {
      const fixture = JSON.parse(await IOUtils.readUTF8(fixturePath));
      check("reset fixture stays within same isolated paper", fixture.parent.key === parent.key && fixture.parent.libraryID === parent.libraryID);
      // Repeating a failed harness run must not silently reuse its replacement.
      for (const childID of noteIDsBefore) {
        const child = await Zotero.Items.getAsync(childID);
        if (child && !child.deleted && child.isNote() && child.parentID === parent.id) { child.deleted = true; await child.saveTx(); }
      }
      await IOUtils.writeUTF8(draftPath, fixture.draftRaw, { tmpPath: draftPath + ".tmp" });
      check("reset retains original trashed note body", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [fixture.oldNote.id])) === fixture.oldNote.html);
      result.status = "passed"; return;
    }
    if (coldMode.startsWith("prepare-")) {
      check("prepare only valid isolated note", note.isNote() && !note.deleted && note.parentID === parent.id);
      const retained = JSON.parse(JSON.stringify(draftBefore));
      retained.phase = "analysis";
      retained.timers.analysis = { durationMs: 1200000, remainingMs: 732000, status: "paused", deadline: null };
      retained.unknownBackupSentinel = "原始 JSON 额外字段也应留在恢复备份";
      const retainedRaw = JSON.stringify(retained, null, 2);
      await IOUtils.writeUTF8(draftPath, retainedRaw, { tmpPath: draftPath + ".tmp" });
      const fixture = { kind, parent: parentSeed, oldNote: { id: note.id, key: note.key, html: noteHTML }, draft: retained, draftRaw: retainedRaw };
      if (kind === "deleted") { note.deleted = true; note.setTags([]); }
      else note.removeTag("Reading Flow · sidebar");
      await note.saveTx();
      await IOUtils.writeUTF8(fixturePath, JSON.stringify(fixture, null, 2), { tmpPath: fixturePath + ".tmp" });
      check("fixture retains original note body", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [note.id])) === noteHTML);
      check("fixture state simulates reported association", kind === "deleted" ? note.deleted && note.getTags().length === 0 : !note.deleted && !note.hasTag("Reading Flow · sidebar"));
      result.fixturePath = fixturePath; result.status = "passed"; return;
    }
    check("cold seed note remains child of expected item", note.isNote() && note.parentID === parent.id && (coldMode === "deleted-recovery" ? note.deleted : !note.deleted), result.beforeOpen);
    let fixture = null, beforeBackups = [];
    if (coldMode.endsWith("recovery") || coldMode === "relinked-reuse") {
      fixture = JSON.parse(await IOUtils.readUTF8(fixturePath));
      beforeBackups = await IOUtils.getChildren(PathUtils.parent(draftPath));
    }
    // Do not pre-load tags: the production path must work from this genuine cold state.
    if (coldMode.endsWith("recovery") || coldMode === "relinked-reuse") {
      host.Zotero_Tabs.select("zotero-pane");
      await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane?.collectionsView, "library view");
      await host.ZoteroPane.selectItems([parent.id], { noWindowRestore: true });
      handle = api.inspect(host).find(candidate => candidate.kind === "library");
      await waitFor(() => handle.button, "registered native rail button");
      await clickRail(handle, parent);
    }
    else handle = await Promise.race([api.openItem(parent.id, host), delay(30000).then(() => { throw new Error("Cold sidebar open timeout"); })]);
    await waitFor(() => handle.editor.getCurrentInstance(), "native editor"); await handle.editor.getCurrentInstance()._initPromise;
    await waitFor(() => handle.toolsWindow?.ReadingFlowApp?.getState()?.item.key === parent.key, "current paper tools loaded");
    check(coldMode === "deleted-recovery" ? "cold restart replaces only trashed binding" : "cold restart reopens the same note", coldMode === "deleted-recovery" ? handle.note.id !== note.id && handle.note.parentID === parent.id && !handle.note.deleted : handle.note.id === note.id && handle.getState().noteKey === draftBefore.noteKey);
    check("cold restart preserves written native content", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [note.id])) === noteHTML);
    const noteIDsAfter = await Zotero.DB.columnQueryAsync("SELECT itemID FROM itemNotes WHERE parentItemID=?", [parent.id]);
    check("cold restart creates no duplicate child note", coldMode === "deleted-recovery" ? noteIDsAfter.length === noteIDsBefore.length + 1 : JSON.stringify(noteIDsBefore) === JSON.stringify(noteIDsAfter));
    check("cold restart preserves pyramid tree", JSON.stringify(handle.getState().pyramid) === JSON.stringify(draftBefore.pyramid));
    const archivedHTML = fixture ? fixture.oldNote.html : noteHTML;
    check("cold restart keeps PDF image and annotation", archivedHTML.includes("data-attachment-key=") && archivedHTML.includes("实机 PDF 批注加入当前阅读笔记"));
    if (fixture) {
      check("cold recovery preserves paused timer", JSON.stringify(handle.getState().timers) === JSON.stringify(fixture.draft.timers) && handle.getState().phase === fixture.draft.phase);
      check("old fixture note body remains byte-identical", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [fixture.oldNote.id])) === fixture.oldNote.html);
      if (coldMode === "deleted-recovery") {
        check("trashed old note stays trashed", !!(await Zotero.DB.valueQueryAsync("SELECT itemID FROM deletedItems WHERE itemID=?", [fixture.oldNote.id])));
        const paths = await IOUtils.getChildren(PathUtils.parent(draftPath));
        const backups = [];
        for (const path of paths.filter(path => !beforeBackups.includes(path) && path !== draftPath && path.endsWith(".json"))) {
          try { const raw = await IOUtils.readUTF8(path), backup = JSON.parse(raw); if (backup.item?.key === parent.key && backup.noteKey === fixture.oldNote.key && JSON.stringify(backup.pyramid) === JSON.stringify(fixture.draft.pyramid) && JSON.stringify(backup.timers) === JSON.stringify(fixture.draft.timers) && raw === (fixture.draftRaw || JSON.stringify(fixture.draft, null, 2))) backups.push(path); } catch (_) {}
        }
        check("pre-relink backup retains old binding and full tree", backups.length === 1, backups); result.relinkBackups = backups;
        const relinked = JSON.parse(await IOUtils.readUTF8(draftPath));
        check("current draft stores replacement note key", relinked.noteKey === handle.note.key && relinked.noteKey !== fixture.oldNote.key);
        result.recoveryPreviewPath = await captureNativeWindow(host, "native-sidebar-recovery-preview-2.0.2.png");
        const replacementID = handle.note.id; handle.hide(); handle.button.click();
        await waitFor(() => handle.note?.id === replacementID && handle.deck.selectedPanel === handle.panel, "repeat rail click reuses replacement");
        check("repeat rail click reuses one replacement note", (await Zotero.DB.columnQueryAsync("SELECT itemID FROM itemNotes WHERE parentItemID=?", [parent.id])).length === noteIDsAfter.length);
        // Exercise the live PDF writer after its current note is trashed elsewhere.
        const pdfID = await Zotero.DB.valueQueryAsync("SELECT IA.itemID FROM itemAttachments IA LEFT JOIN deletedItems DI USING(itemID) WHERE IA.parentItemID=? AND IA.contentType='application/pdf' AND DI.itemID IS NULL ORDER BY IA.itemID DESC LIMIT 1", [parent.id]);
        const openedReader = await Zotero.Reader.open(pdfID, null, { openInWindow: false });
        // A restored but unloaded tab intentionally makes Reader.open return undefined.
        const reader = openedReader || await waitFor(() => Zotero.Reader.getByTabID(host.Zotero_Tabs.getTabIDByItemID(pdfID)), "restored PDF reader loaded");
        await Promise.race([reader._initPromise, delay(30000).then(() => { throw new Error("Cold PDF initialization timeout"); })]);
        handle = await api.openItem(pdfID, host); await waitFor(() => handle.editor.getCurrentInstance(), "hot reader editor"); await handle.editor.getCurrentInstance()._initPromise;
        await waitFor(() => handle.toolsWindow?.ReadingFlowApp?.getState()?.item.key === parent.key, "hot reader tools");
        check("hot invalid-note test uses actual PDF editor", handle.kind === "reader" && host.ZoteroContextPane.activeEditor === handle.editor);
        const hotNote = handle.note, retiredInstance = handle.editor.getCurrentInstance();
        const hotHTML = await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [hotNote.id]);
        hotNote.deleted = true; await hotNote.saveTx();
        check("PDF Add to Note stops targeting trashed editor", host.ZoteroContextPane.activeEditor !== handle.editor);
        let insertError = null, exportError = null;
        try { await handle.config.bridge.insertPyramid({ pngDataURL: "data:image/png;base64,AA==", width: 1, height: 1 }); } catch (error) { insertError = error.message || String(error); }
        try { await handle.config.bridge.exportNote(handle.getState()); } catch (error) { exportError = error.message || String(error); }
        check("hot trashed note refuses insertion and export", !!insertError && !!exportError, { insertError, exportError });
        check("retired native editor stops saving", retiredInstance._disableSaving === true);
        check("hot invalid-note guards preserve body and trash", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [hotNote.id])) === hotHTML && !!(await Zotero.DB.valueQueryAsync("SELECT itemID FROM deletedItems WHERE itemID=?", [hotNote.id])));
        handle.hide(); handle.button.click();
        await waitFor(() => handle.note?.id !== hotNote.id && handle.note && !handle.note.deleted && handle.deck.selectedPanel === handle.panel, "hot reader rail recovers invalid binding");
        await waitFor(() => handle.toolsWindow?.ReadingFlowApp?.getState()?.noteKey === handle.note.key, "hot recovery tools");
        check("hot reader rail recovery preserves paused tools", JSON.stringify(handle.getState().timers) === JSON.stringify(fixture.draft.timers) && JSON.stringify(handle.getState().pyramid) === JSON.stringify(fixture.draft.pyramid));
        check("hot reader recovery leaves first trashed note untouched", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [fixture.oldNote.id])) === fixture.oldNote.html && !!(await Zotero.DB.valueQueryAsync("SELECT itemID FROM deletedItems WHERE itemID=?", [fixture.oldNote.id])));
      }
      else if (coldMode === "missing-tag-recovery") check("valid bound note missing mutable tag remains usable", !handle.note.deleted && !handle.note.hasTag("Reading Flow · sidebar") && handle.note.id === fixture.oldNote.id);
      else check("second cold restart reuses replacement without backup", (await IOUtils.getChildren(PathUtils.parent(draftPath))).filter(path => !beforeBackups.includes(path)).length === 0 && handle.note.id === note.id);
    }
    result.status = "passed";
  }
  catch (error) { result.status = "failed"; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error); }
  finally {
    result.finishedAt = new Date().toISOString(); await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + ".tmp" });
    delete Zotero.__readingFlowSmokeSandbox; delete Zotero.__readingFlowSmokePromise;
    if (safeToQuit) { try { await handle?.toolsWindow?.ReadingFlowApp?.flushPendingSave(); await delay(1000); await Zotero.DB.waitForTransaction(); } catch (error) { Zotero.logError(error); } Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit); }
  }
}
