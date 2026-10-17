/* Included only in a separate test XPI inside tmp/zotero-test/profile. */
const expectedProfile = __EXPECTED_PROFILE__;
const expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__;
const packagePath = __PACKAGE_PATH__;
let scheduled = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startup() {
  // Return immediately so Zotero can finish initializing the other plugin and main window.
  scheduled = setTimeout(runSmokeTest, 100);
}
function shutdown() { if (scheduled !== null) clearTimeout(scheduled); }
function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}

async function runSmokeTest() {
  const result = { status: "running", version: Zotero.version, checks: [], startedAt: new Date().toISOString() };
  let appWindow = null;
  let safeToQuit = false;
  function check(name, condition, detail) {
    result.checks.push({ name, passed: !!condition, detail: detail || null });
    if (!condition) throw new Error("Failed: " + name + (detail ? " — " + detail : ""));
  }
  async function waitFor(test, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = test();
      if (value) return value;
      await delay(100);
    }
    throw new Error("Timeout waiting for " + label);
  }
  try {
    await Promise.race([Zotero.initializationPromise, delay(30000).then(() => { throw new Error("Initialization timeout"); })]);
    check("isolated profile", PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile), Zotero.Profile.dir);
    check("isolated data directory", PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData), Zotero.DataDirectory.dir);
    safeToQuit = true;
    if (!Zotero.getMainWindow()) Zotero.openMainWindow();
    {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(packagePath));
      result.install = { initialError: installation.error, initialState: installation.state, addonID: installation.addon?.id || null };
      check("package accepted by installer", installation.error === 0, String(installation.error));
      await installation.install();
      await delay(200);
      await waitFor(() => Zotero.ReadingFlow, "installed plugin startup");
      const installed = await AddonManager.getAddonByID("reading-flow@local");
      check("plugin installed and active", installed && installed.isActive, installed?.id || "missing");
    }
    const api = await waitFor(() => Zotero.ReadingFlow && Zotero.ReadingFlow.openItem && Zotero.ReadingFlow, "Reading Flow API");
    const host = await waitFor(() => Zotero.getMainWindow(), "main window");
    await waitFor(() => host.ZoteroPane && host.ZoteroPane.itemsView, "library items view");
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", "隔离测试：论文 <标题> & 金字塔");
    await item.saveTx();
    result.item = { id: item.id, libraryID: item.libraryID, key: item.key };
    appWindow = await api.openItem(item.id, host);
    await waitFor(() => appWindow.ReadingFlowApp && appWindow.ReadingFlowCore, "app scripts and bridge");
    check("chrome app loaded", appWindow.location.href === "chrome://reading-flow/content/app.xhtml");
    check("paper mapped", appWindow.ReadingFlowApp.getState().item.key === item.key);
    check("title rendered as text", appWindow.document.getElementById("paper-title").textContent === item.getField("title"));
    check("duplicate window avoided", await api.openItem(item.id, host) === appWindow);
    const config = appWindow.arguments[0].wrappedJSObject || appWindow.arguments[0];
    let state = appWindow.ReadingFlowApp.getState();
    state.inspection.question = "检验 <script>alert('x')</script> & 研究问题";
    state.inspection.classified = true;
    state.pyramid.text = "总论点：证据支持结论";
    const argument = appWindow.ReadingFlowCore.addNode(state, "root", "argument");
    argument.text = "分论点 <img src=x onerror=alert(1)>";
    const evidence = appWindow.ReadingFlowCore.addNode(state, argument.id, "evidence");
    evidence.text = "底层证据";
    evidence.source = "第 3 页，图 2";
    const term = appWindow.ReadingFlowCore.addTerm(state);
    term.term = "控制变量"; term.meaning = "用自己的话解释"; term.source = "第 2 页";
    const firstSave = config.bridge.saveState(state);
    const second = JSON.parse(JSON.stringify(state));
    second.reflection.nextStep = "最后一次排队保存";
    const secondSave = config.bridge.saveState(second);
    await Promise.all([firstSave, secondSave]);
    const path = PathUtils.join(expectedData, "reading-flow", item.libraryID + "-" + item.key + ".json");
    const saved = JSON.parse(await IOUtils.readUTF8(path));
    check("serialized atomic save", saved.reflection.nextStep === second.reflection.nextStep);
    check("tree stored", saved.pyramid.children[0].children[0].source === evidence.source);
    check("temporary draft replaced", !(await IOUtils.exists(path + ".tmp")));
    // Adopt the seed through the real UI import action so unload saves the current UI state.
    // Only native file selection and the replacement confirmation are substituted here.
    const originalImport = config.bridge.importJSON;
    const originalConfirm = appWindow.confirm;
    config.bridge.importJSON = async () => second;
    appWindow.confirm = () => true;
    appWindow.document.getElementById("backup-import").click();
    await waitFor(() => appWindow.ReadingFlowApp.getState().reflection.nextStep === second.reflection.nextStep, "UI adoption of saved draft");
    await appWindow.ReadingFlowApp.flushPendingSave();
    config.bridge.importJSON = originalImport;
    appWindow.confirm = originalConfirm;
    appWindow.close();
    await waitFor(() => appWindow.closed, "first window close");
    appWindow = await api.openItem(item.id, host);
    await waitFor(() => appWindow.ReadingFlowApp, "restored app");
    state = appWindow.ReadingFlowApp.getState();
    check("draft restored", state.reflection.nextStep === second.reflection.nextStep && state.pyramid.children[0].children[0].text === "底层证据");
    const restoredConfig = appWindow.arguments[0].wrappedJSObject || appWindow.arguments[0];
    const exported = await restoredConfig.bridge.exportNote(state);
    const note = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, exported.noteKey);
    check("child note parent", note && note.parentID === item.id);
    check("note tagged", note.getTags().some(tag => tag.tag === "Reading Flow"));
    const html = note.getNote();
    check("note content escaped", html.includes("&lt;script&gt;") && html.includes("&lt;img") && !html.includes("<script>") && !html.includes("<img src=x"));
    check("note contains terms and evidence", html.includes("控制变量") && html.includes("第 3 页，图 2"));
    const secondExport = await restoredConfig.bridge.exportNote(state);
    check("new snapshot preserves previous note", secondExport.noteKey !== exported.noteKey && item.getNotes().length === 2);
    result.status = "passed";
  }
  catch (error) {
    result.status = "failed";
    result.error = { message: error.message || String(error), stack: error.stack || null, additionalErrors: error.additionalErrors || null };
    Zotero.logError(error);
  }
  finally {
    try {
      result.addonConsole = Services.console.getMessageArray().map(message => message.message || String(message))
        .filter(message => /reading-flow|Extension is invalid|addMetadata|addons\.xpi|bootstrap/i.test(message)).slice(-40);
    } catch (_) {}
    result.finishedAt = new Date().toISOString();
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + ".tmp" });
    if (safeToQuit) {
      if (appWindow && !appWindow.closed) {
        try { await appWindow.ReadingFlowApp?.flushPendingSave(); } catch (error) { Zotero.logError(error); }
        appWindow.close();
      }
      // Services belongs to this explicitly verified isolated process.
      Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
    }
  }
}
