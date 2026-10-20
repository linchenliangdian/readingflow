/* Boundary checks for durable drafts, native child/standalone notes, sidebar lifecycles, and item switches. */
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'content', name), 'utf8');

function harness({ scanDrafts = false, coldTools = false } = {}) {
  const transportRecords = new Map(), transportWrites = [];
  let currentFileStore = null;
  const files = new Map(), prefs = new Map(), items = new Map(), notes = [], menus = new Map(), writes = [], pickerResponses = [], pickerRequests = [], errors = [], shutdownListeners = [], debugMessages = [], dbCalls = [], resizeObservers = [], observers = new Map(), noteWrites = [], imagePosts = [];
  const libraries = new Map([[1, { editable: true }]]), inFlight = new Map(), maximumInFlight = new Map(), blockedReads = new Map();
  let nextID = 1000, nextObserverID = 1, failNextWrite = false, failWritePath = null, section = null, sectionID = null, context, librarySelection = null;
  class Node {
    constructor(name, doc) {
      this.localName = name; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.style = { cssText: '' }; this.hidden = false; this.closed = false;
      const classes = new Set(); this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : !!force; if (enabled) classes.add(name); else classes.delete(name); return enabled; } };
    }
    set id(value) { this._id = value; this.ownerDocument.ids.set(value, this); } get id() { return this._id; }
    get isConnected() { return !!(this.parentElement || this.root); }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'src' && this.localName === 'iframe') this.src = String(value); } removeAttribute(key) { this.attributes.delete(key); } getAttribute(key) { return this.attributes.get(key) || null; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    querySelectorAll() { return this.buttons || []; }
    querySelector(selector) { return selector === '#links-container' ? this.footer || null : null; }
    closest(name) { let node = this; while (node) { if (node.localName === name || name === '.btn[data-pane]' && node.dataset.pane) return node; node = node.parentElement; } return null; }
    click() {
      const event = { target: this, button: 0, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      for (const handler of this.ownerDocument.listeners.get('click') || []) { handler(event); if (event.stopped) break; }
      return event;
    }
    getBoundingClientRect() {
      const naturalHeight = this.layoutHeight === undefined ? 800 : this.layoutHeight, maxHeight = parseFloat(this.style.maxHeight);
      const height = Number.isFinite(maxHeight) ? Math.min(naturalHeight, maxHeight) : naturalHeight, top = this.layoutTop || 0;
      return { height, width: 400, top, bottom: top + height };
    }
  }
  const document = {
    ids: new Map(), listeners: new Map(), defaultView: null,
    getElementById(id) { return this.ids.get(id) || null; },
    createElementNS(_, name) {
      const node = new Node(name, this);
      if (name === 'iframe') {
        const tools = { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } };
        const app = { state: null, notice: '', dirty: false, async loadConfig(config) { this.state = JSON.parse(JSON.stringify(config.initialState)); this.dirty = false; }, getState() { return this.state; }, hasPendingChanges() { return this.dirty; }, async flushPendingSave() {}, showNotice(message) { this.notice = message; } };
        if (!coldTools) tools.ReadingFlowApp = app;
        tools.dispatchEvent = event => { if (event.type === 'reading-flow-config') tools.ReadingFlowApp.loadConfig(event.detail); };
        node.contentWindow = tools;
        Object.defineProperty(node, 'src', { set(value) { node.url = value; queueMicrotask(() => { tools.ReadingFlowApp = app; for (const handler of Array.from(node.listeners.get('load') || [])) handler(); }); }, get: () => node.url });
      }
      return node;
    },
    createXULElement(name) {
      const node = new Node(name, this);
      if (name === 'note-editor') {
        node.footer = new Node('div', this); node.append(node.footer);
        node.getCurrentInstance = () => {
          if (!node.item) return null;
          if (!node._editorInstance || node._editorInstance.item !== node.item) node._editorInstance = {
            item: node.item, _initPromise: Promise.resolve(), _iframeWindow: { getDataSync: () => ({ html: node._editorInstance?.pendingHTML ?? node.item.html }) },
            async _save(data) { if (!this._disableSaving) { node.item.html = data.html; this.pendingHTML = null; } },
            _postMessage(message) {
              assert.doesNotMatch(message.html, /src=["']data:/, 'the native editor must never receive a transient data URL image');
              const key = message.html.match(/data-attachment-key="([A-Z0-9]{8})"/)?.[1];
              const imported = [...items.values()].find(item => item.key === key && item.isEmbeddedImageAttachment?.());
              assert.ok(imported && files.has(imported.filePath), 'the embedded image must exist before its key is inserted');
              imagePosts.push(message); this.pendingHTML = (this.pendingHTML ?? node.item.html) + message.html;
            },
            async _importImage(src) {
              const image = { id: nextID++, libraryID: node.item.libraryID, parentID: node.item.id, key: 'IMG' + String(nextID).padStart(5, '0'), isEmbeddedImageAttachment: () => true, isAttachment: () => true, isRegularItem: () => false, isNote: () => false, imageData: src };
              image.filePath = 'D:/fake-zotero-data/storage/' + image.key + '/pyramid.png'; image.getFilePathAsync = async () => image.filePath; files.set(image.filePath, src);
              items.set(image.id, image); return image.key;
            },
            async uninit() { node.uninitCount = (node.uninitCount || 0) + 1; if (node.uninitBarrier) await node.uninitBarrier; }
          };
          return node._editorInstance;
        };
        node.saveSync = () => { node.saveCount = (node.saveCount || 0) + 1; };
      }
      return node;
    },
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); },
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); },
    querySelectorAll() { return [...libraryNav.buttons, ...readerNav.buttons]; }
  };
  const nativeNode = (id, name = 'deck') => { const node = new Node(name, document); node.id = id; node.root = true; return node; };
  const libraryDeck = nativeNode('zotero-item-pane-content'), readerDeck = nativeNode('zotero-context-pane-deck');
  const libraryNav = nativeNode('zotero-view-item-sidenav', 'item-pane-sidenav'), readerNav = nativeNode('zotero-context-pane-sidenav', 'item-pane-sidenav');
  const libraryPane = nativeNode('zotero-item-pane', 'item-pane'), readerContext = nativeNode('zotero-context-pane-inner', 'context-pane');
  const originalActiveEditor = { native: true };
  Object.defineProperty(readerContext, 'activeEditor', { configurable: true, get: () => originalActiveEditor });
  for (const deck of [libraryDeck, readerDeck]) { const original = new Node('native-panel', document); deck.append(original); deck.selectedPanel = original; }
  libraryNav.buttons = []; readerNav.buttons = []; libraryNav.container = { item: null }; readerNav.container = { item: null };
  const nativeNoteRenderResult = Promise.resolve({ native: 'note-render-result' });
  libraryPane.renderNoteEditor = function () { this.nativeNoteRenders = (this.nativeNoteRenders || 0) + 1; this.setAttribute('mode', 'note'); libraryDeck.selectedPanel = libraryDeck.children[0]; libraryNav.hidden = true; return nativeNoteRenderResult; };
  libraryNav.renderDefaultStatus = function () { this.nativeDefaultRenders = (this.nativeDefaultRenders || 0) + 1; for (const button of this.buttons) button.setAttribute('disabled', 'true'); };
  function updateSection(item, tabType) {
    if (!section) return;
    const body = new Node('div', document), parent = new Node('item-pane-custom-section', document); parent.append(body);
    section.onInit({ doc: document, body });
    section.onItemChange({ doc: document, body, item, tabType, setEnabled: enabled => { parent.hidden = !enabled; } });
    section.onRender({ doc: document, body, item, tabType });
  }
  const windowListeners = new Map();
  const host = {
    document, closed: false, CustomEvent: class {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; resizeObservers.push(this); }
      observe(node) { this.targets.add(node); } disconnect() { this.disconnected = true; this.targets.clear(); }
    },
    addEventListener(type, handler) { windowListeners.set(type, handler); }, removeEventListener(type) { windowListeners.delete(type); },
    Zotero_Tabs: { selectedType: 'library', selectedID: 'zotero-pane', select(id) { this.selectedID = id; this.selectedType = id === 'zotero-pane' ? 'library' : 'reader'; } },
    ZoteroPane: { getSelectedItems: () => librarySelection ? [librarySelection] : [], async selectItem(id) { librarySelection = libraryNav.container.item = items.get(id); updateSection(items.get(id), 'library'); } },
    openDialog() { throw new Error('A sidebar must never create a popup'); }
  };
  host.ZoteroContextPane = { get activeEditor() { return readerContext.activeEditor; }, updateAddToNote() {} };
  document.defaultView = host;
  const regular = (id, key, title) => {
    const value = { id, libraryID: 1, key, deleted: false, title, isRegularItem: () => true, isNote: () => false, getField: field => field === 'title' ? value.title : '', getNotes: () => notes.filter(note => note.parentID === id && !note.deleted).map(note => note.id) };
    value.topLevelItem = value; items.set(id, value); return value;
  };
  const parent = regular(10, 'PAPER001', 'A reading workflow'), other = regular(11, 'PAPER002', 'Another paper');
  librarySelection = libraryNav.container.item = parent;
  const attachment = { id: 20, libraryID: 1, key: 'ATTACH01', topLevelItem: parent, deleted: false, isRegularItem: () => false }; items.set(20, attachment);
  const orphan = { id: 30, libraryID: 1, key: 'ORPHAN01', deleted: false, isRegularItem: () => false }; orphan.topLevelItem = orphan; items.set(30, orphan);
  class Note {
    constructor(type) { assert.equal(type, 'note'); this.tags = []; this.deleted = false; }
    setNote(html) { this.html = html; } getNote() { return this.html; } addTag(tag) { if (!this.tags.includes(tag)) this.tags.push(tag); } hasTag(tag) { return this.tags.includes(tag); } isNote() { return true; } isRegularItem() { return false; }
    getTags() { return this.tags.map(tag => ({ tag, type: 0 })); }
    get parentKey() { return this.parentID ? items.get(this.parentID)?.key || false : false; }
    set parentKey(key) { this.parentID = key ? [...items.values()].find(item => item.libraryID === this.libraryID && item.key === key)?.id : null; }
    get topLevelItem() { return this.parentID ? items.get(this.parentID) || this : this; }
    getField(field) { return field === 'title' ? this.title || String(this.html || '').replace(/<[^>]*>/g, '').slice(0, 120) : ''; }
    async save() { if (!this.id) { this.id = nextID++; this.key = this.key || String(this.id).padStart(8, '0'); items.set(this.id, this); notes.push(this); } noteWrites.push({ id: this.id, key: this.key, html: this.html }); return this.id; }
    async saveTx() { return Zotero.DB.executeTransaction(() => this.save()); }
    async eraseTx() { items.delete(this.id); const index = notes.indexOf(this); if (index >= 0) notes.splice(index, 1); }
  }
  class Search {
    constructor() { this.conditions = []; }
    addCondition(condition, operator, value) { this.conditions.push({ condition, operator, value }); }
    async search() {
      const compare = (actual, operator, expected) => operator === 'contains' ? String(actual).includes(String(expected)) : operator === 'isNot' ? String(actual) !== String(expected) : String(actual) === String(expected);
      return [...items.values()].filter(item => {
        const includeDeleted = this.conditions.some(({ condition, value }) => condition === 'deleted' && String(value) === 'true');
        if (!includeDeleted && item.deleted) return false;
        if (this.libraryID !== undefined && item.libraryID !== this.libraryID) return false;
        return this.conditions.every(({ condition, operator, value }) => {
          if (condition === 'tag') return (item.tags || []).some(tag => compare(tag, operator, value));
          if (condition === 'libraryID') return compare(item.libraryID, operator, value);
          if (condition === 'itemType') return compare(item.isNote?.() ? 'note' : item.isRegularItem?.() ? 'regular' : 'attachment', operator, value);
          if (condition === 'key') return compare(item.key, operator, value);
          if (condition === 'parentItemID') return compare(item.parentID || '', operator, value);
          if (condition === 'deleted') return operator === 'true' || operator === 'false' ? !!item.deleted === (operator === 'true') : compare(!!item.deleted, operator, value);
          if (condition === 'note') return compare(item.getNote?.() || '', operator, value);
          throw new Error('Unsupported mock search condition: ' + condition);
        });
      }).map(item => item.id);
    }
  }
  class FilePicker {
    constructor() { this.modeOpen = 0; this.modeSave = 1; this.returnOK = 0; this.returnCancel = 1; this.returnReplace = 2; }
    init(window, title, mode) { this.parentWindow = window; this.mode = mode; } appendFilter(label, pattern) { this.filter = { label, pattern }; }
    async show() { pickerRequests.push(this); const response = pickerResponses.shift() || { result: 1 }; this.file = response.file; return response.result; }
  }
  const Zotero = {
    DataDirectory: { dir: 'D:/fake-zotero-data' }, Utilities: { randomString: size => 'r'.repeat(size) }, Item: Note, Search,
    Prefs: { get: name => prefs.get(name), set: (name, value) => prefs.set(name, value), clear: name => prefs.delete(name) },
    Items: { get: id => Array.isArray(id) ? id.map(value => items.get(value)).filter(Boolean) : items.get(id), getAsync: async id => Array.isArray(id) ? id.map(value => items.get(value)).filter(Boolean) : items.get(id) || null, getAll: async (libraryID, onlyTopLevel = false, includeDeleted = false) => [...items.values()].filter(item => item.libraryID === libraryID && (!onlyTopLevel || !item.parentID) && (includeDeleted || !item.deleted)), getByLibraryAndKeyAsync: async (libraryID, key) => [...items.values()].find(item => item.libraryID === libraryID && item.key === key) || null },
    Libraries: { get: id => libraries.get(id), getAll: () => [...libraries].map(([libraryID, value]) => ({ ...value, libraryID })) }, getMainWindow: () => host, getMainWindows: () => [host], logError: error => errors.push(error),
    addShutdownListener: listener => shutdownListeners.push(listener), debug: message => debugMessages.push(message), DB: { async waitForTransaction() { dbCalls.push('wait'); }, async executeTransaction(callback) { dbCalls.push('transaction'); return callback(); }, async valueQueryAsync(sql, params) { dbCalls.push('query'); assert.match(sql, /SELECT note FROM itemNotes WHERE itemID\s*=\s*\?/i); return items.get(params[0])?.html ?? null; } },
    MenuManager: { registerMenu(descriptor) { const id = 'registered:' + descriptor.pluginID + ':' + descriptor.menuID; menus.set(id, descriptor); return id; }, unregisterMenu(id) { assert.ok(menus.has(id)); menus.delete(id); } },
    ItemPaneManager: { registerSection(descriptor) {
      section = descriptor; sectionID = 'reading-flow@test:' + descriptor.paneID;
      for (const nav of [libraryNav, readerNav]) { const button = new Node('div', document); button.dataset.pane = sectionID; nav.append(button); nav.buttons.push(button); }
      return sectionID;
    }, unregisterSection(id) { assert.equal(id, sectionID); section = null; for (const nav of [libraryNav, readerNav]) { for (const button of nav.buttons) if (button.dataset.pane === id) button.remove(); nav.buttons = nav.buttons.filter(button => button.dataset.pane !== id); } } },
    Reader: { _readers: [], _registeredListeners: [{ handler: () => {}, type: 'renderToolbar', pluginID: 'other-plugin' }], registerEventListener(type, handler, pluginID) { this._registeredListeners.push({ type, handler, pluginID }); }, getByTabID() { return null; } },
    Notifier: {
      registerObserver(observer, types, name) { const id = nextObserverID++; observers.set(id, { observer, types, name }); return id; }, unregisterObserver(id) { observers.delete(id); },
      async trigger(action, type, ids = [], extraData = {}) { await Promise.all([...observers.values()].filter(({ types }) => types.includes(type)).map(({ observer }) => observer.notify(action, type, ids, extraData))); }
    }
  };
  const IOUtils = {
    makeDirectory: async () => {}, exists: async name => files.has(name) || scanDrafts && [...files.keys()].some(path => path.startsWith(name + '/')), stat: async name => ({ size: Buffer.byteLength(files.get(name) || '', 'utf8') }),
    async readUTF8(name) { const barrier = blockedReads.get(name); if (barrier) await barrier; if (!files.has(name)) throw new Error('ENOENT'); return files.get(name); },
    async read(name) { if (!files.has(name)) throw new Error('ENOENT'); return new Uint8Array(Buffer.from(files.get(name), 'utf8')); },
    async write(name, content, options) { assert.ok(ArrayBuffer.isView(content), 'note relink backups use raw bytes'); return this.writeUTF8(name, Buffer.from(content).toString('utf8'), options); },
    async writeUTF8(name, content, options) {
      const count = (inFlight.get(name) || 0) + 1; inFlight.set(name, count); maximumInFlight.set(name, Math.max(count, maximumInFlight.get(name) || 0));
      const fail = failNextWrite || name === failWritePath; failNextWrite = false; if (name === failWritePath) failWritePath = null; writes.push({ path: name, content, options });
      try { await new Promise(resolve => setTimeout(resolve, 3)); if (fail) throw new Error('Simulated atomic-write failure'); assert.ok(options.tmpPath && options.tmpPath !== name); files.set(name, content); }
      finally { inFlight.set(name, count - 1); }
    }
  };
  if (scanDrafts) IOUtils.getChildren = async name => [...files.keys()].filter(path => path.startsWith(name + '/') && !path.slice(name.length + 1).includes('/'));
  context = vm.createContext({ Zotero, IOUtils, TextEncoder, TextDecoder, btoa, atob, crypto: webcrypto, PathUtils: { join: (...pieces) => path.posix.join(...pieces) }, Services: { prompt: { alert() {} } }, ChromeUtils: { importESModule: () => ({ FilePicker }) } });
  vm.runInContext(read('core.js'), context);
  if (fs.existsSync(path.join(__dirname, '..', 'content', 'sync.js'))) vm.runInContext(read('sync.js'), context);
  // This suite tests sidebar orchestration with an explicit in-memory transport.
  // Real stored JSON attachments and SDK behavior are covered by file-sync tests.
  context.ReadingFlowFileSync = { create() {
    const writerID = 'writer-' + webcrypto.randomUUID();
    prefs.set(context.ReadingFlowSync.DEVICE_PREF, writerID);
    currentFileStore = {
      writerID, isManagedItem: item => !!item?.managedData,
      async read(libraryID) {
        const records = [...transportRecords.values()].filter(value => value.libraryID === libraryID).map(value => ({ record: JSON.parse(JSON.stringify(value.record)), sourceKey: value.sourceKey }));
        return { records, pending: [], fingerprint: context.ReadingFlowSync.checksum(JSON.stringify(records)) };
      },
      async write(libraryID, records) {
        for (const record of records) {
          const sourceKey = writerID + ':' + record.ownerKey + ':' + record.revision;
          transportRecords.set(libraryID + ':' + record.ownerKey + ':' + record.revision, { libraryID, sourceKey, record: JSON.parse(JSON.stringify(record)) });
        }
        transportWrites.push(JSON.parse(JSON.stringify(records)));
        return { sourceKey: writerID, fingerprint: (await this.read(libraryID)).fingerprint };
      },
      async uploaded() { return false; },
      async requestDownloads() { return []; }
    };
    return currentFileStore;
  } };
  vm.runInContext(read('integration.js'), context);
  const identity = item => ({ libraryID: item.libraryID, key: item.key, title: item.getField('title') });
  const draftName = item => 'D:/fake-zotero-data/reading-flow/' + item.libraryID + '-' + item.key + '.json';
  return { files, prefs, items, notes, transportRecords, transportWrites, get fileStore() { return currentFileStore; }, proseNotes: () => notes.filter(note => !context.ReadingFlowSync?.decodeNote(note.html)), menus, writes, pickerResponses, pickerRequests, libraries, maximumInFlight, errors, Zotero, host, parent, other, attachment, identity, draftName, originalActiveEditor, shutdownListeners, debugMessages, dbCalls, resizeObservers, observers, noteWrites, imagePosts, libraryPane, libraryNav, readerContext, nativeNoteRenderResult, core: context.ReadingFlowCore, sync: context.ReadingFlowSync, getSection: () => section,
    start: (version = '1.0.0') => context.ReadingFlowIntegration.start({ id: 'reading-flow@test', version }), stop: () => context.ReadingFlowIntegration.stop(),
    failWrite: () => { failNextWrite = true; }, failDraftWrite: (item = parent) => { failWritePath = draftName(item); }, durable: (item = parent) => JSON.parse(files.get(draftName(item))),
    restoreNote(saved) { const note = new Note('note'); Object.assign(note, { id: saved.id, key: saved.key, libraryID: saved.libraryID, parentID: saved.parentID, html: saved.html, tags: [...saved.tags], deleted: saved.deleted }); items.set(note.id, note); notes.push(note); nextID = Math.max(nextID, note.id + 1); return note; },
    async clickRail(kind = 'library') {
      const handle = Zotero.ReadingFlow.inspect(host).find(panel => panel.kind === kind), event = handle.button.click(); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
      if (handle.opening) await handle.opening.promise;
      for (let i = 0; i < 100 && !handle.config && !errors.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
      if (errors.length) throw errors.at(-1); assert.ok(handle.config, 'rail click must finish native editor configuration'); return handle;
    },
    blockRead(item) { let resolve; const promise = new Promise(done => { resolve = done; }); blockedReads.set(draftName(item), promise); return () => { blockedReads.delete(draftName(item)); resolve(); }; },
    activateReader(item = parent) { host.Zotero_Tabs.select('reader-test'); readerNav.container.item = item; updateSection(item, 'reader'); },
    selectNativeNote(note) { librarySelection = note; libraryNav.renderDefaultStatus(); return libraryPane.renderNoteEditor(note); },
    clearSelection() { librarySelection = libraryNav.container.item = null; updateSection(null, 'library'); }, unloadHost() { windowListeners.get('unload')?.(); },
    resizePanel(handle, height) { handle.panel.layoutHeight = height; for (const observer of resizeObservers) if (observer.targets.has(handle.panel)) observer.callback([{ target: handle.panel }]); },
    resizeWindow() { windowListeners.get('resize')?.(); }, emitItemChange(ids, action = 'modify') { return Zotero.Notifier.trigger(action, 'item', ids); }
  };
}

function coldHarness(first) {
  const cold = harness(); for (const [name, content] of first.files) cold.files.set(name, content);
  for (const [name, value] of first.prefs) cold.prefs.set(name, value);
  for (const note of first.notes) cold.restoreNote(note);
  for (const [key, value] of first.transportRecords) cold.transportRecords.set(key, JSON.parse(JSON.stringify(value)));
  return cold;
}

function transferNotes(source, target, filter = () => true) {
  const changed = [];
  for (const saved of source.notes.filter(filter)) {
    let note = [...target.items.values()].find(item => item.libraryID === saved.libraryID && item.key === saved.key);
    if (!note) note = target.restoreNote(saved);
    else Object.assign(note, { html: saved.html, tags: [...saved.tags], parentID: saved.parentID, deleted: saved.deleted });
    changed.push(note.id);
  }
  for (const [key, value] of source.transportRecords) {
    const record = value.record;
    const probe = { key: record.revision, html: source.sync.encodeNote({ ...record, data: source.sync.encodePayload(record.state) }) };
    probe.getNote = () => probe.html;
    if (filter(probe)) {
      target.transportRecords.set(key, JSON.parse(JSON.stringify(value)));
      changed.push(target.parent.id);
    }
  }
  return changed;
}

async function waitUntil(predicate, message) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message || 'Timed out waiting for the sync notification');
}

async function standaloneNote(h, text = 'An independent note') {
  const note = new h.Zotero.Item('note'); note.libraryID = 1; note.setNote('<p>' + text + '</p>'); await note.saveTx(); return note;
}

test('sidebars with the same generation request different tool documents across plugin versions', async t => {
  const requests = [];
  for (const version of ['2.1.7', '2.1.8+test&fragment#']) {
    const h = harness({ coldTools: true }); await h.start(version); t.after(() => h.stop());
    const handle = await h.clickRail(), source = handle.frame.getAttribute('src');
    assert.ok(source.startsWith('chrome://reading-flow/content/app.xhtml?v=' + encodeURIComponent(version) + '&sidebar='));
    const parsed = new URL(source);
    assert.equal(parsed.searchParams.get('v'), version);
    assert.equal(parsed.searchParams.get('sidebar'), String(handle.generation));
    assert.deepEqual([...parsed.searchParams.keys()], ['v', 'sidebar']);
    requests.push({ source, generation: handle.generation });
  }
  assert.equal(requests[0].generation, requests[1].generation);
  assert.notEqual(requests[0].source, requests[1].source);
});

test('standalone note rail and context menu bind the exact existing note without rewriting prose or adding tags', async t => {
  const h = harness(), note = await standaloneNote(h, 'My own unstructured note'); note.addTag('Personal');
  let proseWrites = 0; const setNote = note.setNote.bind(note); note.setNote = html => { proseWrites++; setNote(html); };
  await h.start(); t.after(() => h.stop());
  let enabled; h.getSection().onItemChange({ doc: h.host.document, item: note, tabType: 'library', setEnabled: value => { enabled = value; } }); assert.equal(enabled, true);
  const menu = [...h.menus.values()].find(descriptor => descriptor.target === 'main/library/item').menus[0];
  const context = { items: [note], menuElem: {}, setEnabled: value => { enabled = value; } }, event = { target: { ownerDocument: h.host.document } };
  menu.onShowing(event, context); assert.equal(enabled, true);
  menu.onShowing(event, { ...context, items: [note, h.parent], setEnabled: value => { enabled = value; } }); assert.equal(enabled, false);
  menu.onCommand(event, context);
  for (let i = 0; i < 100 && h.host.ZoteroPane.getSelectedItems()[0] !== note && !h.errors.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.host.ZoteroPane.getSelectedItems()[0], note); const handle = await h.clickRail();
  assert.equal(handle.note, note); assert.equal(handle.editor.item, note); assert.equal(handle.parentID, null); assert.equal(handle.item.key, note.key);
  assert.equal(handle.getState().item.key, note.key); assert.equal(handle.getState().noteKey, note.key); assert.equal(h.durable(note).noteKey, note.key);
  assert.equal(handle.deck.selectedPanel, handle.panel); assert.equal(handle.editor.mode, 'edit'); assert.equal(handle.editor.hidden, false);
  assert.equal(note.html, '<p>My own unstructured note</p>'); assert.deepEqual(note.tags, ['Personal']); assert.equal(proseWrites, 0); assert.equal(h.proseNotes().length, 1);
  assert.equal(h.files.has(h.draftName(h.parent)), false);
  note.deleted = true; menu.onShowing(event, context); assert.equal(enabled, false);
  await assert.rejects(() => h.Zotero.ReadingFlow.openItem(note.id), /文献|笔记/); assert.equal(h.proseNotes().length, 1); assert.equal(proseWrites, 0);
});

test('standalone notes keep separate pyramid, formatting, framing, and timer drafts through switches and cold reopening', async t => {
  const first = harness(), a = await standaloneNote(first, 'Independent A'), b = await standaloneNote(first, 'Independent B'); await first.start();
  const openedA = await first.Zotero.ReadingFlow.openItem(a.id), stateA = openedA.getState();
  stateA.pyramid.text = 'A conclusion'; stateA.pyramid.boldRanges = [{ start: 0, end: 1 }]; stateA.framing.situation = 'A background'; stateA.framing.complication = 'A conflict';
  first.core.startTimer(stateA, 'analysis', 1000); first.core.pauseTimer(stateA, 5000); await openedA.config.bridge.flushState(stateA);
  const bridgeA = openedA.config.bridge, openedB = await first.Zotero.ReadingFlow.openItem(b.id), stateB = openedB.getState(); stateB.pyramid.text = 'B conclusion'; await openedB.config.bridge.flushState(stateB);
  assert.equal(openedB.note, b); assert.equal(first.durable(a).pyramid.text, 'A conclusion'); assert.equal(first.durable(b).pyramid.text, 'B conclusion');
  stateA.pyramid.text = 'A stale frame'; assert.equal((await bridgeA.saveState(stateA)).ignored, true);
  await assert.rejects(() => bridgeA.exportNote(stateA), /切换/); assert.throws(() => bridgeA.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /切换/);
  assert.equal(first.durable(a).pyramid.text, 'A conclusion'); assert.equal(a.html, '<p>Independent A</p>'); assert.equal(b.html, '<p>Independent B</p>'); await first.stop();
  const cold = coldHarness(first); await cold.start(); t.after(() => cold.stop()); await cold.host.ZoteroPane.selectItem(a.id); const reopened = await cold.clickRail();
  assert.equal(reopened.note, cold.items.get(a.id)); assert.equal(reopened.editor.item.key, a.key); assert.equal(cold.proseNotes().length, 2); assert.equal(cold.writes.length, 0);
  const restored = JSON.parse(JSON.stringify(reopened.getState())); assert.equal(restored.pyramid.text, 'A conclusion'); assert.deepEqual(restored.pyramid.boldRanges, [{ start: 0, end: 1 }]);
  assert.equal(restored.framing.situation, 'A background'); assert.equal(restored.framing.complication, 'A conflict'); assert.deepEqual(restored.timers, first.durable(a).timers);
  assert.equal(restored.noteKey, a.key); assert.equal(restored.item.key, a.key);
});

test('standalone pyramid insertion targets its own native note while selected child notes retain the parent workflow', async t => {
  const h = harness(), independent = await standaloneNote(h), child = await standaloneNote(h, 'A child note I wrote'); child.parentID = h.parent.id;
  await h.start(); t.after(() => h.stop()); const standalone = await h.Zotero.ReadingFlow.openItem(independent.id);
  await standalone.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }); assert.match(independent.html, /<img data-attachment-key="[A-Z0-9]{8}"/);
  assert.equal(child.html, '<p>A child note I wrote</p>'); const managed = await h.Zotero.ReadingFlow.openItem(child.id);
  assert.equal(managed.item.key, h.parent.key); assert.equal(managed.parentID, h.parent.id); assert.notEqual(managed.note, child); assert.notEqual(managed.note, independent);
  assert.equal(managed.note.parentID, h.parent.id); assert.ok(managed.note.hasTag('Reading Flow · sidebar')); assert.equal(h.proseNotes().length, 3);
  assert.equal(child.html, '<p>A child note I wrote</p>'); assert.deepEqual(child.tags, []); assert.equal(h.files.has(h.draftName(child)), false); assert.equal(h.durable(independent).noteKey, independent.key);
});

test('read-only standalone notes remain visible in their native editor and retain local timer drafts', async t => {
  const h = harness(), note = await standaloneNote(h, 'Read-only independent prose'); h.libraries.get(1).editable = false; await h.start(); t.after(() => h.stop());
  const handle = await h.Zotero.ReadingFlow.openItem(note.id); assert.equal(handle.readOnly, true); assert.equal(handle.config.bridge.canEdit, false);
  assert.equal(handle.editor.item, note); assert.equal(handle.editor.hidden, false); assert.equal(handle.editor.mode, 'view'); assert.equal(h.proseNotes().length, 1);
  const state = handle.getState(); h.core.startTimer(state, 'inspection', 1000); h.core.pauseTimer(state, 2000); await handle.config.bridge.saveDraft(state);
  assert.deepEqual(h.durable(note).timers, JSON.parse(JSON.stringify(state.timers))); assert.equal(h.durable(note).noteKey, note.key);
  await assert.rejects(() => handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /不允许/);
  await assert.rejects(() => handle.config.bridge.exportNote(state), /不允许/); assert.equal(note.html, '<p>Read-only independent prose</p>'); assert.deepEqual(note.tags, []);
});

test('deleted or reparented standalone notes preserve local work while preventing stale native saves and inserts', async t => {
  for (const action of ['deleted', 'reparented']) await t.test(action, async () => {
    const h = harness(), note = await standaloneNote(h, 'Preserved independent prose'); await h.start(); const handle = await h.Zotero.ReadingFlow.openItem(note.id), instance = handle.editor.getCurrentInstance();
    instance._iframeWindow.getDataSync = () => ({ html: '<p>Do not save this stale native buffer.</p>' }); const saves = handle.editor.saveCount || 0;
    if (action === 'deleted') note.deleted = true; else note.parentID = h.parent.id;
    const state = handle.getState(); state.pyramid.text = 'Keep local reasoning after a note move'; await handle.config.bridge.saveDraft(state);
    assert.equal(h.durable(note).pyramid.text, state.pyramid.text); assert.equal(h.durable(note).noteKey, note.key);
    await assert.rejects(() => handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /移除|关联|改变/);
    await assert.rejects(() => handle.config.bridge.exportNote(state), /移除|关联|改变/); assert.equal(instance._disableSaving, true);
    assert.equal(handle.editor.saveCount || 0, saves); assert.equal(note.html, '<p>Preserved independent prose</p>'); assert.deepEqual(note.tags, []);
    await h.stop(); assert.equal(note.html, '<p>Preserved independent prose</p>'); assert.equal(h.proseNotes().length, 1); assert.equal(handle.editor.saveCount || 0, saves);
  });
});

test('restoring an independent note rebuilds its invalidated native editor without replaying a stale prose buffer', async t => {
  const h = harness(), note = await standaloneNote(h, 'Original independent body'); note.addTag('Personal'); await h.start(); t.after(() => h.stop());
  const handle = await h.Zotero.ReadingFlow.openItem(note.id), oldEditor = handle.editor, oldInstance = oldEditor.getCurrentInstance(), oldID = oldEditor.id;
  const state = handle.getState(); state.pyramid.text = 'Keep the independent reasoning'; await handle.config.bridge.flushState(state);
  oldInstance._iframeWindow.getDataSync = () => ({ html: '<p>Stale body from before deletion.</p>' }); note.deleted = true;
  await assert.rejects(() => handle.config.bridge.exportNote(state), /移除|关联|改变/); assert.equal(oldInstance._disableSaving, true); assert.equal(note.html, '<p>Original independent body</p>');
  note.deleted = false; note.html = '<p>Restored safe native body.</p>'; const reopened = await h.clickRail();
  assert.equal(reopened, handle); assert.equal(reopened.note, note); assert.equal(reopened.editor.item, note); assert.notEqual(reopened.editor, oldEditor);
  assert.equal(oldEditor.isConnected, false); assert.equal(oldEditor.uninitCount, 1); assert.equal(oldEditor._editorInstance, null); assert.equal(oldInstance._disableSaving, true);
  assert.equal(reopened.editor.id, oldID); assert.equal(h.host.document.getElementById(oldID), reopened.editor); assert.equal(reopened.editor.mode, 'edit'); assert.equal(reopened.editor.hidden, false);
  const freshInstance = reopened.editor.getCurrentInstance(); assert.notEqual(freshInstance, oldInstance); assert.notEqual(freshInstance._disableSaving, true);
  assert.equal(note.html, '<p>Restored safe native body.</p>'); assert.equal(h.proseNotes().length, 1); assert.deepEqual(note.tags, ['Personal']); assert.equal(reopened.getState().pyramid.text, state.pyramid.text);
  freshInstance._iframeWindow.getDataSync = () => ({ html: '<p>Fresh edits after restoring the note.</p>' });
  const saved = await reopened.config.bridge.exportNote(reopened.getState()); assert.equal(saved.noteKey, note.key); assert.equal(note.html, '<p>Fresh edits after restoring the note.</p>'); assert.ok(reopened.editor.saveCount >= 1);
  assert.equal(h.durable(note).noteKey, note.key); assert.equal(h.durable(note).pyramid.text, state.pyramid.text); assert.equal(h.proseNotes().length, 1); assert.deepEqual(note.tags, ['Personal']);
});

test('standalone draft bindings cannot redirect the editor into another note', async t => {
  const h = harness(), note = await standaloneNote(h, 'Target note'), other = await standaloneNote(h, 'Unrelated note'), state = h.core.createSession(h.identity(note)); state.noteKey = other.key;
  const raw = JSON.stringify(state); h.files.set(h.draftName(note), raw); await h.start(); t.after(() => h.stop());
  await assert.rejects(() => h.Zotero.ReadingFlow.openItem(note.id), /关联|独立笔记|另一/); assert.equal(h.files.get(h.draftName(note)), raw); assert.equal(h.writes.length, 0);
  assert.equal(note.html, '<p>Target note</p>'); assert.equal(other.html, '<p>Unrelated note</p>'); assert.deepEqual(note.tags, []); assert.deepEqual(other.tags, []); assert.equal(h.proseNotes().length, 2);
});

test('native standalone-note rendering exposes only the Reading Flow rail and follows note switches without section callbacks', async t => {
  const h = harness(), a = await standaloneNote(h, 'Native note A'), b = await standaloneNote(h, 'Native note B');
  const originalRenderNote = h.libraryPane.renderNoteEditor, originalDefaultStatus = h.libraryNav.renderDefaultStatus;
  const nativeButton = h.host.document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); nativeButton.dataset.pane = 'native-info'; h.libraryNav.append(nativeButton); h.libraryNav.buttons.push(nativeButton);
  await h.start(); t.after(() => h.stop()); const handle = h.Zotero.ReadingFlow.inspect(h.host).find(panel => panel.kind === 'library');
  const nativeResult = h.selectNativeNote(a); assert.equal(nativeResult, h.nativeNoteRenderResult); await nativeResult;
  assert.equal(h.libraryNav.container.item, h.parent, 'the native note view leaves its custom-section container stale'); assert.equal(h.libraryNav.hidden, false);
  assert.notEqual(handle.button.getAttribute('disabled'), 'true'); assert.equal(nativeButton.getAttribute('disabled'), 'true');
  const opened = await h.clickRail(); assert.equal(opened.note, a); assert.equal(opened.editor.item, a); assert.equal(h.proseNotes().length, 2);
  opened.getState().pyramid.text = 'Native A reasoning'; await opened.config.bridge.flushState(opened.getState());
  const switchedResult = h.selectNativeNote(b); assert.equal(switchedResult, h.nativeNoteRenderResult); await switchedResult;
  for (let i = 0; i < 100 && opened.item.key !== b.key && !h.errors.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  if (opened.opening) await opened.opening.promise;
  assert.equal(opened.item.key, b.key); assert.equal(opened.note, b); assert.equal(opened.editor.item, b); assert.equal(opened.deck.selectedPanel, opened.panel);
  assert.equal(h.durable(a).pyramid.text, 'Native A reasoning'); assert.equal(h.libraryNav.container.item, h.parent);
  h.libraryNav.renderDefaultStatus(); assert.notEqual(handle.button.getAttribute('disabled'), 'true'); assert.equal(nativeButton.getAttribute('disabled'), 'true');
  assert.equal(a.html, '<p>Native note A</p>'); assert.equal(b.html, '<p>Native note B</p>'); assert.equal(h.proseNotes().length, 2); assert.deepEqual(a.tags, []); assert.deepEqual(b.tags, []);
  await h.stop(); assert.equal(h.libraryPane.renderNoteEditor, originalRenderNote); assert.equal(h.libraryNav.renderDefaultStatus, originalDefaultStatus);
  h.libraryPane.renderNoteEditor(); h.libraryNav.renderDefaultStatus(); assert.equal(h.libraryNav.hidden, true); assert.equal(nativeButton.getAttribute('disabled'), 'true');
});

test('native note hook cleanup preserves methods subsequently wrapped by another plugin', async t => {
  const h = harness(); await h.start();
  t.after(() => h.stop());
  const installedRenderNote = h.libraryPane.renderNoteEditor, installedDefaultStatus = h.libraryNav.renderDefaultStatus;
  const laterRenderNote = function (...args) { return installedRenderNote.apply(this, args); }, laterDefaultStatus = function (...args) { return installedDefaultStatus.apply(this, args); };
  h.libraryPane.renderNoteEditor = laterRenderNote; h.libraryNav.renderDefaultStatus = laterDefaultStatus; await h.stop();
  assert.equal(h.libraryPane.renderNoteEditor, laterRenderNote); assert.equal(h.libraryNav.renderDefaultStatus, laterDefaultStatus);
  const note = await standaloneNote(h, 'After plugin shutdown'); await h.selectNativeNote(note); assert.equal(h.libraryNav.hidden, true); assert.equal(h.libraryPane.nativeNoteRenders, 1);
});

test('PDF context rail opens its active independent note, keeps that owner on repeat clicks, and still routes explicit article opens to the reader', async t => {
  const h = harness(), note = await standaloneNote(h, 'An independent note pinned beside a PDF'); await h.start(); t.after(() => h.stop()); h.activateReader();
  h.originalActiveEditor.item = note; const handle = await h.clickRail('reader');
  assert.equal(handle.kind, 'reader'); assert.equal(handle.note, note); assert.equal(handle.editor.item, note); assert.equal(handle.parentID, null); assert.equal(handle.item.key, note.key);
  assert.equal(h.host.ZoteroContextPane.activeEditor, handle.editor); assert.equal(h.proseNotes().length, 1); assert.equal(h.files.has(h.draftName(h.parent)), false);
  const state = handle.getState(); state.pyramid.text = 'Reasoning for the independent PDF note'; await handle.config.bridge.flushState(state);
  const repeated = await h.clickRail('reader'); assert.equal(repeated, handle); assert.equal(repeated.note, note); assert.equal(h.proseNotes().length, 1); assert.equal(h.durable(note).pyramid.text, state.pyramid.text);
  await repeated.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }); assert.match(note.html, /<img data-attachment-key="[A-Z0-9]{8}"/); assert.deepEqual(note.tags, []);
  const article = await h.Zotero.ReadingFlow.openItem(h.parent.id); assert.equal(article, handle); assert.equal(article.kind, 'reader'); assert.equal(h.host.Zotero_Tabs.selectedType, 'reader');
  assert.equal(article.item.key, h.parent.key); assert.equal(article.note.parentID, h.parent.id); assert.notEqual(article.note, note); assert.equal(h.proseNotes().length, 2);
  assert.equal(h.durable(note).noteKey, note.key); assert.equal(h.durable(note).pyramid.text, state.pyramid.text);
  const repeatArticle = await h.clickRail('reader'); assert.equal(repeatArticle, article); assert.equal(repeatArticle.item.key, h.parent.key); assert.equal(h.proseNotes().length, 2);
});

test('PDF context persists a just-created independent note once before assigning its own draft identity', async t => {
  const h = harness(), note = new h.Zotero.Item('note'); note.libraryID = 1; note.setNote('<p>An unsaved independent draft.</p>');
  let release, saveCalls = 0; const barrier = new Promise(resolve => { release = resolve; }), saveTx = note.saveTx.bind(note);
  note.saveTx = async () => { saveCalls++; await barrier; return saveTx(); };
  await h.start(); t.after(() => h.stop()); h.activateReader(); h.originalActiveEditor.item = note;
  const handle = h.Zotero.ReadingFlow.inspect(h.host).find(panel => panel.kind === 'reader'); handle.button.click(); handle.button.click();
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(saveCalls, 1); assert.equal(note.id, undefined); release();
  if (handle.opening) await handle.opening.promise; const opened = await h.clickRail('reader');
  assert.equal(saveCalls, 1); assert.equal(h.proseNotes().length, 1); assert.equal(h.proseNotes()[0], note); assert.equal(opened.note, note); assert.equal(opened.editor.item, note);
  assert.ok(Number.isInteger(note.id)); assert.ok(note.key); assert.equal(opened.item.key, note.key); assert.equal(opened.getState().noteKey, note.key); assert.equal(h.durable(note).noteKey, note.key);
  assert.equal(opened.getState().item.libraryID, note.libraryID); assert.equal(h.files.has(h.draftName(h.parent)), false); assert.equal(note.html, '<p>An unsaved independent draft.</p>'); assert.deepEqual(note.tags, []);
});

test('PDF context refuses a read-only unsaved note without creating a replacement or writing a draft', async t => {
  const h = harness(), note = new h.Zotero.Item('note'); note.libraryID = 1; note.setNote('<p>Do not persist this read-only draft.</p>'); h.libraries.get(1).editable = false;
  let saveCalls = 0; const saveTx = note.saveTx.bind(note); note.saveTx = async () => { saveCalls++; return saveTx(); };
  await h.start(); t.after(() => h.stop()); h.activateReader(); h.originalActiveEditor.item = note;
  await assert.rejects(() => h.clickRail('reader'), /只读|不允许|可编辑/); assert.equal(saveCalls, 0); assert.equal(note.id, undefined); assert.equal(h.proseNotes().length, 0); assert.equal(h.writes.length, 0);
  assert.equal(note.html, '<p>Do not persist this read-only draft.</p>'); assert.deepEqual(note.tags, []);
});

test('shutdown awaits a first independent-note save and prevents sidebar configuration after that save completes', async t => {
  const h = harness(), note = new h.Zotero.Item('note'); note.libraryID = 1; note.setNote('<p>Finish this original note before shutdown.</p>');
  let release, saveCalls = 0; const barrier = new Promise(resolve => { release = resolve; }), saveTx = note.saveTx.bind(note);
  note.saveTx = async () => { saveCalls++; await barrier; return saveTx(); };
  await h.start(); t.after(() => { release(); return h.stop(); }); h.activateReader(); h.originalActiveEditor.item = note;
  const handle = h.Zotero.ReadingFlow.inspect(h.host).find(panel => panel.kind === 'reader'); handle.button.click();
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(saveCalls, 1); assert.equal(note.id, undefined);
  let finished = false; const stopping = h.stop().then(() => { finished = true; }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(finished, false); assert.equal(handle.config, null); assert.equal(handle.editor.item, undefined);
  release(); await stopping; assert.equal(finished, true); assert.equal(saveCalls, 1); assert.equal(h.proseNotes().length, 1); assert.equal(h.proseNotes()[0], note); assert.ok(note.id); assert.ok(note.key);
  assert.equal(note.html, '<p>Finish this original note before shutdown.</p>'); assert.deepEqual(note.tags, []); assert.equal(handle.config, null); assert.equal(handle.editor.item, undefined);
  assert.equal(handle.panel.isConnected, false); assert.equal(h.writes.length, 0); assert.equal(h.errors.length, 0); assert.equal(h.Zotero.ReadingFlow, undefined);
});

test('PDF note targeting flushes pending native prose and follows the original editor when the reader tab changes', async t => {
  const h = harness(), a = await standaloneNote(h, 'Saved A prose'), b = await standaloneNote(h, 'Saved B prose'), nativeSaves = [];
  let pendingHTML = '<p>Pending native A prose.</p>', synchronousSaves = 0;
  const nativeInstance = { _initPromise: Promise.resolve(), _iframeWindow: { getDataSync: () => ({ html: pendingHTML }) }, async _save(data) { nativeSaves.push(h.originalActiveEditor.item.key); h.originalActiveEditor.item.html = data.html; } };
  h.originalActiveEditor.getCurrentInstance = () => nativeInstance; h.originalActiveEditor.saveSync = () => { synchronousSaves++; };
  await h.start(); t.after(() => h.stop()); h.activateReader(); h.originalActiveEditor.item = a;
  const handle = await h.clickRail('reader'); assert.equal(handle.editor.item, a); assert.equal(a.html, '<p>Pending native A prose.</p>'); assert.ok(synchronousSaves >= 1);
  handle.getState().pyramid.text = 'A draft before switching tabs'; await handle.config.bridge.flushState(handle.getState());
  h.host.Zotero_Tabs.selectedID = 'reader-next'; h.originalActiveEditor.item = b; pendingHTML = '<p>Pending native B prose.</p>';
  const switched = await h.clickRail('reader'); assert.equal(switched, handle); assert.equal(switched.note, b); assert.equal(switched.editor.item, b); assert.equal(switched.item.key, b.key);
  assert.equal(a.html, '<p>Pending native A prose.</p>'); assert.equal(b.html, '<p>Pending native B prose.</p>'); assert.deepEqual(nativeSaves, [a.key, b.key]);
  assert.equal(h.durable(a).pyramid.text, 'A draft before switching tabs'); assert.equal(h.durable(a).noteKey, a.key); assert.equal(h.durable(b).noteKey, b.key);
  assert.equal(h.proseNotes().length, 2); assert.equal(h.files.has(h.draftName(h.parent)), false);
});

test('opens a native sidebar for a PDF parent, creates one marked child note, and never uses openDialog', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop());
  const [a, b] = await Promise.all([h.Zotero.ReadingFlow.openItem(10), h.Zotero.ReadingFlow.openItem(20)]);
  assert.equal(a, b); assert.equal(a.hostWindow, h.host); assert.equal(a.deck.selectedPanel, a.panel); assert.equal(a.editor.item, a.note);
  assert.equal(h.proseNotes().length, 1); assert.ok(a.note.hasTag('Reading Flow · sidebar')); assert.equal(h.durable().noteKey, a.note.key);
  const icons = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')).icons;
  assert.equal(h.getSection().sidenav.icon, 'chrome://reading-flow/' + icons['32']); assert.equal(h.getSection().header.icon, h.getSection().sidenav.icon);
  for (const icon of Object.values(icons)) assert.ok(fs.existsSync(path.join(__dirname, '..', icon)));
  assert.match(a.note.html, /主题与结构/); assert.match(a.note.html, /术语与命题/); assert.match(a.note.html, /批评性判断/);
  await assert.rejects(() => h.Zotero.ReadingFlow.openItem(30), /子附件/); await assert.rejects(() => h.Zotero.ReadingFlow.openItem('10'), /编号无效/);
});

test('actual rail clicks reopen the persisted native note and tools draft in a fresh plugin context', async t => {
  const first = harness(); await first.start(); const opened = await first.clickRail();
  opened.note.html = '<p>Native prose survives a cold relaunch.</p>'; opened.getState().pyramid.text = 'Persisted reasoning';
  await opened.config.bridge.flushState(opened.getState()); await first.stop();
  const cold = coldHarness(first), restored = cold.items.get(opened.note.id); await cold.start(); t.after(() => cold.stop());
  const reopened = await cold.clickRail();
  assert.equal(reopened.note, restored); assert.equal(reopened.editor.item, restored); assert.equal(cold.proseNotes().length, 1);
  assert.equal(restored.html, '<p>Native prose survives a cold relaunch.</p>'); assert.equal(reopened.getState().pyramid.text, 'Persisted reasoning');
  assert.equal(cold.durable().noteKey, restored.key);
});

test('cold rail reopen keeps a correctly bound note whose mutable sidebar tags were removed', async t => {
  const first = harness(); await first.start(); const opened = await first.clickRail();
  opened.note.html = '<p>Keep untagged native prose.</p>'; await first.stop(); opened.note.tags = [];
  const cold = coldHarness(first), original = cold.items.get(opened.note.id); await cold.start(); t.after(() => cold.stop());
  const reopened = await cold.clickRail();
  assert.equal(reopened.note, original); assert.equal(cold.proseNotes().length, 1); assert.equal(original.html, '<p>Keep untagged native prose.</p>');
  assert.deepEqual(original.tags, []); assert.equal(cold.writes.length, 0); assert.equal(reopened.toolsWindow.ReadingFlowApp.notice, '');
});

test('cold rail reopen replaces a trashed binding while backing up the exact draft and retaining original prose in the trash', async t => {
  const first = harness(); await first.start(); const opened = await first.clickRail();
  opened.note.html = '<p>Private prose stays in the trash.</p>'; opened.getState().pyramid.text = 'Keep the reasoning tree';
  first.core.startTimer(opened.getState(), 'analysis', 1000); first.core.pauseTimer(opened.getState(), 5000);
  await opened.config.bridge.flushState(opened.getState()); await first.stop(); opened.note.deleted = true; opened.note.tags = [];
  const cold = coldHarness(first), oldDraft = cold.files.get(cold.draftName(cold.parent)), original = cold.items.get(opened.note.id);
  await cold.start(); t.after(() => cold.stop()); const recovered = await cold.clickRail();
  assert.notEqual(recovered.note.key, original.key); assert.equal(cold.proseNotes().length, 2); assert.equal(original.deleted, true); assert.equal(original.html, '<p>Private prose stays in the trash.</p>');
  assert.doesNotMatch(recovered.note.html, /Private prose/); assert.equal(recovered.getState().pyramid.text, 'Keep the reasoning tree');
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.getState().timers)), JSON.parse(oldDraft).timers); assert.equal(cold.durable().noteKey, recovered.note.key);
  const backups = [...cold.files].filter(([name]) => name.includes('.before-note-relink-')); assert.equal(backups.length, 1); assert.equal(backups[0][1], oldDraft);
  assert.match(recovered.toolsWindow.ReadingFlowApp.notice, /回收站.*已建立新笔记.*保留/);
  const next = coldHarness(cold); await cold.stop(); await next.start(); t.after(() => next.stop());
  const reopened = await next.clickRail(); assert.equal(reopened.note.key, recovered.note.key); assert.equal(next.proseNotes().length, 2); assert.equal(next.writes.length, 0);
});

test('repeated hot rail clicks recover a trashed note once and never flush a stale native buffer into the trash', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); h.activateReader(); const handle = await h.clickRail('reader'), oldNote = handle.note, instance = handle.editor.getCurrentInstance();
  assert.equal(h.host.ZoteroContextPane.activeEditor, handle.editor);
  oldNote.html = '<p>Original trash body.</p>'; const originalSaveCount = handle.editor.saveCount || 0;
  instance._iframeWindow.getDataSync = () => ({ html: '<p>Do not write this stale buffer into the trash.</p>' });
  oldNote.deleted = true; oldNote.tags = []; assert.equal(h.host.ZoteroContextPane.activeEditor, h.originalActiveEditor); handle.button.click(); handle.button.click(); await handle.opening.promise;
  assert.notEqual(handle.note, oldNote); assert.equal(h.proseNotes().length, 2); assert.equal(oldNote.deleted, true); assert.equal(oldNote.html, '<p>Original trash body.</p>');
  assert.equal(instance._disableSaving, true); assert.equal(handle.editor.saveCount || 0, originalSaveCount); assert.equal([...h.files].filter(([name]) => name.includes('.before-note-relink-')).length, 1);
  assert.equal(h.host.ZoteroContextPane.activeEditor, handle.editor);
});

test('a failed relink after note creation keeps the old draft and can retry without making a duplicate replacement', async t => {
  const h = harness(), state = h.core.createSession(h.identity(h.parent)); state.noteKey = 'MISSING1'; state.pyramid.text = 'Keep this draft'; state.futureProperty = { values: [1, 2, 3] };
  const raw = JSON.stringify(state); h.files.set(h.draftName(h.parent), raw); await h.start(); t.after(() => h.stop()); h.failDraftWrite();
  await assert.rejects(() => h.clickRail(), /atomic-write/); assert.equal(h.files.get(h.draftName(h.parent)), raw); assert.equal(h.proseNotes().length, 1);
  const createdKey = h.proseNotes()[0].key; assert.equal([...h.files].filter(([name]) => name.includes('.before-note-relink-'))[0][1], raw);
  // Clear only the test's observed error; the integration must clear its rejected queue itself.
  h.errors.length = 0; const recovered = await h.clickRail(); assert.equal(h.proseNotes().length, 1); assert.equal(recovered.note.key, createdKey); assert.equal(h.durable().noteKey, createdKey);
  assert.equal(h.durable().pyramid.text, 'Keep this draft'); for (const [, content] of [...h.files].filter(([name]) => name.includes('.before-note-relink-'))) assert.equal(content, raw);
});

test('a stale or invalid native-note bridge cannot save another paper or insert into a trashed note', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.clickRail(), original = handle.note, bridge = handle.config.bridge, state = handle.getState();
  original.html = '<p>Preserved body.</p>'; original.deleted = true;
  await assert.rejects(() => bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /移除|关联/);
  await assert.rejects(() => bridge.exportNote(state), /移除|关联/); assert.equal(original.html, '<p>Preserved body.</p>');
  await h.Zotero.ReadingFlow.openItem(11); const writes = h.writes.length;
  await assert.rejects(() => bridge.exportNote(state), /当前文献已切换/); assert.equal(h.writes.length, writes); assert.equal(original.html, '<p>Preserved body.</p>');
});

test('missing bindings reconnect one valid marked child, preserve ambiguous copies, and fail safely if a draft backup cannot be written', async t => {
  for (const mode of ['one', 'multiple', 'backup-failure']) await t.test(mode, async t => {
    const h = harness(), state = h.core.createSession(h.identity(h.parent)); state.noteKey = 'MISSING1'; state.pyramid.text = 'Draft retained';
    const raw = JSON.stringify(state); h.files.set(h.draftName(h.parent), raw);
    for (let i = 0; i < (mode === 'multiple' ? 2 : 1); i++) { const note = new h.Zotero.Item('note'); note.libraryID = 1; note.parentID = 10; note.addTag('Reading Flow · sidebar'); note.setNote('<p>Existing candidate ' + i + '</p>'); await note.saveTx(); }
    const originals = h.notes.map(note => ({ note, html: note.html })); if (mode === 'backup-failure') h.failWrite();
    await h.start(); t.after(() => h.stop());
    if (mode === 'backup-failure') { await assert.rejects(() => h.clickRail(), /atomic-write/); assert.equal(h.files.get(h.draftName(h.parent)), raw); assert.equal(h.proseNotes().length, 1); }
    else { const recovered = await h.clickRail(); assert.equal(h.proseNotes().length, mode === 'one' ? 1 : 3); assert.equal(recovered.note === originals[0].note, mode === 'one'); assert.equal(h.durable().pyramid.text, 'Draft retained'); assert.equal(h.durable().noteKey, recovered.note.key); assert.equal([...h.files].filter(([name]) => name.includes('.before-note-relink-')).length, 1); }
    for (const { note, html } of originals) assert.equal(note.html, html);
  });
});

test('rail opening still refuses another parent or a non-note key without modifying notes or the original draft', async t => {
  for (const mode of ['wrong-parent', 'not-a-note']) await t.test(mode, async t => {
    const h = harness(), state = h.core.createSession(h.identity(h.parent));
    if (mode === 'wrong-parent') { const note = new h.Zotero.Item('note'); note.libraryID = 1; note.parentID = 11; note.setNote('<p>Another paper.</p>'); await note.saveTx(); state.noteKey = note.key; }
    else state.noteKey = h.other.key;
    const raw = JSON.stringify(state); h.files.set(h.draftName(h.parent), raw); await h.start(); t.after(() => h.stop());
    await assert.rejects(() => h.clickRail(), mode === 'wrong-parent' ? /另一篇文献/ : /不是.*笔记/);
    assert.equal(h.files.get(h.draftName(h.parent)), raw); assert.equal(h.writes.length, 0); assert.equal(h.proseNotes().length, mode === 'wrong-parent' ? 1 : 0);
  });
});

test('serializes immutable atomic drafts and preserves the previous file through a failed save', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10), state = handle.getState();
  state.pyramid.text = 'First snapshot'; const a = handle.config.bridge.saveState(state); state.pyramid.text = 'Second snapshot'; const b = handle.config.bridge.saveState(state); state.pyramid.text = 'Unsaved'; await Promise.all([a, b]);
  assert.equal(h.durable().pyramid.text, 'Second snapshot'); assert.equal(h.maximumInFlight.get(h.draftName(h.parent)), 1);
  h.failWrite(); state.pyramid.text = 'Failed'; await assert.rejects(() => handle.config.bridge.saveState(state), /atomic-write/); assert.equal(h.durable().pyramid.text, 'Second snapshot');
  state.pyramid.text = 'Recovered'; await handle.config.bridge.flushState(state); assert.equal(h.durable().pyramid.text, 'Recovered');
  const another = h.core.createSession(h.identity(h.other)); await assert.rejects(async () => handle.config.bridge.saveState(another), /另一篇文献/);
});

test('keeps user notes and v1 snapshots untouched while migrating legacy reading content into a new native note', async t => {
  const h = harness(), user = new h.Zotero.Item('note'), oldSnapshot = new h.Zotero.Item('note');
  for (const note of [user, oldSnapshot]) { note.libraryID = 1; note.parentID = 10; note.setNote('<p>Keep original content.</p>'); await note.saveTx(); } oldSnapshot.addTag('Reading Flow');
  const legacy = h.core.createSession(h.identity(h.parent)); legacy.version = 1; legacy.pyramid.text = 'Legacy conclusion'; h.files.set(h.draftName(h.parent), JSON.stringify(legacy));
  await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10);
  assert.equal(h.proseNotes().length, 3); assert.match(handle.note.html, /Legacy conclusion/); assert.equal(user.html, '<p>Keep original content.</p>'); assert.equal(oldSnapshot.html, user.html);
  handle.note.html = '<p>User edited the native note.</p>'; const key = handle.note.key;
  await h.Zotero.ReadingFlow.openItem(11); const reopened = await h.Zotero.ReadingFlow.openItem(10); assert.equal(reopened.note.key, key); assert.equal(reopened.note.html, '<p>User edited the native note.</p>');
});

test('read-only libraries retain a local tools draft without constructing or assigning a null native note', async t => {
  const h = harness(); h.libraries.get(1).editable = false; await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10);
  assert.equal(handle.readOnly, true); assert.equal(handle.editor.hidden, true); assert.equal(handle.editor.item, undefined); assert.equal(h.proseNotes().length, 0);
  const state = handle.getState(); state.pyramid.text = 'Local reasoning'; await handle.config.bridge.saveState(state); assert.equal(h.durable().pyramid.text, 'Local reasoning');
  await assert.rejects(() => handle.config.bridge.insertPyramid({}), /不允许编辑/);
});

test('native backup pickers cancel safely, validate item identity, and refuse corrupt on-disk drafts', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10);
  assert.equal((await handle.config.bridge.exportJSON(handle.getState())).cancelled, true); assert.equal(await handle.config.bridge.importJSON(), null);
  h.pickerResponses.push({ result: 0, file: 'D:/exports/current.json' }); await handle.config.bridge.exportJSON(handle.getState()); assert.equal(h.pickerRequests[2].parentWindow, h.host);
  h.pickerResponses.push({ result: 0, file: 'D:/exports/current.json' }); assert.equal((await handle.config.bridge.importJSON()).item.key, h.parent.key);
  h.files.set('D:/exports/other.json', JSON.stringify(h.core.createSession(h.identity(h.other)))); h.pickerResponses.push({ result: 0, file: 'D:/exports/other.json' }); await assert.rejects(() => handle.config.bridge.importJSON(), /另一篇文献/);
  await h.Zotero.ReadingFlow.openItem(11); h.files.set(h.draftName(h.parent), '{broken'); await assert.rejects(() => h.Zotero.ReadingFlow.openItem(10), /无法读取阅读数据/); assert.equal(h.files.get(h.draftName(h.parent)), '{broken');
});

test('returning to A cancels a pending B initialization before it can replace the visible native note', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10), firstNote = handle.note;
  h.files.set(h.draftName(h.other), JSON.stringify(h.core.createSession(h.identity(h.other)))); const unblock = h.blockRead(h.other);
  const pending = h.Zotero.ReadingFlow.openItem(11); await new Promise(resolve => setTimeout(resolve, 10)); await h.Zotero.ReadingFlow.openItem(10); unblock(); await pending;
  assert.equal(handle.item.key, h.parent.key); assert.equal(handle.note, firstNote); assert.equal(handle.editor.item, firstNote);
  const state = handle.getState(); state.pyramid.text = 'A after cancellation'; await handle.config.bridge.saveState(state); assert.equal(h.durable().pyramid.text, 'A after cancellation');
});

test('library and PDF panes share the newest tools state and ignore hidden stale-frame writes', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const library = await h.Zotero.ReadingFlow.openItem(10), staleBridge = library.config.bridge;
  const first = library.getState(); first.pyramid.text = 'Library first'; await staleBridge.saveState(first);
  h.activateReader(); const reader = await h.Zotero.ReadingFlow.openItem(10); assert.notEqual(reader, library); assert.equal(reader.note, library.note); assert.equal(reader.getState().pyramid.text, 'Library first');
  assert.equal(h.host.ZoteroContextPane.activeEditor, reader.editor); reader.hide(); assert.equal(h.host.ZoteroContextPane.activeEditor, h.originalActiveEditor); reader.show();
  const latest = reader.getState(); latest.pyramid.text = 'Reader latest'; await reader.config.bridge.saveState(latest);
  first.pyramid.text = 'Hidden stale'; assert.equal((await staleBridge.saveState(first)).ignored, true); assert.equal(h.durable().pyramid.text, 'Reader latest');
  h.host.Zotero_Tabs.select('zotero-pane'); const returned = await h.Zotero.ReadingFlow.openItem(10); assert.equal(returned, library); assert.equal(returned.getState().pyramid.text, 'Reader latest'); assert.equal(h.proseNotes().length, 1);
});

test('clears invalid selection, inserts only bounded PNGs, and cleans native panels while preserving other reader hooks', async () => {
  const h = harness(); await h.start(); const api = h.Zotero.ReadingFlow, handle = await api.openItem(10);
  await assert.rejects(() => handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/svg+xml,...', width: 1, height: 1 }), /格式或大小/);
  await handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }); assert.match(handle.note.html, /<img data-attachment-key="[A-Z0-9]{8}"/);
  h.clearSelection(); assert.notEqual(handle.deck.selectedPanel, handle.panel); await new Promise(resolve => setTimeout(resolve, 8));
  await h.stop(); assert.equal(h.menus.size, 0); assert.equal(h.Zotero.ReadingFlow, undefined); assert.equal(handle.panel.isConnected, false); assert.equal(h.Zotero.Reader._registeredListeners.length, 1); assert.equal(h.Zotero.Reader._registeredListeners[0].pluginID, 'other-plugin');
  assert.equal(h.host.ZoteroContextPane.activeEditor, h.originalActiveEditor);
  await assert.rejects(() => api.openItem(10), /正在关闭/);
});

test('pyramid images use a native embedded attachment owned by the displayed note', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10);
  const prose = handle.note.html; await handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 30, height: 20 });
  const images = [...h.items.values()].filter(item => item.isEmbeddedImageAttachment?.()); assert.equal(images.length, 1);
  assert.equal(images[0].parentID, handle.note.id); assert.equal(images[0].libraryID, handle.note.libraryID); assert.equal(images[0].imageData, 'data:image/png;base64,AAAA');
  assert.match(handle.note.html, new RegExp('data-attachment-key="' + images[0].key + '"')); assert.ok(handle.note.html.startsWith(prose));
  assert.doesNotMatch(handle.note.html, /src="data:|src="file:/); assert.match(handle.note.html, /width="30" height="20"/);
  assert.equal(h.imagePosts.length, 1); assert.match(h.imagePosts[0].html, new RegExp('data-attachment-key="' + images[0].key + '"')); assert.doesNotMatch(h.imagePosts[0].html, /src="data:/); assert.ok(h.dbCalls.includes('query'));
});

test('pyramid image insertion refuses unavailable file permissions before importing or modifying prose', async t => {
  for (const permission of ['library', 'editor']) await t.test(permission, async t => {
    const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10), original = handle.note.html;
    if (permission === 'library') h.libraries.get(1).filesEditable = false; else handle.editor.getCurrentInstance()._filesReadOnly = true;
    await assert.rejects(() => handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /权限|附件|文件|允许/);
    assert.equal(handle.note.html, original); assert.equal([...h.items.values()].filter(item => item.isEmbeddedImageAttachment?.()).length, 0);
  });
});

test('pyramid image insertion validates imported attachment identity, file availability, and a moved note', async t => {
  for (const mismatch of ['key', 'owner', 'library', 'missing-file', 'moved-note', 'deleted-note', 'deleted-attachment']) await t.test(mismatch, async t => {
    const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(10), note = handle.note, original = note.html, instance = handle.editor.getCurrentInstance(), importImage = instance._importImage.bind(instance);
    instance._importImage = async src => {
      if (mismatch === 'key') return 'invalid-key';
      const key = await importImage(src), attachment = await h.Zotero.Items.getByLibraryAndKeyAsync(note.libraryID, key);
      if (mismatch === 'owner') attachment.parentID = h.other.id;
      if (mismatch === 'library') attachment.libraryID = 99;
      if (mismatch === 'missing-file') h.files.delete(attachment.filePath);
      if (mismatch === 'moved-note') note.parentID = h.other.id;
      if (mismatch === 'deleted-note') note.deleted = true;
      if (mismatch === 'deleted-attachment') attachment.deleted = true;
      return key;
    };
    await assert.rejects(() => handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /附件|关联|改变|切换|文件|尚未完成插入/);
    assert.equal(note.html, original);
  });
});

test('pyramid image insertion requires the committed database note to reference its imported attachment', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.clickRail(), original = handle.note.html;
  h.Zotero.DB.valueQueryAsync = async () => original;
  await assert.rejects(() => handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), /尚未保存|无法确认/);
  assert.ok(handle.note.html.startsWith(original)); assert.match(handle.note.html, /data-attachment-key="[A-Z0-9]{8}"/); assert.doesNotMatch(h.imagePosts[0].html, /src="data:/);
});

test('pyramid image insertion uses a valid native cursor position and safely appends for an out-of-range selection', async t => {
  for (const [position, expected] of [[5, 5], [21, -1]]) await t.test(String(position), async t => {
    const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.clickRail(), original = handle.note.html, instance = handle.editor.getCurrentInstance();
    instance._iframeWindow._currentEditorInstance = { _editorCore: { view: { state: { selection: { to: position }, doc: { content: { size: 20 } } } } } };
    await handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 });
    assert.equal(h.imagePosts.at(-1).pos, expected); assert.ok(handle.note.html.startsWith(original)); assert.match(handle.note.html, /data-attachment-key="[A-Z0-9]{8}"/);
  });
});

test('repeat rail and API opens of the same note keep a pending image insertion bound to its original generation', async t => {
  const h = harness(), note = await standaloneNote(h, 'Independent prose during image insertion'); await h.start(); t.after(() => h.stop()); const handle = await h.Zotero.ReadingFlow.openItem(note.id), generation = handle.generation;
  let finishReadback, signalReadback; const blocked = new Promise(resolve => { finishReadback = resolve; }), readingBack = new Promise(resolve => { signalReadback = resolve; }), query = h.Zotero.DB.valueQueryAsync.bind(h.Zotero.DB);
  h.Zotero.DB.valueQueryAsync = async (...args) => { signalReadback(); await blocked; return query(...args); };
  const insertion = handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }); await readingBack;
  assert.equal(await h.clickRail(), handle); assert.equal(handle.generation, generation);
  assert.equal(await h.Zotero.ReadingFlow.openItem(note.id), handle); assert.equal(handle.generation, generation);
  finishReadback(); assert.match((await insertion).message, /已插入/); assert.equal(handle.toolsWindow.ReadingFlowApp.notice, ''); assert.equal(h.errors.length, 0);
  assert.equal(handle.note, note); assert.match(note.html, /data-attachment-key="[A-Z0-9]{8}"/); assert.ok(note.html.includes('Independent prose during image insertion'));
});

test('switching to a different item still invalidates an image insertion waiting for database confirmation', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const handle = await h.clickRail(), originalNote = handle.note, generation = handle.generation;
  let finishReadback, signalReadback; const blocked = new Promise(resolve => { finishReadback = resolve; }), readingBack = new Promise(resolve => { signalReadback = resolve; }), query = h.Zotero.DB.valueQueryAsync.bind(h.Zotero.DB);
  h.Zotero.DB.valueQueryAsync = async (...args) => { signalReadback(); await blocked; return query(...args); };
  const insertion = handle.config.bridge.insertPyramid({ pngDataURL: 'data:image/png;base64,AAAA', width: 10, height: 10 }), rejected = assert.rejects(() => insertion, /改变|切换/); await readingBack;
  const switched = await h.Zotero.ReadingFlow.openItem(h.other.id), secondHTML = switched.note.html; assert.notEqual(switched.note, originalNote); assert.ok(switched.generation > generation);
  finishReadback(); await rejected; assert.equal(switched.note.html, secondHTML); assert.doesNotMatch(switched.note.html, /data-attachment-key/); assert.equal(h.errors.length, 0);
});

test('early shutdown awaits native uninit and database refreshes, while a disabled plugin listener is inert', async () => {
  const h = harness(); await h.start(); const handle = await h.Zotero.ReadingFlow.openItem(10), instance = handle.editor.getCurrentInstance();
  let release; handle.editor.uninitBarrier = new Promise(resolve => { release = resolve; });
  let finished = false; const shutdown = h.shutdownListeners[0]().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(finished, false); assert.equal(instance._disableSaving, true); assert.equal(handle.editor.uninitCount, 1);
  release(); await shutdown; assert.equal(handle.panel.isConnected, false); assert.equal(handle.editor._editorInstance, null); assert.ok(h.dbCalls.length >= 1);
  assert.match(h.debugMessages.at(-1), /complete before database close/);
  const waitCount = h.dbCalls.length, messages = h.debugMessages.length; await h.shutdownListeners[0](); assert.equal(h.dbCalls.length, waitCount); assert.equal(h.debugMessages.length, messages);
});

test('stop is idempotent and waits for an unload detach whose host was already removed from the registry', async () => {
  const h = harness(); await h.start(); const handle = await h.Zotero.ReadingFlow.openItem(10), state = handle.getState(); state.pyramid.text = 'Unload must retain this final draft';
  let release; const barrier = new Promise(resolve => { release = resolve; });
  handle.toolsWindow.ReadingFlowApp.flushPendingSave = async () => { await barrier; await handle.config.bridge.flushState(state); };
  h.unloadHost(); assert.equal(h.Zotero.ReadingFlow.inspect(h.host).length, 0);
  const first = h.stop(), second = h.stop(); assert.equal(first, second);
  let finished = false; first.then(() => { finished = true; }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(finished, false);
  release(); await first; assert.equal(h.durable().pyramid.text, 'Unload must retain this final draft'); assert.equal(handle.panel.isConnected, false); assert.equal(handle.editor.uninitCount, 1);
});

test('keeps intrinsic tool height through caps and hidden panels, recalculates on resize, and leaves room for native notes', async () => {
  const h = harness(); await h.start(); const handle = await h.Zotero.ReadingFlow.openItem(10), bridge = handle.config.bridge;
  assert.equal(bridge.resizeTools(500), 500); assert.equal(handle.requestedToolsHeight, 500);
  for (let i = 0; i < 8; i++) h.resizePanel(handle, 800);
  assert.equal(handle.allocatedToolsHeight, 500); assert.equal(handle.frame.style.height, '500px');
  h.resizePanel(handle, 300); assert.equal(handle.requestedToolsHeight, 500); assert.equal(handle.allocatedToolsHeight, 195); assert.ok(300 - handle.allocatedToolsHeight >= 80);
  h.resizePanel(handle, 0); assert.equal(handle.requestedToolsHeight, 500); assert.equal(handle.allocatedToolsHeight, 195);
  h.resizePanel(handle, 800); assert.equal(handle.allocatedToolsHeight, 500);
  handle.hide(); h.resizePanel(handle, 0); assert.equal(bridge.resizeTools(580), 500); assert.equal(handle.requestedToolsHeight, 580);
  handle.panel.layoutHeight = 800; handle.show(); assert.equal(handle.allocatedToolsHeight, 520);
  handle.panel.layoutHeight = 420; h.resizeWindow(); assert.equal(handle.allocatedToolsHeight, 273); assert.equal(handle.requestedToolsHeight, 580);
  assert.equal(bridge.resizeTools(54), 58); assert.equal(handle.allocatedToolsHeight, 58);
  await h.stop(); assert.ok(h.resizeObservers.every(observer => observer.disconnected));
});

test('reader tools cap follows the visible window when a XUL panel retains a taller old height, then expands again', async () => {
  const h = harness(); await h.start(); h.activateReader(); const handle = await h.Zotero.ReadingFlow.openItem(10);
  handle.panel.layoutHeight = 763; handle.panel.layoutTop = 80; h.host.innerHeight = 600;
  assert.equal(handle.config.bridge.resizeTools(500), 338); assert.equal(handle.panel.style.maxHeight, '520px'); assert.equal(handle.visiblePanelHeight, 520);
  assert.ok(handle.visiblePanelHeight - handle.allocatedToolsHeight >= 160); assert.equal(handle.requestedToolsHeight, 500);
  assert.equal(handle.editor.mode, 'edit'); assert.equal(handle.editor.footer.hidden, true); assert.equal(handle.editor.footer.style.display, 'none');
  h.host.innerHeight = 900; h.resizeWindow(); assert.equal(handle.panel.style.maxHeight, '820px'); assert.equal(handle.visiblePanelHeight, 763); assert.equal(handle.allocatedToolsHeight, 495);
  h.host.innerHeight = 600; h.resizeWindow(); assert.equal(handle.allocatedToolsHeight, 338); assert.equal(handle.requestedToolsHeight, 500);
  await h.stop();
});

test('manual tools height can grow beyond the automatic share while reserving the native note and surviving hidden panels', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop());
  const handle = await h.Zotero.ReadingFlow.openItem(10), bridge = handle.config.bridge;
  h.resizePanel(handle, 800);
  assert.equal(bridge.resizeTools(700, { manual: true }), 640);
  assert.equal(handle.requestedToolsHeight, 700); assert.equal(handle.frame.style.height, '640px');
  assert.ok(800 - handle.allocatedToolsHeight >= 160);
  h.resizePanel(handle, 300);
  assert.equal(handle.allocatedToolsHeight, 210); assert.equal(handle.requestedToolsHeight, 700);
  assert.ok(300 - handle.allocatedToolsHeight >= 80);
  handle.hide(); h.resizePanel(handle, 0);
  assert.equal(handle.allocatedToolsHeight, 210); assert.equal(handle.requestedToolsHeight, 700);
  handle.panel.layoutHeight = 1100; handle.show();
  assert.equal(handle.allocatedToolsHeight, 700);
  assert.equal(bridge.resizeTools(700, { manual: false }), 700);
  h.resizePanel(handle, 800); assert.equal(handle.allocatedToolsHeight, 520);
  assert.equal(bridge.resizeTools(58, { manual: false }), 58);
});

test('manual reader height follows the visible window rather than a stale XUL panel height', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); h.activateReader();
  const handle = await h.Zotero.ReadingFlow.openItem(10), bridge = handle.config.bridge;
  handle.panel.layoutHeight = 763; handle.panel.layoutTop = 80; h.host.innerHeight = 600;
  assert.equal(bridge.resizeTools(700, { manual: true }), 364);
  assert.equal(handle.visiblePanelHeight, 520); assert.equal(handle.requestedToolsHeight, 700);
  assert.ok(handle.visiblePanelHeight - handle.allocatedToolsHeight >= 156);
  h.host.innerHeight = 1000; h.resizeWindow();
  assert.equal(handle.visiblePanelHeight, 763); assert.equal(handle.allocatedToolsHeight, 603);
  h.host.innerHeight = 600; h.resizeWindow();
  assert.equal(handle.allocatedToolsHeight, 364); assert.equal(handle.requestedToolsHeight, 700);
});

test('pyramid display height persists across items and cold reopening without entering note drafts', async t => {
  const first = harness(); await first.start(); const opened = await first.Zotero.ReadingFlow.openItem(10);
  assert.equal(opened.config.pyramidHeight, null);
  await opened.config.bridge.savePyramidHeight(420);
  const next = await first.Zotero.ReadingFlow.openItem(11);
  assert.equal(next.config.pyramidHeight, 420);
  assert.equal(Object.hasOwn(next.getState(), 'pyramidHeight'), false);
  await first.stop();
  const cold = coldHarness(first); await cold.start(); t.after(() => cold.stop());
  const reopened = await cold.Zotero.ReadingFlow.openItem(10); assert.equal(reopened.config.pyramidHeight, 420);
  await reopened.config.bridge.savePyramidHeight(null);
  const automatic = await cold.Zotero.ReadingFlow.openItem(11); assert.equal(automatic.config.pyramidHeight, null);
  cold.libraries.get(1).editable = false;
  const readOnly = await cold.Zotero.ReadingFlow.openItem(10); assert.equal(readOnly.readOnly, true);
  await readOnly.config.bridge.savePyramidHeight(360);
  const readOnlyNext = await cold.Zotero.ReadingFlow.openItem(11); assert.equal(readOnlyNext.config.pyramidHeight, 360);
  assert.equal(readOnlyNext.readOnly, true);
});

test('a second device with no plugin files reopens the synced editable pyramid and binds the same native note', async t => {
  const a = harness(); await a.start(); t.after(() => a.stop()); const first = await a.clickRail(), state = first.getState();
  state.pyramid.text = 'Portable editable reasoning'; state.pyramid.boldRanges = [{ start: 0, end: 8 }]; state.framing.situation = 'Shared background';
  await first.config.bridge.flushState(state); const b = harness(); transferNotes(a, b); assert.equal(b.files.size, 0); assert.equal(b.prefs.size, 0);
  await b.start(); t.after(() => b.stop()); const reopened = await b.clickRail();
  assert.equal(reopened.getState().pyramid.text, 'Portable editable reasoning'); assert.deepEqual(JSON.parse(JSON.stringify(reopened.getState().pyramid.boldRanges)), [{ start: 0, end: 8 }]);
  assert.equal(reopened.getState().framing.situation, 'Shared background'); assert.equal(reopened.note.key, first.note.key); assert.equal(b.proseNotes().length, 1);
  assert.equal(reopened.config.syncConflict, false); assert.equal(reopened.config.bridge.canEdit, true);
});

test('an item notification refreshes a clean visible pyramid when a newer device version arrives', async t => {
  const a = harness(); await a.start(); t.after(() => a.stop()); const shown = await a.clickRail(); shown.getState().pyramid.text = 'Initial A'; await shown.config.bridge.flushState(shown.getState());
  const b = harness(); transferNotes(a, b); await b.start(); t.after(() => b.stop()); const other = await b.clickRail(); other.getState().pyramid.text = 'New B version'; await other.config.bridge.flushState(other.getState());
  const before = shown.config, ids = transferNotes(b, a, note => a.sync.decodeNote(note.html)?.deviceID === b.prefs.get(a.sync.DEVICE_PREF));
  await a.emitItemChange(ids, 'add'); await waitUntil(() => shown.config !== before, 'visible pyramid should refresh after synced records arrive');
  assert.equal(shown.getState().pyramid.text, 'New B version'); assert.equal(shown.config.syncConflict, false); assert.equal(shown.note.key, other.note.key);
  const writes = a.noteWrites.length, refreshed = shown.config; await a.emitItemChange(ids); await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(shown.config, refreshed); assert.equal(a.noteWrites.length, writes, 'identical notifications must not create a sync write loop');
  assert.equal(a.errors.length, 0);
});

test('a remote arrival preserves unsaved typing as a local conflict and explicit selection resolves it', async t => {
  const a = harness(); await a.start(); t.after(() => a.stop()); const shown = await a.clickRail(); shown.getState().pyramid.text = 'Original'; await shown.config.bridge.flushState(shown.getState());
  const b = harness(); transferNotes(a, b); await b.start(); t.after(() => b.stop()); const other = await b.clickRail(); other.getState().pyramid.text = 'Incoming B'; await other.config.bridge.flushState(other.getState());
  const app = shown.toolsWindow.ReadingFlowApp, before = shown.config, bridge = before.bridge; app.state.pyramid.text = 'Unsent A typing'; app.dirty = true;
  app.flushPendingSave = async () => { if (!app.dirty) return; app.dirty = false; await bridge.flushState(app.state); };
  const ids = transferNotes(b, a, note => a.sync.decodeNote(note.html)?.deviceID === b.prefs.get(a.sync.DEVICE_PREF)); await a.emitItemChange(ids);
  await waitUntil(() => shown.config !== before, 'a dirty local editor must surface a conflict after the remote arrival');
  assert.equal(shown.config.syncConflict, true); assert.equal(shown.config.bridge.canEdit, false); assert.equal(a.durable().pyramid.text, 'Unsent A typing');
  assert.deepEqual(new Set(shown.config.syncVersions.map(version => version.state.pyramid.text)), new Set(['Incoming B', 'Unsent A typing']));
  const chosen = shown.config.syncVersions.find(version => version.state.pyramid.text === 'Incoming B'); await shown.config.bridge.resolveSyncVersion(chosen.id);
  assert.equal(shown.config.syncConflict, false); assert.equal(shown.config.bridge.canEdit, true); assert.equal(shown.getState().pyramid.text, 'Incoming B');
  assert.equal(a.durable().pyramid.text, 'Incoming B');
});

test('stopping the plugin cancels pending sync refreshes and unregisters its observers', async () => {
  const h = harness(); await h.start(); const handle = await h.clickRail(), before = handle.config; await h.emitItemChange([123]);
  assert.equal(h.observers.size, 1); await h.stop(); assert.equal(h.observers.size, 0);
  await h.emitItemChange([123]); await new Promise(resolve => setTimeout(resolve, 280)); assert.equal(handle.config, before); assert.equal(handle.panel.isConnected, false);
});

test('background migration publishes unopened legacy drafts once and preserves their native prose binding', async t => {
  const h = harness({ scanDrafts: true }), prose = await standaloneNote(h, 'Keep this existing native body'); prose.parentID = h.parent.id;
  const legacy = h.core.createSession(h.identity(h.parent)); legacy.noteKey = prose.key; legacy.pyramid.text = 'Unopened legacy reasoning'; h.files.set(h.draftName(h.parent), JSON.stringify(legacy));
  await h.start(); t.after(() => h.stop()); await waitUntil(() => h.files.has(h.draftName(h.parent)) && h.durable().readingFlowSync?.format === h.sync.FORMAT, 'legacy draft should migrate without opening its sidebar');
  assert.equal(h.Zotero.ReadingFlow.inspect(h.host).some(handle => handle.config), false); assert.equal(h.proseNotes().length, 1); assert.equal(prose.html, '<p>Keep this existing native body</p>');
  const head = [...h.transportRecords.values()].find(value => value.record.ownerKey === h.parent.key); assert.ok(head); const migrated = head.record.state; assert.equal(migrated.pyramid.text, legacy.pyramid.text); assert.equal(migrated.noteKey, prose.key); assert.equal(h.notes.filter(note => h.sync.decodeNote(note.html)).length, 0);
  await h.stop(); const cold = harness({ scanDrafts: true }); for (const [path, content] of h.files) cold.files.set(path, content); for (const [key, value] of h.prefs) cold.prefs.set(key, value); transferNotes(h, cold);
  await cold.start(); t.after(() => cold.stop()); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(cold.noteWrites.length, 0); assert.equal(cold.writes.length, 0);
});

test('background migration skips read-only and missing-note drafts and preserves corrupt source files', async t => {
  for (const kind of ['read-only', 'missing-note', 'corrupt']) await t.test(kind, async t => {
    const h = harness({ scanDrafts: true }), legacy = h.core.createSession(h.identity(h.parent)); legacy.pyramid.text = 'Keep unopened local content';
    if (kind === 'read-only') h.libraries.get(1).editable = false;
    if (kind === 'missing-note') legacy.noteKey = 'MISSING1';
    const raw = kind === 'corrupt' ? '{broken-json' : JSON.stringify(legacy); h.files.set(h.draftName(h.parent), raw);
    await h.start(); t.after(() => h.stop()); await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(h.files.get(h.draftName(h.parent)), raw); assert.equal(h.notes.length, 0); assert.equal(h.writes.length, 0);
    if (kind === 'corrupt') { assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /旧草稿.*保留.*迁移未完成/); }
  });
});

test('a fresh device waits for a referenced synced prose note instead of creating a competing empty note', async t => {
  const a = harness(); await a.start(); t.after(() => a.stop()); const original = await a.clickRail(); original.note.html = '<p>Synced prose arrives later</p>'; original.getState().pyramid.text = 'Reasoning arrives first'; await original.config.bridge.flushState(original.getState());
  const b = harness(); transferNotes(a, b, note => !!a.sync.decodeNote(note.html)); await b.start(); t.after(() => b.stop()); const shown = await b.clickRail();
  assert.equal(shown.getState().pyramid.text, 'Reasoning arrives first'); assert.equal(shown.getState().noteKey, original.note.key); assert.equal(b.proseNotes().length, 0);
  assert.equal(shown.editor.hidden, true); assert.equal(shown.config.syncPending, true); assert.equal(shown.config.bridge.canEdit, false);
  const pendingPreview = JSON.parse(JSON.stringify(shown.getState())); pendingPreview.pyramid.text = 'An out-of-order pending preview must not become a draft';
  assert.equal((await shown.config.bridge.flushState(pendingPreview)).ignored, true); assert.equal(b.files.has(b.draftName(b.parent)), false);
  const before = shown.config, ids = transferNotes(a, b, note => note.key === original.note.key); await b.emitItemChange(ids, 'add');
  await waitUntil(() => shown.config !== before && shown.note?.key === original.note.key, 'arriving native prose should unblock the existing pyramid even when sync head is unchanged');
  assert.equal(shown.config.syncPending, false); assert.equal(shown.config.bridge.canEdit, true); assert.equal(b.proseNotes().length, 1); assert.equal(shown.note.html, '<p>Synced prose arrives later</p>');
  assert.equal(shown.getState().pyramid.text, 'Reasoning arrives first'); assert.equal(b.noteWrites.length, 0, 'waiting and arrival must not republish a replacement binding');
});

test('preview flushes cannot overwrite a legacy conflict and choosing a remote version retains the unpublished local tree', async t => {
  const remote = harness(); await remote.start(); t.after(() => remote.stop()); const original = await remote.clickRail(); original.getState().pyramid.text = 'Remote B reasoning'; await original.config.bridge.flushState(original.getState());
  const local = harness(); transferNotes(remote, local); const legacy = local.core.createSession(local.identity(local.parent)); legacy.pyramid.text = 'Unpublished legacy A'; legacy.noteKey = original.note.key;
  const raw = JSON.stringify(legacy); local.files.set(local.draftName(local.parent), raw); await local.start(); t.after(() => local.stop()); const shown = await local.clickRail();
  assert.equal(shown.config.syncConflict, true); assert.equal(shown.config.bridge.canEdit, false);
  const candidate = shown.config.syncVersions.find(version => version.state.pyramid.text === 'Remote B reasoning'); assert.ok(candidate);
  const preview = JSON.parse(JSON.stringify(candidate.state)), writes = local.writes.length, noteWrites = local.noteWrites.length;
  shown.toolsWindow.ReadingFlowApp.state = preview;
  for (const method of ['saveState', 'saveDraft', 'flushState']) assert.equal((await shown.config.bridge[method](preview)).ignored, true);
  assert.equal(local.files.get(local.draftName(local.parent)), raw, 'closing or changing a preview must preserve the exact unpublished local source');
  assert.equal(local.writes.length, writes); assert.equal(local.noteWrites.length, noteWrites);
  await shown.config.bridge.resolveSyncVersion(candidate.id);
  assert.equal(shown.config.syncConflict, false); assert.equal(shown.getState().pyramid.text, 'Remote B reasoning'); assert.equal(local.durable().pyramid.text, 'Remote B reasoning');
  const retained = [...local.transportRecords.values()].map(value => value.record.state.pyramid.text);
  assert.ok(retained.includes('Unpublished legacy A'), 'the unchosen local legacy tree must become a recoverable synced record before its cache is replaced');
  assert.ok(retained.includes('Remote B reasoning')); assert.equal(local.proseNotes().length, 1);
});

test('a background migration overtaken by an interactive open cannot replay an older snapshot', async t => {
  const h = harness({ scanDrafts: true }), legacy = h.core.createSession(h.identity(h.parent)); legacy.pyramid.text = 'Old unopened draft'; h.files.set(h.draftName(h.parent), JSON.stringify(legacy));
  let resumeMigration, signalDiscovery; const blocked = new Promise(resolve => { resumeMigration = resolve; }), discovered = new Promise(resolve => { signalDiscovery = resolve; });
  const search = h.Zotero.Search.prototype.search; let first = true;
  h.Zotero.Search.prototype.search = async function () { if (first) { first = false; signalDiscovery(); await blocked; } return search.call(this); };
  await h.start(); t.after(() => h.stop()); await discovered; const shown = await h.clickRail(); shown.getState().pyramid.text = 'New interactive typing'; await shown.config.bridge.flushState(shown.getState());
  resumeMigration(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.durable().pyramid.text, 'New interactive typing'); const loaded = await h.sync.create({ Zotero: h.Zotero, core: h.core, fileStore: h.fileStore }).load(h.identity(h.parent));
  assert.equal(loaded.state.pyramid.text, 'New interactive typing'); assert.equal(loaded.conflict, false); assert.equal(h.errors.length, 0); assert.equal(h.proseNotes().length, 1);
});

test('a sync notification during sidebar loading is retried after opening instead of being lost', async t => {
  const a = harness(); await a.start(); t.after(() => a.stop()); const library = await a.clickRail(); library.getState().pyramid.text = 'Before reader opens'; await library.config.bridge.flushState(library.getState());
  const b = harness(); transferNotes(a, b); await b.start(); t.after(() => b.stop()); const other = await b.clickRail(); other.getState().pyramid.text = 'Remote arrives while opening'; await other.config.bridge.flushState(other.getState());
  a.activateReader(); const reader = a.Zotero.ReadingFlow.inspect(a.host).find(handle => handle.kind === 'reader'), app = reader.frame.contentWindow.ReadingFlowApp;
  let resumeOpening, signalLoad; const blocked = new Promise(resolve => { resumeOpening = resolve; }), loading = new Promise(resolve => { signalLoad = resolve; }), loadConfig = app.loadConfig.bind(app);
  app.loadConfig = async config => { signalLoad(); await blocked; return loadConfig(config); };
  const opening = a.Zotero.ReadingFlow.openItem(a.parent.id); await loading;
  const ids = transferNotes(b, a, note => a.sync.decodeNote(note.html)?.deviceID === b.prefs.get(a.sync.DEVICE_PREF)); await a.emitItemChange(ids);
  await waitUntil(() => reader.syncRefreshAfterOpen, 'an in-progress sidebar opening must retain the pending notification');
  resumeOpening(); await opening; await waitUntil(() => reader.getState()?.pyramid.text === 'Remote arrives while opening', 'pending notification must be replayed after sidebar initialization');
  assert.equal(reader.config.syncConflict, false); assert.equal(a.errors.length, 0);
});

test('concurrent first opens of one independent note publish only the latest library or reader focus', async t => {
  const h = harness(), note = await standaloneNote(h, 'Shared independent prose');
  const legacy = h.core.createSession(h.identity(note)); legacy.noteKey = note.key; legacy.pyramid.text = 'Previously saved local tree'; h.files.set(h.draftName(note), JSON.stringify(legacy));
  await h.start(); t.after(() => h.stop()); await h.Zotero.ReadingFlow.maintenance();
  let releaseSearches, firstDiscovered, bothDiscovered, searches = 0;
  const barrier = new Promise(resolve => { releaseSearches = resolve; }), firstDiscovery = new Promise(resolve => { firstDiscovered = resolve; }), bothDiscoveries = new Promise(resolve => { bothDiscovered = resolve; });
  const search = h.Zotero.Search.prototype.search;
  h.Zotero.Search.prototype.search = async function () {
    const result = await search.call(this);
    if (++searches <= 2) { if (searches === 1) firstDiscovered(); else bothDiscovered(); await barrier; }
    return result;
  };
  const libraryOpen = h.Zotero.ReadingFlow.openItem(note.id); await firstDiscovery;
  h.activateReader(note); const readerOpen = h.Zotero.ReadingFlow.openItem(note.id); await bothDiscoveries; releaseSearches();
  const [obsolete, focused] = await Promise.all([libraryOpen, readerOpen]);
  assert.equal(obsolete, null); assert.equal(focused.kind, 'reader'); assert.equal(focused.note, note); assert.equal(focused.getState().pyramid.text, 'Previously saved local tree');
  assert.equal(h.Zotero.ReadingFlow.inspect(h.host).find(handle => handle.kind === 'library').config, null);
  assert.equal(h.notes.filter(value => h.sync.decodeNote(value.html)?.kind === 'head').length, 0); assert.equal(h.transportWrites.length, 1); assert.equal(h.errors.length, 0); assert.equal(h.proseNotes().length, 1);
  focused.getState().pyramid.text = 'Newest focused edit'; await focused.config.bridge.flushState(focused.getState());
  h.host.Zotero_Tabs.select('zotero-pane'); const returned = await h.Zotero.ReadingFlow.openItem(note.id);
  assert.equal(returned.kind, 'library'); assert.equal(returned.getState().pyramid.text, 'Newest focused edit'); assert.equal(h.durable(note).pyramid.text, 'Newest focused edit');
  assert.equal(h.notes.filter(value => h.sync.decodeNote(value.html)?.kind === 'head').length, 0); assert.equal(h.transportWrites.length, 2); assert.equal(h.errors.length, 0); assert.equal(note.html, '<p>Shared independent prose</p>');
});

test('managed data containers and their attachments cannot become reading owners', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop());
  h.parent.managedData = true;
  await assert.rejects(h.Zotero.ReadingFlow.openItem(h.parent.id), /文献条目/);
  await assert.rejects(h.Zotero.ReadingFlow.openItem(h.attachment.id), /文献条目/);
  assert.equal(h.notes.length, 0); assert.equal(h.transportWrites.length, 0);
});

test('a missing data file requests a targeted download and refreshes the preserved sidebar when it arrives', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); const shown = await h.clickRail();
  shown.getState().pyramid.text = 'Original local reasoning'; await shown.config.bridge.flushState(shown.getState());
  const read = h.fileStore.read.bind(h.fileStore); let missing = true, requests = 0, completeDownload;
  const downloading = new Promise(resolve => { completeDownload = resolve; });
  h.fileStore.read = async id => { const result = await read(id); return { ...result, pending: missing ? [{ key: 'REMOTE01', reason: 'missing' }] : [] }; };
  h.fileStore.requestDownloads = async id => { assert.equal(id, 1); requests++; await downloading; missing = false; return [{ key: 'REMOTE01', downloaded: true }]; };
  await h.emitItemChange([h.parent.id]);
  await waitUntil(() => shown.config.syncPending, 'missing bytes must preserve the existing tree as read-only');
  assert.equal(shown.getState().pyramid.text, 'Original local reasoning'); assert.equal(requests, 1);
  completeDownload(); await waitUntil(() => !shown.config.syncPending, 'download completion must refresh the native sidebar');
  assert.equal(shown.getState().pyramid.text, 'Original local reasoning'); assert.equal(h.errors.length, 0);
});

test('shutdown does not wait for a native network download and its later completion cannot restart plugin work', async () => {
  const h = harness(); await h.start(); const shown = await h.clickRail();
  const read = h.fileStore.read.bind(h.fileStore); let completeDownload, requested = false;
  const downloading = new Promise(resolve => { completeDownload = resolve; });
  h.fileStore.read = async id => ({ ...await read(id), pending: [{ key: 'REMOTE01', reason: 'missing' }] });
  h.fileStore.requestDownloads = async () => { requested = true; await downloading; return [{ key: 'REMOTE01', downloaded: true }]; };
  await h.emitItemChange([h.parent.id]); await waitUntil(() => requested && shown.config.syncPending);
  let stopped = false; const stopping = h.stop().then(() => { stopped = true; });
  await waitUntil(() => stopped, 'native network requests must not block shutdown'); await stopping;
  const writes = h.writes.length, transportWrites = h.transportWrites.length, dbCalls = h.dbCalls.length;
  completeDownload(); await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(h.writes.length, writes); assert.equal(h.transportWrites.length, transportWrites); assert.equal(h.dbCalls.length, dbCalls); assert.equal(h.observers.size, 0); assert.equal(h.errors.length, 0);
});

test('a Zotero sync finish retries data-file maintenance without creating new data notes', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); await h.Zotero.ReadingFlow.maintenance();
  const search = h.Zotero.Search.prototype.search; let maintenanceRuns = 0;
  h.Zotero.Search.prototype.search = async function () { if (this.conditions.some(value => value.condition === 'note' && value.value === 'KIND:head')) maintenanceRuns++; return search.call(this); };
  await h.Zotero.Notifier.trigger('finish', 'sync', [1]);
  await waitUntil(() => maintenanceRuns === 1, 'the SDK sync completion event must retry archival after upload');
  assert.equal(h.notes.length, 0); assert.equal(h.errors.length, 0);
});

test('an upload finishing during data-file maintenance is retried after that pass completes', async t => {
  const h = harness(); await h.start(); t.after(() => h.stop()); await h.Zotero.ReadingFlow.maintenance();
  const search = h.Zotero.Search.prototype.search; let runs = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  h.Zotero.Search.prototype.search = async function () {
    if (this.conditions.some(value => value.condition === 'note' && value.value === 'KIND:head')) { runs++; if (runs === 1) await blocked; }
    return search.call(this);
  };
  const pass = h.Zotero.ReadingFlow.maintenance(); await waitUntil(() => runs === 1);
  await h.Zotero.Notifier.trigger('finish', 'sync', [1]); release(); await pass;
  await waitUntil(() => runs === 2, 'an upload completion cannot be swallowed by the preceding migration pass');
  assert.equal(h.errors.length, 0);
});
