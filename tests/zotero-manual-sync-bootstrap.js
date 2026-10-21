/* Real native attachment storage and AddonManager lifecycle; only the network
 * transport is stubbed in this verified disposable, account-free profile. */
const expectedProfile = __EXPECTED_PROFILE__, expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__, stages = __PACKAGE_STAGES__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSmokeTest() {
  const result = { status: 'running', scenario: 'manual-sync-hot-upgrade', transport: 'stubbed-native-Runner.sync-account-free', checks: [], startedAt: new Date().toISOString() };
  let safeToQuit = false, originalSync = null, releaseNetwork = null;
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
    const observer = Zotero.Plugins._addonObserver, wrapped = [], calls = [];
    for (const method of methods) {
      const original = observer[method];
      const wrapper = function (addon, ...args) {
        const value = original.call(this, addon, ...args);
        if (addon.id === 'reading-flow@local') {
          const call = { done: false, error: null }; calls.push(call);
          Promise.resolve(value).then(() => { call.done = true; }, error => { call.done = true; call.error = error; });
        }
        return value;
      };
      observer[method] = wrapper; wrapped.push({ method, original, wrapper });
    }
    try {
      await action(); await waitFor(() => calls.length && calls.every(call => call.done), 'native lifecycle');
      const failed = calls.find(call => call.error); if (failed) throw failed.error;
    } finally { for (const { method, original, wrapper } of wrapped) if (observer[method] === wrapper) observer[method] = original; }
  }
  async function install(stage) {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const before = Zotero.ReadingFlow;
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(stage.path));
    check(stage.version + ' package accepted', !installation.error);
    await lifecycle(() => installation.install(), ['onInstalling', 'onInstalled', 'onEnabling']);
    const addon = await AddonManager.getAddonByID('reading-flow@local');
    const api = await waitFor(() => Zotero.ReadingFlow && Zotero.ReadingFlow !== before && Zotero.ReadingFlow, 'updated API');
    check(stage.version + ' active in the same native process', addon.isActive && addon.version === stage.version && Services.appinfo.processID === result.processID);
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
  const cachePath = item => PathUtils.join(expectedData, 'reading-flow', item.libraryID + '-' + item.key + '.json');
  const cache = async item => JSON.parse(await IOUtils.readUTF8(cachePath(item)));
  async function snapshots(libraryID) {
    const search = new Zotero.Search(); search.libraryID = libraryID;
    search.addCondition('itemType', 'is', 'document'); search.addCondition('deleted', 'false');
    search.addCondition('extra', 'contains', 'READING_FLOW_DATA_CONTAINER_V2');
    const containers = await Zotero.Items.getAsync(await search.search()), files = [];
    for (const container of containers) {
      await container.loadDataType('childItems');
      for (const item of await Zotero.Items.getAsync(container.getAttachments())) {
        if (!item.deleted && item.attachmentContentType === 'application/json' && /^file-sync-/.test(item.attachmentFilename)) {
          const text = await IOUtils.readUTF8(await item.getFilePathAsync());
          files.push({ key: item.key, filename: item.attachmentFilename, text, hash: Zotero.Utilities.Internal.md5(text) });
        }
      }
    }
    return { containers, files };
  }
  async function unchanged(previous, libraryID) {
    const current = await snapshots(libraryID);
    return previous.every(old => current.files.some(file => file.key === old.key && file.text === old.text));
  }
  try {
    await Zotero.initializationPromise;
    check('verified disposable profile and data', PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile) && PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData));
    safeToQuit = true; result.processID = Services.appinfo.processID;
    const host = await waitFor(() => Zotero.getMainWindow(), 'main window');
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane.collectionsView?.itemTreeView, 'bound trees');
    await host.ZoteroPane.itemsView.waitForLoad();
    const old = await install(stages[0]), fixtures = [];
    for (let index = 0; index < 2; index++) {
      const owner = new Zotero.Item('journalArticle'); owner.libraryID = Zotero.Libraries.userLibraryID;
      owner.setField('title', 'Synthetic manual sync owner ' + index); await owner.saveTx();
      const handle = await open(old.api, owner, host), state = handle.getState();
      state.pyramid.text = 'Released 2.2.4 reasoning ' + index;
      state.framing.situation = 'Background preserved ' + index;
      state.framing.complication = 'Conflict preserved ' + index;
      state.pyramid.boldRanges = [{ start: 0, end: 8 }]; state.pyramidFontSize = 24;
      await setState(handle, state);
      fixtures.push({ owner, note: handle.note, originalHTML: handle.note.getNote(), originalText: state.pyramid.text });
    }
    const libraryID = fixtures[0].owner.libraryID, original = await snapshots(libraryID);
    check('released runtime created genuine native JSON attachments', original.containers.length === 1 && original.files.length >= 1);
    const updated = await install(stages[1]);
    let handle = await open(updated.api, fixtures[0].owner, host);
    check('upgraded tools default to manual synchronization', updated.api.getSyncMode() === 'manual' && handle.config.syncMode === 'manual' && !handle.config.readOnly && !handle.config.syncConflict);
    check('opening in manual mode does not create or change a data attachment', (await snapshots(libraryID)).files.length === original.files.length && await unchanged(original.files, libraryID));
    const queued = [];
    for (let index = 0; index < 20; index++) {
      const state = handle.getState(); state.pyramid.text = 'Fast local input ' + index;
      await handle.toolsWindow.ReadingFlowApp.loadConfig({ ...handle.config, initialState: state });
      queued.push(handle.config.bridge.flushState(state));
    }
    await Promise.all(queued);
    fixtures[0].firstText = 'Fast local input 19';
    check('twenty rapid flushes persist the latest local draft without adding or modifying native JSON', (await cache(fixtures[0].owner)).pyramid.text === fixtures[0].firstText && (await cache(fixtures[0].owner)).readingFlowSync.pending === true && (await snapshots(libraryID)).files.length === original.files.length && await unchanged(original.files, libraryID));
    handle = await open(updated.api, fixtures[1].owner, host);
    const secondState = handle.getState(); secondState.pyramid.text = 'Second owner local input';
    fixtures[1].finalText = secondState.pyramid.text; await setState(handle, secondState);
    handle = await open(updated.api, fixtures[0].owner, host);
    check('switching between owners preserves drafts without publishing', handle.getState().pyramid.text === fixtures[0].firstText && (await snapshots(libraryID)).files.length === original.files.length);
    let syncCalls = 0, holdNetwork = true;
    originalSync = Zotero.Sync.Runner.sync;
    Zotero.Sync.Runner.sync = async () => {
      syncCalls++;
      if (holdNetwork) return new Promise(resolve => { releaseNetwork = resolve; });
      return true;
    };
    const firstSync = handle.config.bridge.syncNow(handle.getState());
    await waitFor(() => syncCalls === 1 && releaseNetwork, 'first explicit sync reaches stubbed transport');
    const firstPublished = await snapshots(libraryID);
    check('one explicit sync publishes both current owners using new immutable native attachments', firstPublished.files.length === original.files.length + 2 && await unchanged(original.files, libraryID) && fixtures.every(fixture => firstPublished.files.some(file => JSON.parse(file.text).records.some(record => record.ownerKey === fixture.owner.key && record.state.pyramid.text === (fixture.firstText || fixture.finalText)))));
    const during = handle.getState(); during.pyramid.text = 'Typed while the network sync was in flight';
    fixtures[0].finalText = during.pyramid.text; await setState(handle, during);
    check('typing during transport stays local and keeps a durable pending draft', (await cache(fixtures[0].owner)).pyramid.text === during.pyramid.text && (await cache(fixtures[0].owner)).readingFlowSync.pending === true && (await snapshots(libraryID)).files.length === firstPublished.files.length && await unchanged(firstPublished.files, libraryID));
    holdNetwork = false; releaseNetwork(true); releaseNetwork = null; await firstSync;
    check('sync completion does not overwrite newer local typing or publish it silently', (await cache(fixtures[0].owner)).pyramid.text === fixtures[0].finalText && (await cache(fixtures[0].owner)).readingFlowSync.pending === true && (await snapshots(libraryID)).files.length === firstPublished.files.length);
    updated.api.setSyncMode('interval');
    check('thirty-minute mode is explicitly selectable and stored', updated.api.getSyncMode() === 'interval' && Zotero.Prefs.get('readingFlow.syncMode') === 'interval');
    updated.api.setSyncMode('manual');
    await lifecycle(() => updated.addon.disable(), ['onDisabled']);
    await lifecycle(() => updated.addon.enable(), ['onEnabling']);
    const active = await waitFor(() => Zotero.ReadingFlow, 're-enabled API');
    handle = await open(active, fixtures[0].owner, host);
    check('manual setting and unsynchronized draft survive plugin restart', active.getSyncMode() === 'manual' && handle.getState().pyramid.text === fixtures[0].finalText && (await cache(fixtures[0].owner)).readingFlowSync.pending === true && (await snapshots(libraryID)).files.length === firstPublished.files.length);
    await handle.config.bridge.syncNow(handle.getState());
    const final = await snapshots(libraryID);
    check('a second explicit sync publishes only the newer complete draft', syncCalls === 2 && final.files.length === firstPublished.files.length + 1 && await unchanged(firstPublished.files, libraryID) && (await cache(fixtures[0].owner)).readingFlowSync.pending === false && final.files.some(file => JSON.parse(file.text).records.some(record => record.ownerKey === fixtures[0].owner.key && record.state.pyramid.text === fixtures[0].finalText)));
    check('all native prose and formatting remain intact', fixtures.every(fixture => fixture.note.getNote() === fixture.originalHTML) && handle.getState().pyramidFontSize === 24 && handle.getState().pyramid.boldRanges[0].end === 8);
    result.fixture = { containerKey: final.containers[0].key, oldFiles: original.files.map(({ key, filename, hash }) => ({ key, filename, hash })), attachmentCount: final.files.length,
      owners: fixtures.map(fixture => ({ libraryID: fixture.owner.libraryID, ownerKey: fixture.owner.key, noteKey: fixture.note.key, originalHTML: fixture.originalHTML, finalText: fixture.finalText })) };
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error); }
  finally {
    if (releaseNetwork) releaseNetwork(true);
    if (originalSync) Zotero.Sync.Runner.sync = originalSync;
    result.finishedAt = new Date().toISOString();
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + '.tmp' });
    delete Zotero.__readingFlowSmokePromise; delete Zotero.__readingFlowSmokeSandbox;
    if (safeToQuit) Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
  }
}
