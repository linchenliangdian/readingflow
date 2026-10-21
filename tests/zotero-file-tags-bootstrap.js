/* Reproduce tag deletion on 2.2.2, then recover through the native 2.2.3 upgrade.
 * Runs only in its verified disposable profile. No real account is used. */
const expectedProfile = __EXPECTED_PROFILE__, expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__, stages = __PACKAGE_STAGES__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSmokeTest() {
  const result = { status: 'running', scenario: 'deleted-data-tags', checks: [], startedAt: new Date().toISOString() };
  let safeToQuit = false;
  function check(name, condition, detail = null) {
    result.checks.push({ name, passed: !!condition, detail });
    if (!condition) throw new Error('Failed: ' + name);
  }
  async function waitFor(test, label) {
    const until = Date.now() + 30000;
    while (Date.now() < until) { const value = await test(); if (value) return value; await delay(100); }
    throw new Error('Timeout: ' + label);
  }
  async function lifecycle(action, methods) {
    const owner = Zotero.Plugins._addonObserver, wrapped = [], calls = [];
    for (const method of methods) {
      const original = owner[method];
      const wrapper = function (addon, ...args) {
        const value = original.call(this, addon, ...args);
        if (addon.id === 'reading-flow@local') {
          const call = { done: false, error: null }; calls.push(call);
          Promise.resolve(value).then(() => { call.done = true; }, error => { call.done = true; call.error = error; });
        }
        return value;
      };
      owner[method] = wrapper; wrapped.push({ method, original, wrapper });
    }
    try {
      await action(); await waitFor(() => calls.length && calls.every(call => call.done), 'native lifecycle');
      const failed = calls.find(call => call.error); if (failed) throw failed.error;
    } finally { for (const { method, original, wrapper } of wrapped) if (owner[method] === wrapper) owner[method] = original; }
  }
  async function install(stage) {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const before = Zotero.ReadingFlow;
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(stage.path));
    check(stage.version + ' package accepted', !installation.error);
    await lifecycle(() => installation.install(), ['onInstalled', 'onEnabling']);
    const addon = await AddonManager.getAddonByID('reading-flow@local');
    const api = await waitFor(() => Zotero.ReadingFlow && Zotero.ReadingFlow !== before && Zotero.ReadingFlow, 'updated API');
    check(stage.version + ' active', addon.isActive && addon.version === stage.version);
    return { addon, api };
  }
  async function open(api, item, host) {
    const handle = await api.openItem(item.id, host);
    await waitFor(() => handle.editor.getCurrentInstance(), 'native editor');
    await handle.editor.getCurrentInstance()._initPromise;
    return handle;
  }
  async function setState(handle, state) {
    await handle.toolsWindow.ReadingFlowApp.loadConfig({ ...handle.config, initialState: state });
    return handle.config.bridge.flushState(state);
  }
  async function containers(libraryID) {
    const search = new Zotero.Search(); search.libraryID = libraryID;
    search.addCondition('itemType', 'is', 'document'); search.addCondition('deleted', 'false');
    search.addCondition('extra', 'contains', 'READING_FLOW_DATA_CONTAINER_V2');
    return Zotero.Items.getAsync(await search.search());
  }
  async function children(item) { await item.loadDataType('childItems'); return Zotero.Items.getAsync(item.getAttachments()); }
  async function article(title) {
    const item = new Zotero.Item('journalArticle'); item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField('title', title); await item.saveTx(); return item;
  }
  try {
    await Zotero.initializationPromise;
    check('verified disposable profile and data', PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile) && PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData));
    safeToQuit = true;
    const host = await waitFor(() => Zotero.getMainWindow(), 'main window');
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane.collectionsView?.itemTreeView, 'bound trees');
    await host.ZoteroPane.itemsView.waitForLoad();
    const a = await article('Synthetic tagless recovery A'), b = await article('Synthetic tagless recovery B');
    await host.ZoteroPane.selectItems([a.id], { noWindowRestore: true });
    const old = await install(stages[0]); let handle = await open(old.api, a, host);
    const state = handle.getState(); state.pyramid.text = 'Original saved reasoning'; state.pyramid.boldRanges = [{ start: 0, end: 8 }];
    state.framing.situation = 'Preserved background'; state.framing.situationBoldRanges = [{ start: 0, end: 9 }]; state.pyramidFontSize = 24;
    await setState(handle, state);
    const note = handle.note, instance = handle.editor.getCurrentInstance();
    const frame = instance._iframeWindow.wrappedJSObject || instance._iframeWindow;
    await instance._save(JSON.parse(JSON.stringify(frame.getDataSync(false))));
    const originalHTML = note.getNote(), dataContainers = await containers(a.libraryID);
    check('old version created one real native data container', dataContainers.length === 1);
    const container = dataContainers[0], oldFiles = await children(container);
    check('old version created a stored JSON attachment', oldFiles.length === 1 && oldFiles[0].isStoredFileAttachment());
    const oldFile = oldFiles[0], originalJSON = await IOUtils.readUTF8(await oldFile.getFilePathAsync());
    for (const item of [container, ...oldFiles]) { await item.loadDataType('tags'); item.setTags([]); await item.saveTx(); }
    check('all technical tags are removed without changing data bytes', [container, ...oldFiles].every(item => item.getTags().length === 0) && await IOUtils.readUTF8(await oldFile.getFilePathAsync()) === originalJSON);
    const latest = handle.getState(); latest.pyramid.text = 'Newest local reasoning after tags removed';
    let oldError = ''; try { await setState(handle, latest); } catch (error) { oldError = error.message || String(error); }
    check('2.2.2 reproduces the exact reported error', oldError.includes('金字塔数据文件关联已改变'), oldError);
    const cache = PathUtils.join(expectedData, 'reading-flow', a.libraryID + '-' + a.key + '.json');
    check('the failed old save preserves the newest draft', JSON.parse(await IOUtils.readUTF8(cache)).pyramid.text === latest.pyramid.text);
    const updated = await install(stages[1]); handle = await open(updated.api, a, host);
    check('2.2.3 opens the preserved local pyramid after the failed save', handle.getState().pyramid.text === latest.pyramid.text && !handle.config.syncPending && !handle.config.syncConflict);
    check('recovery retains original native prose and formatting', handle.note.id === note.id && note.getNote() === originalHTML && handle.getState().pyramid.boldRanges.length > 0 && handle.getState().pyramidFontSize === 24 && handle.getState().framing.situationBoldRanges.length > 0);
    check('tagless recovery reuses the same data container and preserves the old journal', (await containers(a.libraryID)).length === 1 && await IOUtils.readUTF8(await oldFile.getFilePathAsync()) === originalJSON);
    const second = await open(updated.api, b, host), secondState = second.getState(); secondState.pyramid.text = 'Second owner also saves without tags';
    await setState(second, secondState);
    const files = await children(container);
    check('the new active JSON file aggregates owners without recreating tags', files.length === 2 && [container, ...files].every(item => item.getTags().length === 0));
    await lifecycle(() => updated.addon.disable(), ['onDisabled']);
    for (const item of [a, b]) {
      const path = PathUtils.join(expectedData, 'reading-flow', item.libraryID + '-' + item.key + '.json');
      if (await IOUtils.exists(path)) await IOUtils.move(path, path + '.native-test-backup');
    }
    await lifecycle(() => updated.addon.enable(), ['onEnabling']);
    const active = await waitFor(() => Zotero.ReadingFlow, 're-enabled API');
    handle = await open(active, a, host); const recoveredA = { state: handle.getState(), noteID: handle.note.id };
    const reopenedB = await open(active, b, host);
    check('a fresh activation restores both tagless owners without local caches', recoveredA.state.pyramid.text === latest.pyramid.text && reopenedB.getState().pyramid.text === secondState.pyramid.text);
    check('cache-free recovery uses both exact original prose notes', recoveredA.noteID === note.id && reopenedB.note.id === second.note.id && note.getNote() === originalHTML);
    check('reopening does not create duplicate containers or add tags', (await containers(a.libraryID)).length === 1 && [container, ...await children(container)].every(item => item.getTags().length === 0));
    result.fixture = { containerKey: container.key, noteKey: note.key, originalHTML, oldFileKey: oldFile.key,
      oldFileHash: Zotero.Utilities.Internal.md5(originalJSON), ownerKeys: [a.key, b.key] };
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error); }
  finally {
    result.finishedAt = new Date().toISOString();
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + '.tmp' });
    delete Zotero.__readingFlowSmokePromise; delete Zotero.__readingFlowSmokeSandbox;
    if (safeToQuit) Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
  }
}
