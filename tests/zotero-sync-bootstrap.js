/* Finite native-image regression. Run only in the verified disposable profile.
 * Uses the same placeholder substitution and RDP dispatch as zotero-smoke-setup.py.
 * No account or network sync is enabled: these checks verify the native records
 * and files Zotero will sync, not a completed upload to a second device.
 */
const expectedProfile = __EXPECTED_PROFILE__;
const expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__;
const packagePath = __PACKAGE_PATH__;
const betterNotesPath = __BETTER_NOTES_PATH__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let scheduled = null;
function startup() { scheduled = setTimeout(runSmokeTest, 100); }
function shutdown() { if (scheduled !== null) clearTimeout(scheduled); }
function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}

async function runSmokeTest() {
  const result = { status: "running", scenario: "native-sync-image-records", version: Zotero.version, checks: [], fixtures: [], startedAt: new Date().toISOString() };
  let safeToQuit = false, current = null, progressWrites = Promise.resolve();
  const check = (name, condition, detail) => {
    result.checks.push({ name, passed: !!condition, detail: detail ?? null });
    result.stage = name;
    const progress = JSON.stringify(result, null, 2);
    progressWrites = progressWrites.catch(error => Zotero.logError(error)).then(() => IOUtils.writeUTF8(resultPath, progress, { tmpPath: resultPath + ".tmp" }));
    if (!condition) throw new Error("Failed: " + name);
  };
  async function waitFor(test, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(100); }
    throw new Error("Timeout waiting for " + label);
  }
  async function installXPI(path, id) {
    if (!safeToQuit) throw new Error("Plugin installation requires the verified isolated profile and data paths");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const previous = await AddonManager.getAddonByID(id);
    if (id !== "reading-flow@local" && previous?.isActive) return previous;
    if (id === "reading-flow@local" && previous) {
      if (previous.isActive) {
        // initializationPromise resolves before Plugins.init finishes loading all
        // scopes. isActive alone can still refer to an addon with no bootstrap.
        await waitFor(() => Zotero.ReadingFlow?.openItem, "preinstalled Reading Flow bootstrap startup");
        await completePluginEvent(id, "shutdown", () => previous.disable(), "isolated previous Reading Flow disable");
      }
      // Same-version installation of a disabled XPI can retain its old bytes.
      // Remove only this disposable profile's plugin, retaining all library data.
      await completePluginEvent(id, "uninstall", () => previous.uninstall(), "isolated previous Reading Flow uninstall");
    }
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(path));
    check(id + " package accepted", installation.error === 0, installation.error);
    await completePluginEvent(id, "startup", async () => {
      await installation.install();
      const installed = await AddonManager.getAddonByID(id);
      if (installed?.userDisabled) await installed.enable();
    }, id + " install and startup");
    await waitFor(async () => (await AddonManager.getAddonByID(id))?.isActive, id + " activation");
    return AddonManager.getAddonByID(id);
  }
  async function ready(api, item, host) {
    const handle = await api.openItem(item.id, host);
    await waitFor(() => handle.editor?.getCurrentInstance(), "native editor");
    await handle.editor.getCurrentInstance()._initPromise;
    await waitFor(() => handle.toolsWindow?.ReadingFlowApp, "pyramid tools");
    return handle;
  }
  async function pngFor(handle) {
    const win = handle.toolsWindow, Core = win.ReadingFlowCore, state = handle.getState();
    const source = win.URL.createObjectURL(new win.Blob([Core.renderPyramidSVG(state)], { type: "image/svg+xml" }));
    try {
      const image = new win.Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("SVG failed to decode")); image.src = source; });
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d"); context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
      return { pngDataURL: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
    } finally { win.URL.revokeObjectURL(source); }
  }
  async function seedEditableTree(handle, label) {
    const state = handle.getState();
    state.phase = "analysis";
    state.pyramid.text = label + "：可同步的核心观点";
    state.pyramid.boldRanges = [{ start: 0, end: 4 }];
    state.pyramid.children = [{ id: "sync-argument", type: "argument", text: label + "：支持论点", boldRanges: [{ start: 0, end: 4 }], children: [{ id: "sync-evidence", type: "evidence", text: "证据与方法", source: "第 3 页，图 2", children: [] }] }];
    state.framing.situation = label + "：背景注释"; state.framing.complication = label + "：冲突注释";
    state.inspection.completed = true; state.inspection.checklist = [true, false, true, true, false, true];
    await handle.toolsWindow.ReadingFlowApp.loadConfig({ ...handle.config, initialState: state });
    await handle.config.bridge.saveDraft(state);
    check(label + " editable tree saved through the sync bridge", handle.getState().pyramid.text === state.pyramid.text && !handle.config.syncConflict);
    return handle.getState();
  }
  async function headNotes(item) {
    const search = new Zotero.Search(); search.libraryID = item.libraryID;
    search.addCondition("itemType", "is", "note"); search.addCondition("deleted", "false");
    search.addCondition("note", "contains", "READING_FLOW_SYNC_V1"); search.addCondition("note", "contains", "OWNER:" + item.key); search.addCondition("note", "contains", "KIND:head");
    return Promise.all((await search.search()).map(id => Zotero.Items.getAsync(id)));
  }
  async function completePluginEvent(id, event, action, label) {
    // AddonManager does not await these async listeners. Track the exact native
    // promises, including the no-bootstrap path which skips plugin observers.
    const owner = Zotero.Plugins._addonObserver, calls = [], wrapped = [];
    const methods = event === "shutdown" ? ["onDisabled"] : event === "uninstall" ? ["onUninstalling", "onUninstalled"] : ["onInstalled", "onEnabling"];
    for (const method of methods) {
      const original = owner[method];
      if (typeof original !== "function") throw new Error("Missing native plugin listener: " + method);
      const wrapper = function (addon, ...args) {
        const returned = original.call(this, addon, ...args);
        if (addon.id === id) {
          const call = { method, done: false, error: null }; calls.push(call);
          Promise.resolve(returned).then(() => { call.done = true; }, error => { call.error = error; call.done = true; });
        }
        return returned;
      };
      owner[method] = wrapper; wrapped.push({ method, original, wrapper });
    }
    try {
      await action();
      await waitFor(() => calls.length && (event !== "uninstall" || calls.some(call => call.method === "onUninstalled")) && calls.every(call => call.done), label + " complete native addon listener promises");
      const failed = calls.find(call => call.error); if (failed) throw failed.error;
      check(label + " native plugin lifecycle has fully completed", calls.length > 0 && calls.every(call => call.done), { callbacks: calls.map(call => call.method) });
    } finally { for (const { method, original, wrapper } of wrapped) if (owner[method] === wrapper) owner[method] = original; }
  }
  async function completeAddonLifecycle(addon, enable, label) {
    await completePluginEvent(addon.id, enable ? "startup" : "shutdown", () => enable ? addon.enable() : addon.disable(), label);
  }
  async function recoverWithoutLocalCache(addon, api, item, host, state, label) {
    const noteID = current.note.id, heads = await headNotes(item);
    check(label + " editable data is stored in ordinary Zotero sync notes", heads.length > 0 && heads.every(note => note.isNote() && !note.deleted && note.libraryID === item.libraryID && (item.isNote() ? !note.parentID : note.parentID === item.id)), heads.map(note => ({ id: note.id, key: note.key, parentID: note.parentID })));
    const cachePath = PathUtils.join(expectedData, "reading-flow", item.libraryID + "-" + item.key + ".json");
    check(label + " cache operation stays inside the verified isolated data directory", /^[A-Z0-9]{8}$/.test(item.key) && PathUtils.normalize(PathUtils.parent(PathUtils.parent(cachePath))) === PathUtils.normalize(expectedData));
    await completeAddonLifecycle(addon, false, label + " disable");
    await waitFor(() => !Zotero.ReadingFlow, "Reading Flow fully disabled"); await Zotero.DB.waitForTransaction();
    const backupPath = cachePath + ".native-sync-test-" + Date.now() + ".bak";
    await IOUtils.move(cachePath, backupPath, { noOverwrite: true });
    check(label + " local JSON removed from the loading path after plugin shutdown", !(await IOUtils.exists(cachePath)) && await IOUtils.exists(backupPath), { cachePath, backupPath });
    await completeAddonLifecycle(addon, true, label + " enable");
    const nextAPI = await waitFor(() => Zotero.ReadingFlow?.openItem && Zotero.ReadingFlow, "fresh Reading Flow API");
    check(label + " restart discards the previous plugin memory", nextAPI !== api);
    current = await ready(nextAPI, item, host);
    const restored = current.getState(), document = current.toolsWindow.document;
    check(label + " Zotero notes restore the same three-level editable tree", JSON.stringify(restored.pyramid) === JSON.stringify(state.pyramid), { expected: state.pyramid, actual: restored.pyramid });
    check(label + " Zotero notes restore bold ranges and background conflict annotations", JSON.stringify(restored.framing) === JSON.stringify(state.framing) && restored.pyramid.boldRanges?.[0]?.start === 0 && restored.pyramid.children[0].boldRanges?.[0]?.end === 4);
    check(label + " restored data keeps original native prose note and inspection state", current.note.id === noteID && restored.inspection.completed && JSON.stringify(restored.inspection.checklist) === JSON.stringify(state.inspection.checklist));
    const rootEditor = document.querySelector('.node[data-node-id="root"] .node-text');
    check(label + " recovered pyramid is editable rather than a PNG preview", rootEditor?.getAttribute("contenteditable") === "true" && rootEditor.textContent === state.pyramid.text && !current.config.readOnly && document.querySelectorAll(".node").length === 3);
    const boldText = Array.from(rootEditor.querySelectorAll("strong,b")).map(node => node.textContent).join("");
    check(label + " recovered pyramid renders the saved partial bold text", boldText === state.pyramid.text.slice(0, 4), boldText);
    rootEditor.textContent = state.pyramid.text + "；恢复后继续编辑";
    rootEditor.dispatchEvent(new current.toolsWindow.Event("input", { bubbles: true }));
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    check(label + " recovered pyramid can be edited and saved again", current.getState().pyramid.text.endsWith("恢复后继续编辑") && !current.config.syncConflict);
    result.cacheRecoveryFixtures = result.cacheRecoveryFixtures || [];
    result.cacheRecoveryFixtures.push({ itemID: item.id, ownerKey: item.key, noteID, headKeys: heads.map(note => note.key), backupPath, restoredPyramid: restored.pyramid, restoredFraming: restored.framing });
    return nextAPI;
  }
  async function verifyNativeImage(api, item, host, label) {
    current = await ready(api, item, host);
    const expectedState = await seedEditableTree(current, label);
    const note = current.note, marker = label + "原生正文必须保留";
    const instance = current.editor.getCurrentInstance();
    instance._postMessage({ action: "insertHTML", pos: -1, html: "<p>" + marker + "</p>" });
    await waitFor(() => {
      const frame = instance._iframeWindow.wrappedJSObject || instance._iframeWindow;
      return frame.getDataSync(true)?.html?.includes(marker);
    }, "original native prose");
    const outcome = await current.config.bridge.insertPyramid(await pngFor(current));
    const html = await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [note.id]);
    const key = html?.match(/data-attachment-key=["']([^"']+)["']/)?.[1];
    const attachment = key && await Zotero.Items.getByLibraryAndKeyAsync(note.libraryID, key);
    check(label + " insertion returns only after native note is durable", outcome?.message === "金字塔已插入笔记" && html.includes(marker) && /^[A-Z0-9]{8}$/.test(key || ""), { key, noteID: note.id });
    check(label + " image uses an embedded-image child of the exact note", !!attachment?.isEmbeddedImageAttachment() && attachment.libraryID === note.libraryID && attachment.parentID === note.id && attachment.attachmentContentType === "image/png");
    check(label + " durable HTML references the native attachment without a data URL", !html.includes('src="data:image/png') && html.includes('data-attachment-key="' + key + '"'));
    const path = await attachment.getFilePathAsync(), bytes = path && await IOUtils.read(path);
    check(label + " image is a complete native PNG file", path && PathUtils.normalize(PathUtils.parent(PathUtils.parent(PathUtils.parent(path)))) === PathUtils.normalize(expectedData) && bytes?.length > 100 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value), { path, bytes: bytes?.length });
    check(label + " new note and image are pending native data sync", note.synced === false && attachment.synced === false, { noteSynced: note.synced, imageSynced: attachment.synced });
    const decoded = new host.Image();
    decoded.src = Zotero.File.pathToFileURI(path);
    await waitFor(() => decoded.complete && decoded.naturalWidth > 0, "native PNG file decode");
    check(label + " native attachment PNG decodes", decoded.naturalWidth > 0 && decoded.naturalHeight > 0, { width: decoded.naturalWidth, height: decoded.naturalHeight });
    result.fixtures.push({ itemID: item.id, libraryID: note.libraryID, noteID: note.id, noteKey: note.key, imageKey: key, imageID: attachment.id, imagePath: path, marker, fileSyncState: attachment.attachmentSyncState });
    return expectedState;
  }
  try {
    await Zotero.initializationPromise;
    check("isolated profile", PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile), Zotero.Profile.dir);
    check("isolated data directory", PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData), Zotero.DataDirectory.dir);
    safeToQuit = true; result.processID = Services.appinfo.processID;
    const host = await waitFor(() => Zotero.getMainWindow(), "main window");
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane?.collectionsView, "library view");
    if (betterNotesPath) {
      const betterNotes = await installXPI(betterNotesPath, "Knowledge4Zotero@windingwind.com");
      await waitFor(() => Zotero.BetterNotes?.hooks, "Better Notes startup");
      result.betterNotesVersion = betterNotes.version;
    }
    const addon = await installXPI(packagePath, "reading-flow@local"); result.pluginVersion = addon.version;
    let api = await waitFor(() => Zotero.ReadingFlow?.openItem && Zotero.ReadingFlow, "Reading Flow API");
    const installedPath = PathUtils.join(expectedProfile, "extensions", "reading-flow@local.xpi");
    const [expected, actual] = await Promise.all([IOUtils.read(packagePath), IOUtils.read(installedPath)]);
    check("installed package matches the current build", expected.length === actual.length && expected.every((byte, index) => byte === actual[index]));
    const article = new Zotero.Item("journalArticle"); article.libraryID = Zotero.Libraries.userLibraryID; article.setField("title", "同步图像隔离验证：条目笔记"); await article.saveTx();
    const articleState = await verifyNativeImage(api, article, host, "child note");
    api = await recoverWithoutLocalCache(addon, api, article, host, articleState, "child note");
    const independent = new Zotero.Item("note"); independent.libraryID = article.libraryID; independent.setNote("<div data-schema-version=\"9\"><p>同步图像隔离验证：独立笔记</p></div>"); await independent.saveTx();
    const independentState = await verifyNativeImage(api, independent, host, "standalone note");
    api = await recoverWithoutLocalCache(addon, api, independent, host, independentState, "standalone note");
    check("independent insertion preserves exact original note identity", current.note.id === independent.id && !current.note.parentID);
    if (betterNotesPath) check("Better Notes coexists after both image insertions", !!Zotero.BetterNotes?.hooks);
    result.status = "passed";
  } catch (error) {
    result.status = "failed"; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error);
  } finally {
    result.finishedAt = new Date().toISOString();
    await progressWrites;
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + ".tmp" });
    delete Zotero.__readingFlowSmokeSandbox; delete Zotero.__readingFlowSmokePromise;
    if (safeToQuit) Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
  }
}
