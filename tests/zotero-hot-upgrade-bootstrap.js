/* A finite same-process upgrade test. Runs only in its verified disposable profile. */
const expectedProfile = __EXPECTED_PROFILE__;
const expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__;
const packageStages = __PACKAGE_STAGES__;
const pdfFixturePath = __PDF_FIXTURE_PATH__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSmokeTest() {
  const result = { status: "running", scenario: "native-hot-upgrade", version: Zotero.version, checks: [], stages: [], lifecycle: [], processID: Services.appinfo.processID, startedAt: new Date().toISOString() };
  let safeToQuit = false, current = null;
  async function checkpoint() { await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + ".tmp" }); }
  function check(name, condition, detail = null) {
    result.checks.push({ name, passed: !!condition, detail });
    if (!condition) throw new Error("Failed: " + name + (detail ? " — " + JSON.stringify(detail) : ""));
  }
  async function waitFor(test, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(100); }
    throw new Error("Timeout waiting for " + label);
  }
  async function pluginEvent(action, label) {
    const owner = Zotero.Plugins._addonObserver, calls = [], wrapped = [];
    for (const method of ["onInstalling", "onInstalled", "onEnabling"]) {
      const original = owner[method];
      if (typeof original !== "function") throw new Error("Missing native addon listener " + method);
      const wrapper = function (addon, ...args) {
        const returned = original.call(this, addon, ...args);
        if (addon.id === "reading-flow@local") {
          const call = { method, version: addon.version, done: false, error: null, startedAt: new Date().toISOString() }; calls.push(call); result.lifecycle.push(call);
          Promise.resolve(returned).then(() => { call.done = true; call.finishedAt = new Date().toISOString(); }, error => { call.error = error.message || String(error); call.done = true; call.finishedAt = new Date().toISOString(); });
        }
        return returned;
      };
      owner[method] = wrapper; wrapped.push({ method, original, wrapper });
    }
    try {
      await action();
      await waitFor(() => calls.some(call => call.method === "onInstalled") && calls.every(call => call.done), label + " native lifecycle completion");
      const failed = calls.find(call => call.error); if (failed) throw new Error(failed.error);
      check(label + " awaits the actual native addon lifecycle", calls.every(call => call.done), calls.map(call => call.method));
    } finally { for (const { method, original, wrapper } of wrapped) if (owner[method] === wrapper) owner[method] = original; }
  }
  async function installStage(stage) {
    if (!safeToQuit) throw new Error("Installation requires verified isolated profile/data");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const previousAPI = Zotero.ReadingFlow;
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(stage.path));
    check(stage.version + " package accepted", installation.error === 0, installation.error);
    // Deliberately use a normal install over the active old version. Explicitly
    // uninstalling, clearing caches, or restarting would hide this regression.
    await pluginEvent(async () => {
      await installation.install();
      const installed = await AddonManager.getAddonByID("reading-flow@local");
      if (installed?.userDisabled) await installed.enable();
    }, stage.version + " same-process install");
    const addon = await AddonManager.getAddonByID("reading-flow@local");
    check(stage.version + " metadata is active in the same process", addon?.isActive && addon.version === stage.version && Services.appinfo.processID === result.processID);
    const api = await waitFor(() => Zotero.ReadingFlow?.openItem && Zotero.ReadingFlow !== previousAPI && Zotero.ReadingFlow, stage.version + " new bootstrap API");
    const actualPackage = await IOUtils.read(PathUtils.join(expectedProfile, "extensions", "reading-flow@local.xpi"));
    const expectedPackage = await IOUtils.read(stage.path);
    check(stage.version + " installed bytes match selected package", actualPackage.length === expectedPackage.length && actualPackage.every((byte, index) => byte === expectedPackage[index]));
    return { addon, api };
  }
  async function ready(api, item, host) {
    const handle = await api.openItem(item.id, host);
    await waitFor(() => handle.editor?.getCurrentInstance(), "native note editor");
    await handle.editor.getCurrentInstance()._initPromise;
    await waitFor(() => handle.toolsWindow?.ReadingFlowApp, "reading tools document");
    const document = handle.toolsWindow.document;
    if (document.getElementById("pyramid-area").hidden) document.getElementById("pyramid-toggle").click();
    if (!document.querySelector(".framing-note") || document.querySelector(".framing-note").hidden) document.getElementById("framing-toggle").click();
    await delay(250);
    return handle;
  }
  function setPlain(editor, value, window) {
    if (editor.localName === "textarea") editor.value = value; else editor.textContent = value;
    editor.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  function snapshot(handle, version, context) {
    const document = handle.toolsWindow.document, window = handle.toolsWindow;
    const annotation = document.querySelector(".framing-note"), root = document.querySelector('.node[data-node-id="root"]');
    return {
      version, context, processID: Services.appinfo.processID, frameURL: handle.frame.contentWindow.location.href,
      stylesheetURLs: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(node => node.href),
      scriptURLs: Array.from(document.querySelectorAll("script[src]")).map(node => node.src),
      rootWidth: root.getBoundingClientRect().width, annotationWidth: annotation.getBoundingClientRect().width,
      rootComputedWidth: window.getComputedStyle(root).width, annotationComputedWidth: window.getComputedStyle(annotation).width,
      editors: ["situation", "complication"].map(field => { const node = document.getElementById("framing-" + field); return { field, tag: node.localName, contenteditable: node.getAttribute("contenteditable"), text: node.localName === "textarea" ? node.value : node.textContent }; }),
      ownerKey: handle.getState().item.key, noteKey: handle.note.key
    };
  }
  function checkCurrentResources(handle, metadata) {
    const expected = packageStages[packageStages.length - 1].version;
    const urls = [metadata.frameURL, ...metadata.stylesheetURLs, ...metadata.scriptURLs];
    check(metadata.context + " actual document and every linked stylesheet/script carry the installed version", metadata.stylesheetURLs.length === 1 && metadata.scriptURLs.length === 2 && urls.every(url => new handle.toolsWindow.URL(url).searchParams.get("v") === expected), urls);
    check(metadata.context + " annotation matches the root width after hot upgrade", metadata.rootWidth === 300 && metadata.annotationWidth === 300, metadata);
    check(metadata.context + " annotation is the current rich-text implementation", metadata.editors.every(editor => editor.tag === "div" && editor.contenteditable === "true"), metadata.editors);
  }
  async function typeNative(handle, value) {
    const nativeWindow = handle.editor.getCurrentInstance()._iframeWindow, document = nativeWindow.document;
    const prose = await waitFor(() => document.querySelector(".ProseMirror"), "native prose");
    prose.focus(); const range = document.createRange(); range.selectNodeContents(prose); range.collapse(false);
    const selection = nativeWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    check("old native editor accepts the synthetic prose fixture", document.execCommand("insertText", false, value));
    handle.editor.saveSync();
    await waitFor(async () => (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [handle.note.id]))?.includes(value), "old native prose saved");
  }
  function selectedFieldBold(state, field, word) { return (state.framing[field + "BoldRanges"] || []).some(range => state.framing[field].slice(range.start, range.end) === word); }
  async function boldAnnotations(handle) {
    const window = handle.toolsWindow, document = window.document, button = document.getElementById("node-bold");
    for (const [field, word, keyboard] of [["situation", "background", false], ["complication", "conflict", true]]) {
      const editor = document.getElementById("framing-" + field), value = editor.textContent, start = value.indexOf(word);
      editor.focus(); const range = document.createRange(); range.setStart(editor.firstChild, start); range.setEnd(editor.firstChild, start + word.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      await waitFor(() => !button.disabled && button.getAttribute("aria-pressed") === "false", field + " selection for bold");
      if (keyboard) editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true })); else button.click();
      check("hot-upgraded " + field + " supports selected-text bold", selectedFieldBold(handle.getState(), field, word) && editor.textContent === value && editor.querySelector("strong,b")?.textContent === word);
    }
    await window.ReadingFlowApp.flushPendingSave();
    const svg = new window.DOMParser().parseFromString(window.ReadingFlowCore.renderPyramidSVG(handle.getState()), "image/svg+xml");
    const bold = Array.from(svg.querySelectorAll('[data-role="framing-annotation"] tspan[font-weight="700"]')).map(node => node.textContent).join("");
    check("hot-upgraded annotation exports preserve selected formatting", bold.includes("background") && bold.includes("conflict"), bold);
  }
  try {
    await Zotero.initializationPromise;
    check("isolated profile", PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile), Zotero.Profile.dir);
    check("isolated data directory", PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData), Zotero.DataDirectory.dir);
    safeToQuit = true;
    const host = await waitFor(() => Zotero.getMainWindow(), "main Zotero window");
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane?.collectionsView?.itemTreeView, "library item/collection tree binding");
    await host.ZoteroPane.itemsView.waitForLoad();
    host.resizeTo(1300, 900);
    const article = new Zotero.Item("journalArticle"); article.libraryID = Zotero.Libraries.userLibraryID; article.setField("title", "Synthetic same-process hot-upgrade fixture"); await article.saveTx();
    const other = new Zotero.Item("journalArticle"); other.libraryID = article.libraryID; other.setField("title", "Synthetic note switch fixture"); await other.saveTx();
    await host.ZoteroPane.selectItems([article.id], { noWindowRestore: true });
    const old = await installStage(packageStages[0]);
    current = await ready(old.api, article, host);
    const rootText = "Hot upgrade: existing root content", nativeText = "Hot upgrade original native prose survives.";
    const oldDocument = current.toolsWindow.document;
    setPlain(oldDocument.querySelector('.node[data-node-id="root"] .node-text'), rootText, current.toolsWindow);
    setPlain(oldDocument.getElementById("framing-situation"), "Hot upgrade background survives.", current.toolsWindow);
    setPlain(oldDocument.getElementById("framing-complication"), "Hot upgrade conflict survives.", current.toolsWindow);
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    await typeNative(current, nativeText);
    const originalNoteID = current.note.id, originalNoteKey = current.note.key;
    const oldMetadata = snapshot(current, old.addon.version, "old-library"); result.stages.push(oldMetadata);
    check("old package actually primes the narrow annotation and textarea resources", oldMetadata.rootWidth === 300 && oldMetadata.annotationWidth === 180 && oldMetadata.editors.every(editor => editor.tag === "textarea"), oldMetadata);
    await checkpoint();
    let newest;
    for (let index = 1; index < packageStages.length; index++) {
      newest = await installStage(packageStages[index]);
      current = await ready(newest.api, article, host);
      const metadata = snapshot(current, newest.addon.version, "library-" + newest.addon.version); result.stages.push(metadata);
      check(newest.addon.version + " keeps the original note and legacy plain data", current.note.id === originalNoteID && current.note.key === originalNoteKey && current.getState().pyramid.text === rootText && current.getState().framing.situation === "Hot upgrade background survives." && current.getState().framing.complication === "Hot upgrade conflict survives.");
      if (index < packageStages.length - 1) result.unversionedResourceCache = { staleStyles: metadata.annotationWidth === 180, staleApp: metadata.editors.every(editor => editor.tag === "textarea") };
      else checkCurrentResources(current, metadata);
      await checkpoint();
    }
    await boldAnnotations(current);
    const state = current.getState(), cachePath = PathUtils.join(expectedData, "reading-flow", article.libraryID + "-" + article.key + ".json");
    const cached = JSON.parse(await IOUtils.readUTF8(cachePath));
    check("hot-upgraded framing text and formatting persist in the note cache", cached.pyramid.text === rootText && selectedFieldBold(cached, "situation", "background") && selectedFieldBold(cached, "complication", "conflict"));
    await ready(newest.api, other, host);
    current = await ready(newest.api, article, host);
    check("saved annotations reopen with text and formatting after switching notes", current.note.id === originalNoteID && JSON.stringify(current.getState().framing) === JSON.stringify(state.framing) && ["situation", "complication"].every(field => !!current.toolsWindow.document.getElementById("framing-" + field).querySelector("strong,b")));
    const attachment = await Zotero.Attachments.importFromFile({ file: pdfFixturePath, parentItemID: article.id });
    const reader = await Zotero.Reader.open(attachment.id, null, { openInWindow: false }); await reader._initPromise;
    current = await ready(newest.api, attachment, host);
    const readerMetadata = snapshot(current, newest.addon.version, "reader-" + newest.addon.version); result.stages.push(readerMetadata);
    checkCurrentResources(current, readerMetadata);
    check("PDF reader uses the same original note and formatted annotation data", current.kind === "reader" && current.note.id === originalNoteID && JSON.stringify(current.getState().framing) === JSON.stringify(state.framing));
    check("hot upgrade and both contexts preserve original native prose", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [originalNoteID])).includes(nativeText));
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    result.fixture = { libraryID: article.libraryID, ownerKey: article.key, noteID: originalNoteID, noteKey: originalNoteKey, rootText, nativeText, framing: state.framing };
    result.pluginVersion = newest.addon.version; result.status = "passed";
  } catch (error) {
    result.status = "failed"; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error);
  } finally {
    result.finishedAt = new Date().toISOString(); await checkpoint();
    delete Zotero.__readingFlowSmokePromise; delete Zotero.__readingFlowSmokeSandbox;
    if (safeToQuit) {
      try { current?.editor?.saveSync(); await current?.toolsWindow?.ReadingFlowApp?.flushPendingSave(); } catch (error) { Zotero.logError(error); }
      Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
    }
  }
}
