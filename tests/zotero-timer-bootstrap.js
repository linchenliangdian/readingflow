/* Honest running-timer snapshots become expired after saving. Only this
 * verified disposable library is used; no cloud account or formal data. */
const expectedProfile = __EXPECTED_PROFILE__, expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__, stages = __PACKAGE_STAGES__, oldRuntimeURI = __OLD_RUNTIME_URI__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSmokeTest() {
  const result = { status: 'running', scenario: 'expired-timer-hot-upgrade', checks: [], startedAt: new Date().toISOString() };
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
    await lifecycle(() => installation.install(), ['onInstalling', 'onInstalled', 'onEnabling']);
    const addon = await AddonManager.getAddonByID('reading-flow@local');
    const api = await waitFor(() => Zotero.ReadingFlow && Zotero.ReadingFlow !== before && Zotero.ReadingFlow, 'updated API');
    check(stage.version + ' active in the same process', addon.isActive && addon.version === stage.version && Services.appinfo.processID === result.processID);
    return { addon, api };
  }
  async function open(api, item, host) {
    const handle = await api.openItem(item.id, host);
    await waitFor(() => handle.editor.getCurrentInstance(), 'native editor');
    await handle.editor.getCurrentInstance()._initPromise;
    await waitFor(() => handle.toolsWindow?.ReadingFlowApp, 'reading tools');
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
  const identity = item => ({ libraryID: item.libraryID, key: item.key, title: item.getField('title') });
  const cachePath = item => PathUtils.join(expectedData, 'reading-flow', item.libraryID + '-' + item.key + '.json');
  try {
    await Zotero.initializationPromise;
    check('verified disposable profile and data', PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile) && PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData));
    safeToQuit = true; result.processID = Services.appinfo.processID;
    const host = await waitFor(() => Zotero.getMainWindow(), 'main window');
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane.collectionsView?.itemTreeView, 'bound trees');
    await host.ZoteroPane.itemsView.waitForLoad();
    Object.assign(globalThis, { TextEncoder: host.TextEncoder, TextDecoder: host.TextDecoder, btoa: host.btoa.bind(host), atob: host.atob.bind(host) });
    for (const filename of ['core.js', 'sync.js', 'file-sync.js']) Services.scriptloader.loadSubScript(oldRuntimeURI + filename, globalThis, 'UTF-8');
    const oldCore = globalThis.ReadingFlowCore, oldSync = globalThis.ReadingFlowSync;
    const oldFiles = globalThis.ReadingFlowFileSync.create({ Zotero, IOUtils, PathUtils });
    const fixtures = [];
    for (const phase of ['inspection', 'analysis']) {
      const owner = new Zotero.Item('journalArticle'); owner.libraryID = Zotero.Libraries.userLibraryID;
      owner.setField('title', 'Synthetic expired ' + phase + ' timer'); await owner.saveTx();
      const note = new Zotero.Item('note'); note.libraryID = owner.libraryID; note.parentID = owner.id;
      note.setNote('<div data-schema-version="9"><h1>Synthetic original prose ' + phase + '</h1><p>Preserve this <strong>independent native text</strong>.</p></div>'); await note.saveTx();
      const savedAt = Date.now() - oldCore.DURATIONS[phase] * 2;
      const state = oldCore.createSession(identity(owner), savedAt); state.noteKey = note.key;
      state.pyramid.text = 'Saved reasoning for ' + phase; state.pyramid.boldRanges = [{ start: 0, end: 5 }];
      oldCore.addNode(state, 'root').text = 'Preserved supporting argument';
      state.framing.situation = 'Preserved background'; state.framing.situationBoldRanges = [{ start: 0, end: 9 }];
      state.framing.complication = 'Preserved conflict'; state.framing.complicationBoldRanges = [{ start: 0, end: 9 }];
      state.pyramidFontSize = 24; oldCore.startTimer(state, phase, savedAt);
      const record = { format: oldSync.FORMAT, kind: 'head', ownerKey: owner.key, ownerKind: 'item', deviceID: oldFiles.writerID,
        revision: 'expired-' + phase, clock: { [oldFiles.writerID]: 1 }, state, hash: oldSync.stateHash(state) };
      check(phase + ' fixture is a valid snapshot at its original save time', oldSync.stateHash(oldCore.normalizeSession(state, identity(owner), savedAt)) === record.hash && state.timers[phase].status === 'running' && state.timers[phase].deadline < Date.now());
      fixtures.push({ phase, owner, note, originalHTML: note.getNote(), state, record });
    }
    await oldFiles.write(fixtures[0].owner.libraryID, fixtures.map(fixture => fixture.record));
    for (const fixture of fixtures) {
      const cache = { ...fixture.state, readingFlowSync: { format: oldSync.FORMAT, ownerKey: fixture.owner.key, clock: fixture.record.clock,
        stateHash: fixture.record.hash, revision: fixture.record.revision, pending: false } };
      await IOUtils.writeUTF8(cachePath(fixture.owner), JSON.stringify(cache));
    }
    const container = (await containers(fixtures[0].owner.libraryID))[0], journal = (await children(container))[0];
    const originalJSON = await IOUtils.readUTF8(await journal.getFilePathAsync());
    const old = await install(stages[0]);
    for (const fixture of fixtures) {
      const handle = await open(old.api, fixture.owner, host);
      check('2.2.3 reproduces false pending for expired ' + fixture.phase, handle.config.syncPending && handle.config.readOnly && handle.toolsWindow.document.getElementById('start-inspection').disabled && handle.getState().pyramid.text === fixture.state.pyramid.text);
    }
    const updated = await install(stages[1]);
    for (const fixture of fixtures) {
      const handle = await open(updated.api, fixture.owner, host), state = handle.getState();
      check('2.2.4 restores editable expired ' + fixture.phase + ' pyramid', !handle.config.syncPending && !handle.config.syncConflict && !handle.config.readOnly && !handle.toolsWindow.document.getElementById('start-inspection').disabled && state.pyramid.text === fixture.state.pyramid.text);
      check(fixture.phase + ' timer expires normally while all formatting and prose remain intact', state.timers[fixture.phase].status === 'expired' && state.timers[fixture.phase].remainingMs === 0 && state.pyramid.boldRanges[0].end === 5 && state.pyramidFontSize === 24 && state.framing.situationBoldRanges[0].end === 9 && state.framing.complicationBoldRanges[0].end === 9 && state.pyramid.children[0].text === 'Preserved supporting argument' && handle.note.id === fixture.note.id && fixture.note.getNote() === fixture.originalHTML);
      state.pyramid.text += ' / edited after recovery'; fixture.editedText = state.pyramid.text;
      const saved = await setState(handle, state);
      check(fixture.phase + ' can save edits after timer recovery', !saved.ignored && JSON.parse(await IOUtils.readUTF8(cachePath(fixture.owner))).pyramid.text === fixture.editedText);
    }
    check('hot upgrade and new edits preserve the original journal bytes', await IOUtils.readUTF8(await journal.getFilePathAsync()) === originalJSON);
    await lifecycle(() => updated.addon.disable(), ['onDisabled']);
    for (const fixture of fixtures) await IOUtils.move(cachePath(fixture.owner), cachePath(fixture.owner) + '.native-test-backup');
    await lifecycle(() => updated.addon.enable(), ['onEnabling']);
    const active = await waitFor(() => Zotero.ReadingFlow, 're-enabled API');
    for (const fixture of fixtures) {
      const handle = await open(active, fixture.owner, host);
      check('cache-free recovery reads old and new ' + fixture.phase + ' versions without false pending', !handle.config.syncPending && !handle.config.syncConflict && !handle.config.readOnly && handle.getState().pyramid.text === fixture.editedText && handle.note.id === fixture.note.id && fixture.note.getNote() === fixture.originalHTML);
    }
    check('recovery retains one container and creates no technical tags', (await containers(fixtures[0].owner.libraryID)).length === 1 && [container, ...await children(container)].every(item => item.getTags().length === 0));
    result.fixture = { containerKey: container.key, oldFileKey: journal.key, oldFileHash: Zotero.Utilities.Internal.md5(originalJSON),
      owners: fixtures.map(fixture => ({ phase: fixture.phase, libraryID: fixture.owner.libraryID, ownerKey: fixture.owner.key, noteKey: fixture.note.key, originalHTML: fixture.originalHTML, editedText: fixture.editedText })) };
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error); }
  finally {
    result.finishedAt = new Date().toISOString();
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + '.tmp' });
    delete Zotero.__readingFlowSmokePromise; delete Zotero.__readingFlowSmokeSandbox;
    if (safeToQuit) Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
  }
}
