/* SDK-shaped Zotero harness with real isolated attachment files, never a user library. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const core = require('../content/core.js');
const sync = require('../content/sync.js');
const clone = value => JSON.parse(JSON.stringify(value));

function device(t, { libraryID = 1, name = 'A' } = {}) {
  const parent = path.join(__dirname, '..', 'tmp', 'file-sync-tests'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'readingflow-file-tests-'));
  t.after(() => { assert.ok(path.basename(root).startsWith('readingflow-file-tests-')); fs.rmSync(root, { recursive: true, force: true }); });
  const items = new Map(), prefs = new Map([[sync.DEVICE_PREF, 'device-' + name]]), writes = [], transactions = [], trashCalls = [];
  const library = { libraryID, editable: true, filesEditable: true, libraryType: 'user' };
  let nextID = libraryID * 10000, writeCount = 0, failAt = 0, fileWrites = 0, failFileAt = 0, failTrash = false;
  const serial = item => { const result = {}; for (const [key, value] of Object.entries(item)) if (typeof value !== 'function') result[key] = clone(value); return result; };
  const md5 = file => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  class Item {
    constructor(type) { this.itemType = type; this.libraryID = libraryID; this.tags = []; this.fields = {}; this.deleted = false; this.synced = false; }
    isNote() { return this.itemType === 'note'; }
    isAttachment() { return this.itemType === 'attachment'; }
    isRegularItem() { return !this.isNote() && !this.isAttachment(); }
    isFileAttachment() { return this.isAttachment(); }
    isStoredFileAttachment() { return this.isAttachment() && this.attachmentLinkMode === 0; }
    setNote(html) { this.html = html; } getNote() { return this.html || ''; }
    setField(field, value) { this.fields[field] = value; } getField(field) { return this.fields[field] || ''; }
    addTag(tag) { if (!this.tags.includes(tag)) this.tags.push(tag); }
    hasTag(tag) { return this.tags.includes(tag); }
    getTags() { return this.tags.map(tag => ({ tag, type: 0 })); }
    setTags(tags) { this.tags = tags.map(tag => typeof tag === 'string' ? tag : tag.tag); }
    getAttachments() { return [...items.values()].filter(item => item.parentID === this.id && item.isAttachment() && !item.deleted).map(item => item.id); }
    getNotes() { return [...items.values()].filter(item => item.parentID === this.id && item.isNote() && !item.deleted).map(item => item.id); }
    async getFilePathAsync() { return this.filePath || false; }
    async loadDataType() {}
    async save() {
      if (++writeCount === failAt) throw new Error('Simulated Zotero transaction failure');
      if (!this.id) { this.id = ++nextID; this.key = name + String(this.id).padStart(7, '0'); }
      items.set(this.id, this); writes.push({ key: this.key, data: serial(this) }); return this.id;
    }
    async saveTx() { return Zotero.DB.executeTransaction(() => this.save()); }
  }
  class Search {
    constructor() { this.conditions = []; }
    addCondition(...args) { this.conditions.push(args); }
    async search() {
      return [...items.values()].filter(item => this.libraryID === undefined || item.libraryID === this.libraryID).filter(item => this.conditions.every(([field, operator, value]) => {
        if (field === 'deleted') return operator === 'false' ? !item.deleted : !!item.deleted;
        if (field === 'itemType') return item.itemType === value;
        if (field === 'note') return item.isNote() && item.getNote().includes(value);
        if (field === 'tag') return item.tags.includes(value);
        if (field === 'title' || field === 'extra') return operator === 'is' ? item.getField(field) === value : item.getField(field).includes(value);
        if (field === 'libraryID') return item.libraryID === Number(value);
        throw new Error('Unexpected Search condition: ' + field);
      })).map(item => item.id);
    }
  }
  const IOUtils = {
    async exists(file) { return fs.existsSync(file); },
    async stat(file) { const value = fs.statSync(file); return { size: value.size, type: value.isDirectory() ? 'directory' : 'regular', lastModified: value.mtimeMs }; },
    async readUTF8(file) { return fs.readFileSync(file, 'utf8'); },
    async writeUTF8(file, text, options = {}) {
      if (++fileWrites === failFileAt) throw new Error('Simulated atomic file write failure');
      if (options.tmpPath) { fs.writeFileSync(options.tmpPath, text, 'utf8'); fs.renameSync(options.tmpPath, file); }
      else fs.writeFileSync(file, text, 'utf8');
      return Buffer.byteLength(text);
    },
    async makeDirectory(dir) { fs.mkdirSync(dir, { recursive: true }); },
    async remove(file, options = {}) { fs.rmSync(file, { recursive: !!options.recursive, force: !!options.ignoreAbsent }); }
  };
  const Zotero = {
    Item, Search, Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) }, Utilities: { randomString: count => crypto.randomBytes(count).toString('hex').slice(0, count), Internal: { md5: text => crypto.createHash('md5').update(text, 'utf8').digest('hex'), md5Async: async file => md5(typeof file === 'string' ? file : file.path) } },
    DataDirectory: { dir: root }, File: { pathToFile: file => ({ path: file }) },
    Libraries: { get: id => id === libraryID ? library : null, getAll: () => [library] },
    Items: {
      get: id => Array.isArray(id) ? id.map(value => items.get(value)) : items.get(id),
      getAsync: async id => Array.isArray(id) ? id.map(value => items.get(value)) : items.get(id),
      getByLibraryAndKeyAsync: async (id, key) => [...items.values()].find(item => item.libraryID === id && item.key === key) || null,
      getAll: async (id = libraryID) => [...items.values()].filter(item => item.libraryID === id && !item.deleted),
      async trash(ids) {
        if (failTrash) throw new Error('Simulated trash transaction failure');
        for (const id of [].concat(ids)) { const item = items.get(id); assert.ok(item); item.deleted = true; await item.save(); trashCalls.push(item.key); }
      },
      async trashTx(ids) { return Zotero.DB.executeTransaction(() => this.trash(ids)); }
    },
    Attachments: {
      LINK_MODE_IMPORTED_FILE: 0, SYNC_STATE_TO_UPLOAD: 0, SYNC_STATE_IN_SYNC: 2,
      async importFromFile({ file, parentItemID, title, contentType, libraryID: targetLibrary }) {
        const source = typeof file === 'string' ? file : file.path;
        const parent = items.get(parentItemID); assert.ok(parent && parent.isRegularItem(), 'stored file belongs to a native container item');
        const item = new Item('attachment'); item.libraryID = targetLibrary || parent.libraryID; item.parentID = parent.id; item.attachmentLinkMode = 0; item.attachmentContentType = contentType; item.attachmentSyncState = 0; item.setField('title', title);
        await item.save(); const dir = path.join(root, 'storage', item.key); fs.mkdirSync(dir, { recursive: true }); item.filePath = path.join(dir, path.basename(source)); fs.copyFileSync(source, item.filePath); return item;
      }
    },
    Sync: { Storage: { Local: { SYNC_STATE_TO_UPLOAD: 0, SYNC_STATE_IN_SYNC: 2 } } },
    DB: { async executeTransaction(callback) {
      const before = new Map([...items].map(([id, item]) => [id, { item, data: serial(item) }])); transactions.push('begin');
      try { const result = await callback(); transactions.push('commit'); return result; }
      catch (error) {
        items.clear(); for (const [id, { item, data }] of before) { for (const key of Object.keys(item)) delete item[key]; Object.assign(item, data); items.set(id, item); }
        transactions.push('rollback'); throw error;
      }
    } }
  };
  const PathUtils = { join: path.join, parent: path.dirname, filename: path.basename };
  function addOwner(key = 'PAPER001', kind = 'item') {
    const owner = new Item(kind === 'note' ? 'note' : 'journalArticle');
    owner.id = ++nextID; owner.key = key;
    if (owner.isNote()) owner.html = '<p>Original independent prose</p>';
    else owner.setField('title', 'Original paper');
    items.set(owner.id, owner); return owner;
  }
  const owner = addOwner();
  const identity = item => ({ libraryID, key: item.key, title: 'Device ' + name });
  const legacyNotes = () => [...items.values()].filter(item => item.isNote() && sync.decodeNote(item.getNote()));
  const nativeNotes = () => [...items.values()].filter(item => item.isNote() && !item.deleted);
  const attachments = () => [...items.values()].filter(item => item.isAttachment() && !item.deleted);
  const containers = () => [...items.values()].filter(item => item.isRegularItem() && item.getField('extra').split(/\r?\n/).includes('READING_FLOW_DATA_CONTAINER_V2') && item.tags.includes('Reading flow · data') && !item.deleted);
  const d = { Zotero, IOUtils, PathUtils, root, items, prefs, writes, transactions, trashCalls, library, owner, addOwner, identity, legacyNotes, nativeNotes, attachments, containers, md5,
    failSaveAfter(count) { failAt = writeCount + count; },
    failFileWriteAfter(count) { failFileAt = fileWrites + count; },
    failTrash(value = true) { failTrash = value; },
    uploadAll() { for (const item of attachments()) { item.synced = true; item.attachmentSyncState = 2; if (item.filePath && fs.existsSync(item.filePath)) item.attachmentSyncedHash = md5(item.filePath); } },
    receiveWriter(source) {
      this.receive(source, { filter: item => !item.isAttachment() || require('../content/file-sync.js').decodeJournal(fs.readFileSync(item.filePath, 'utf8')).writerID === source.fileStore.writerID });
    },
    receive(source, { files = true, filter = () => true } = {}) {
      // Only metadata and native stored files cross devices. Plugin prefs, draft cache and lease IDs never do.
      const managed = [...source.items.values()].filter(item => source.containers().includes(item) || item.isAttachment() || source.legacyNotes().includes(item)).filter(filter);
      for (const original of managed) {
        let target = [...items.values()].find(item => item.key === original.key && item.libraryID === libraryID);
        if (!target) { target = new Item(original.itemType); target.id = ++nextID; items.set(target.id, target); }
        const id = target.id, originalParent = original.parentID ? source.items.get(original.parentID) : null;
        Object.assign(target, serial(original), { id, libraryID });
        target.parentID = originalParent ? [...items.values()].find(item => item.key === originalParent.key && item.libraryID === libraryID)?.id : null;
        if (original.isAttachment()) {
          target.filePath = path.join(root, 'storage', original.key, path.basename(original.filePath || 'reading-flow.json'));
          if (files && original.filePath && fs.existsSync(original.filePath)) { fs.mkdirSync(path.dirname(target.filePath), { recursive: true }); fs.copyFileSync(original.filePath, target.filePath); }
        }
      }
    },
    restart() { this.fileStore = require('../content/file-sync.js').create({ Zotero, IOUtils, PathUtils }); this.store = sync.create({ Zotero, core, fileStore: this.fileStore }); return this.store; }
  };
  d.restart(); return d;
}
function stateFor(d, owner = d.owner, text = 'A conclusion') {
  const state = core.createSession(d.identity(owner)); state.pyramid.text = text; state.noteKey = owner.isNote() ? owner.key : 'PROSE001';
  state.pyramid.boldRanges = [{ start: 0, end: 1 }]; state.framing.situation = 'Background 背景'; state.framing.complication = 'Conflict 冲突';
  state.framing.situationBoldRanges = [{ start: 0, end: 10 }]; state.framing.complicationBoldRanges = [{ start: 9, end: 11 }]; state.pyramidFontSize = 24;
  core.addNode(state, state.pyramid.id, 'child'); state.pyramid.children[0].text = 'Evidence 证据'; return state;
}
async function publish(d, state = stateFor(d), owner = d.owner) {
  const loaded = await d.store.load(d.identity(owner)); const saved = await d.store.save(d.identity(owner), state, loaded.token);
  return { state, saved, cache: { ...clone(state), readingFlowSync: saved.cacheMeta } };
}
function recordFor(d, state = stateFor(d), { owner = d.owner, deviceID = 'device-A', revision = crypto.randomUUID(), clock = { [deviceID]: 1 } } = {}) {
  return { format: sync.FORMAT, kind: 'head', ownerKey: owner.key, ownerKind: owner.isNote() ? 'note' : 'item', deviceID, revision, clock, state, hash: sync.stateHash(state) };
}
async function addLegacy(d, state = stateFor(d), { owner = d.owner, deviceID = 'legacy-A', revision = crypto.randomUUID(), clock = { [deviceID]: 1 } } = {}) {
  const data = sync.splitPayload(state), base = { format: sync.FORMAT, ownerKey: owner.key, ownerKind: owner.isNote() ? 'note' : 'item', deviceID, revision }, notes = [];
  const make = async envelope => { const note = new d.Zotero.Item('note'); if (!owner.isNote()) note.parentID = owner.id; note.addTag(sync.TAG); note.setNote(sync.encodeNote(envelope)); await note.save(); notes.push(note); return note; };
  for (let index = 0; data.parts.length > 1 && index < data.parts.length; index++) await make({ ...base, kind: 'part', index, count: data.parts.length, data: data.parts[index] });
  const head = await make({ ...base, kind: 'head', clock, hash: data.hash, length: data.length, ...(data.parts.length === 1 ? { data: data.parts[0] } : { partKeys: notes.map(note => note.key) }) });
  return { head, notes, state };
}
module.exports = { device, stateFor, publish, addLegacy, recordFor, core, sync, clone };
