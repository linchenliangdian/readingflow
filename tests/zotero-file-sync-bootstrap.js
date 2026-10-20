/* Native SDK migration checks; all records and sync acknowledgements are synthetic.
 * No authenticated account or formal library is used. */
const expectedProfile = __EXPECTED_PROFILE__, expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__, packagePath = __PACKAGE_PATH__, pdfFixturePath = __PDF_FIXTURE_PATH__;
const contentURI = __CONTENT_URI__, fixtureURI = __FIXTURE_URI__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runSmokeTest() {
  const result = { status: 'running', scenario: 'native-central-file-migration', version: Zotero.version,
    processID: Services.appinfo.processID, checks: [], startedAt: new Date().toISOString() };
  let safeToQuit = false, current = null;
  const check = (name, condition, detail = null) => {
    result.checks.push({ name, passed: !!condition, detail });
    if (!condition) throw new Error('Failed: ' + name + (detail ? ' ' + JSON.stringify(detail) : ''));
  };
  async function checkpoint() { await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + '.tmp' }); }
  async function waitFor(test, label, timeout = 30000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await test(); if (value) return value; await delay(100); }
    throw new Error('Timeout waiting for ' + label);
  }
  async function lifecycle(action, methods) {
    const owner = Zotero.Plugins._addonObserver, wrapped = [], calls = [];
    for (const method of methods) {
      const original = owner[method];
      const wrapper = function (addon, ...args) {
        const returned = original.call(this, addon, ...args);
        if (addon.id === 'reading-flow@local') {
          const call = { done: false, error: null }; calls.push(call);
          Promise.resolve(returned).then(() => { call.done = true; }, error => { call.done = true; call.error = error; });
        }
        return returned;
      };
      owner[method] = wrapper; wrapped.push({ method, original, wrapper });
    }
    try {
      await action(); await waitFor(() => calls.length && calls.every(call => call.done), 'complete native addon lifecycle');
      const failed = calls.find(call => call.error); if (failed) throw failed.error;
    } finally { for (const { method, original, wrapper } of wrapped) if (owner[method] === wrapper) owner[method] = original; }
  }
  async function ready(api, item, host) {
    const handle = await api.openItem(item.id, host);
    await waitFor(() => handle.editor?.getCurrentInstance(), 'native note editor');
    await handle.editor.getCurrentInstance()._initPromise;
    await waitFor(() => handle.toolsWindow?.ReadingFlowApp, 'pyramid tools'); return handle;
  }
  try {
    await Zotero.initializationPromise;
    check('isolated profile and data verified before mutation', PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile) && PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData));
    safeToQuit = true;
    const host = await waitFor(() => Zotero.getMainWindow(), 'main window');
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane.collectionsView?.itemTreeView, 'bound library trees');
    await host.ZoteroPane.itemsView.waitForLoad();
    const scope = new Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal());
    Object.assign(scope, { Zotero, IOUtils, PathUtils, TextEncoder: host.TextEncoder, TextDecoder: host.TextDecoder,
      btoa: host.btoa.bind(host), atob: host.atob.bind(host), crypto: host.crypto });
    for (const name of ['core.js', 'sync.js', 'file-sync.js']) Services.scriptloader.loadSubScript(contentURI + name, scope, 'UTF-8');
    Services.scriptloader.loadSubScript(fixtureURI, scope, 'UTF-8');
    const Core = scope.ReadingFlowCore, Sync = scope.ReadingFlowSync, Files = scope.ReadingFlowFileSync;
    const fixture = await scope.ReadingFlowFileSyncFixtures.create({ Zotero, core: Core, legacy: Sync, BlobClass: host.Blob });
    check('real native fixtures include multipart item and standalone conflicts', fixture.owners.length === 2 && fixture.owners.every(value => value.heads.length === 2 && value.heads[0].parts.length > 1));
    const originalNotes = fixture.owners.map(value => ({ id: value.prose.note.id, key: value.prose.note.key, html: value.prose.note.getNote(), imageKey: value.prose.image.key }));
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(packagePath));
    check('candidate XPI accepted', installation.error === 0);
    await lifecycle(() => installation.install(), ['onInstalled', 'onEnabling']);
    const addon = await AddonManager.getAddonByID('reading-flow@local');
    check('2.2.0 active', addon.isActive && addon.version === '2.2.0');
    const api = await waitFor(() => Zotero.ReadingFlow?.maintenance && Zotero.ReadingFlow, 'file-sync API');
    await api.maintenance(); await checkpoint();
    const store = Files.create({ Zotero, IOUtils, PathUtils });
    const synced = Sync.create({ Zotero, core: Core, fileStore: store });
    const idFor = owner => ({ libraryID: owner.libraryID, key: owner.key, title: owner.getField('title') });
    let data = await store.read(fixture.libraryID);
    check('all four legacy branches are stored in JSON with no missing files', data.records.length === 4 && data.pending.length === 0, data.records.map(value => ({ owner: value.record.ownerKey, source: value.sourceKey })));
    const search = new Zotero.Search(); search.libraryID = fixture.libraryID; search.addCondition('itemType', 'is', 'document'); search.addCondition('tag', 'is', Files.CONTAINER_TAG);
    const containerIDs = await search.search();
    check('one native data item holds stored JSON attachments', containerIDs.length === 1 && Zotero.Items.get(containerIDs[0]).getField('title') === 'Reading flow 数据');
    const attachments = await Zotero.Items.getAsync(Zotero.Items.get(containerIDs[0]).getAttachments());
    check('JSONs use Zotero storage and are not note items', attachments.length > 0 && attachments.every(item => item.isStoredFileAttachment() && !item.isNote() && item.attachmentContentType === 'application/json'));
    check('unuploaded migration keeps every source note', fixture.legacyNotes.every(note => !note.deleted));
    for (const value of fixture.owners) {
      const loaded = await synced.load(idFor(value.owner));
      check(value.kind + ' conflict and formatting survive migration', loaded.conflict && loaded.versions.length === 2 && loaded.versions.every(version => version.state.noteKey === value.prose.note.key && version.state.pyramid.boldRanges.length && version.state.framing.situationBoldRanges.length && version.state.pyramidFontSize >= 24));
    }
    async function acknowledge(hashOverride) {
      // Test-only: emulate SDK upload acknowledgement in this disposable library.
      for (const item of attachments) {
        item.attachmentSyncedHash = hashOverride || await Zotero.Utilities.Internal.md5Async(await item.getFilePathAsync());
        item.attachmentSyncState = Zotero.Sync.Storage.Local.SYNC_STATE_IN_SYNC; item.synced = true;
        await item.saveTx({ skipSyncedUpdate: true, skipDateModifiedUpdate: true });
      }
    }
    await acknowledge('0'.repeat(32)); await api.maintenance();
    check('incorrect synced hash cannot retire sources', fixture.legacyNotes.every(note => !note.deleted));
    await acknowledge(); const migrated = await api.maintenance();
    check('exact acknowledged upload moves covered heads and chunks to trash', fixture.legacyNotes.every(note => note.deleted) && migrated.archived >= fixture.legacyNotes.length, migrated);
    check('incomplete data, orphan parts, and ordinary tagged prose remain', fixture.protectedNotes.every(note => !note.deleted));
    const first = fixture.owners[0]; await host.ZoteroPane.selectItems([first.owner.id], { noWindowRestore: true });
    current = await ready(api, first.owner, host);
    check('native sidebar opens migrated conflict on the original prose note', current.config.syncConflict && current.note.id === first.prose.note.id);
    const selected = current.config.syncVersions.find(value => value.state.pyramid.text.includes('item-B'));
    await current.config.bridge.resolveSyncVersion(selected.id);
    current = await ready(api, first.owner, host);
    check('explicit resolution remains editable and preserves formatting', !current.config.syncConflict && current.getState().pyramid.text.includes('item-B') && current.getState().framing.situationBoldRanges.length > 0);
    const pdf = await Zotero.Attachments.importFromFile({ file: pdfFixturePath, parentItemID: first.owner.id });
    const reader = await Zotero.Reader.open(pdf.id, null, { openInWindow: false }); await reader._initPromise;
    await waitFor(() => host.document.querySelector('notes-context'), 'native notes context');
    const context = host.document.querySelector('notes-context'); context.cachedNotes = []; await context._updateNotesList(true);
    const listed = context.notesList.notes.map(value => value.id);
    check('native all-notes list excludes migrated heads and includes original prose', fixture.legacyNotes.every(note => !listed.includes(note.id)) && originalNotes.every(note => listed.includes(note.id)), listed);
    await lifecycle(() => addon.disable(), ['onDisabled']);
    check('plugin disable drains native writes', !Zotero.ReadingFlow);
    for (const value of fixture.owners) {
      const cache = PathUtils.join(expectedData, 'reading-flow', value.owner.libraryID + '-' + value.owner.key + '.json');
      if (await IOUtils.exists(cache)) await IOUtils.move(cache, cache + '.native-test-backup');
    }
    const coldFiles = Files.create({ Zotero, IOUtils, PathUtils });
    const coldSync = Sync.create({ Zotero, core: Core, fileStore: coldFiles });
    const recovered = await coldSync.load(idFor(first.owner));
    check('fresh writer restores chosen editable data without any owner cache', !recovered.conflict && recovered.state.pyramid.text.includes('item-B') && recovered.state.noteKey === first.prose.note.key);
    const independent = await coldSync.load(idFor(fixture.owners[1].owner));
    check('standalone conflicts also restore from native files alone', independent.conflict && independent.versions.length === 2 && independent.state.noteKey === fixture.owners[1].owner.key);
    const file = attachments[0], path = await file.getFilePathAsync(), backup = path + '.native-test-backup';
    const originalJSON = await IOUtils.readUTF8(path); await IOUtils.move(path, backup);
    try {
      let refused = false; try { await coldSync.load(idFor(first.owner)); } catch (_) { refused = true; }
      check('missing native storage bytes cannot create a blank replacement', refused);
    } finally { await IOUtils.move(backup, path); }
    await IOUtils.writeUTF8(path, 'damaged test JSON', { tmpPath: path + '.tmp' });
    try {
      let refused = false; try { await coldSync.load(idFor(first.owner)); } catch (_) { refused = true; }
      check('corrupt native storage bytes cannot create a blank replacement', refused);
    } finally { await IOUtils.writeUTF8(path, originalJSON, { tmpPath: path + '.tmp' }); }
    const duplicate = new Zotero.Item('document'); duplicate.libraryID = fixture.libraryID;
    duplicate.setField('title', 'Reading flow 数据'); duplicate.setField('extra', Files.CONTAINER_MARKER); duplicate.addTag(Files.CONTAINER_TAG); await duplicate.saveTx();
    const copied = await Zotero.Attachments.importFromFile({ file: path, parentItemID: duplicate.id, title: 'Synthetic offline writer copy', contentType: 'application/json' });
    copied.addTag(Files.FILE_TAG); await copied.saveTx();
    const copyPath = await copied.getFilePathAsync(), copyBytes = await IOUtils.readUTF8(copyPath);
    check('native duplicate consolidation reparents data and retires only the empty container', await coldFiles.consolidate(fixture.libraryID) === 1 && duplicate.deleted && !copied.deleted && copied.parentID === containerIDs[0]);
    check('consolidation keeps native storage path, bytes, and editable state', await copied.getFilePathAsync() === copyPath && await IOUtils.readUTF8(copyPath) === copyBytes && (await coldSync.load(idFor(first.owner))).state.pyramid.text.includes('item-B'));
    await lifecycle(() => addon.enable(), ['onEnabling']);
    await waitFor(() => Zotero.ReadingFlow, 're-enabled API');
    current = await ready(Zotero.ReadingFlow, fixture.owners[1].owner, host);
    check('cache-free native sidebar reopens the exact standalone note and versions', current.note.id === fixture.owners[1].owner.id && current.config.syncConflict && current.config.syncVersions.length === 2);
    check('original prose and embedded image references are unchanged', originalNotes.every(value => Zotero.Items.get(value.id).getNote() === value.html));
    for (const value of fixture.owners) check(value.kind + ' original embedded PNG remains in storage', !!await value.prose.image.getFilePathAsync() && await IOUtils.exists(await value.prose.image.getFilePathAsync()));
    result.fixture = { libraryID: fixture.libraryID, originalNotes, legacyKeys: fixture.legacyNotes.map(note => note.key), protectedKeys: fixture.protectedNotes.map(note => note.key), containerKeys: containerIDs.map(id => Zotero.Items.get(id).key), dataAttachmentKeys: attachments.map(item => item.key) };
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = { message: error.message || String(error), stack: error.stack || null }; Zotero.logError(error); }
  finally {
    result.finishedAt = new Date().toISOString(); await checkpoint();
    delete Zotero.__readingFlowSmokePromise; delete Zotero.__readingFlowSmokeSandbox;
    if (safeToQuit) Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
  }
}
