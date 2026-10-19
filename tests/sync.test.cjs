/* Independent devices exchange only native Zotero records, never plugin files or preferences. */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../content/core.js');
const sync = require('../content/sync.js');

const clone = value => JSON.parse(JSON.stringify(value));
function device({ libraryID = 1, name = 'A' } = {}) {
  const items = new Map(), prefs = new Map([[sync.DEVICE_PREF, 'device-' + name]]), writes = [], transactions = [];
  const library = { editable: true };
  let nextID = libraryID * 10000, writeCount = 0, failAt = 0;
  class Note {
    constructor(type) { assert.equal(type, 'note'); this.libraryID = libraryID; this.tags = []; this.deleted = false; }
    isNote() { return true; } isRegularItem() { return false; }
    setNote(html) { this.html = html; } getNote() { return this.html || ''; }
    addTag(tag) { if (!this.tags.includes(tag)) this.tags.push(tag); }
    async save() {
      if (++writeCount === failAt) throw new Error('Simulated Zotero transaction failure');
      if (!this.id) { this.id = ++nextID; this.key = name + String(this.id).padStart(7, '0'); }
      items.set(this.id, this); writes.push({ key: this.key, html: this.html }); return this.id;
    }
    async saveTx() { return Zotero.DB.executeTransaction(() => this.save()); }
  }
  class Search {
    constructor() { this.conditions = []; }
    addCondition(...args) { this.conditions.push(args); }
    async search() {
      return [...items.values()].filter(item => item.libraryID === this.libraryID && !item.deleted && item.isNote()).filter(item => this.conditions.every(([field, operator, value]) => {
        if (field === 'deleted') return operator === 'false' ? !item.deleted : !!item.deleted;
        if (field === 'itemType') return value === 'note';
        if (field === 'note') return item.getNote().includes(value);
        if (field === 'tag') return item.tags.includes(value);
        throw new Error('Unexpected Search condition: ' + field);
      })).map(item => item.id);
    }
  }
  const serialize = item => ({ id: item.id, key: item.key, libraryID: item.libraryID, parentID: item.parentID, deleted: item.deleted, html: item.html, tags: item.tags ? [...item.tags] : undefined });
  const Zotero = {
    Item: Note, Search, Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) }, Utilities: { randomString: count => name.repeat(count) },
    Libraries: { get: id => id === libraryID ? library : null },
    Items: { getAsync: async id => Array.isArray(id) ? id.map(value => items.get(value)) : items.get(id), getByLibraryAndKeyAsync: async (id, key) => [...items.values()].find(item => item.libraryID === id && item.key === key) || null },
    DB: { async executeTransaction(callback) {
      const before = new Map([...items].map(([id, item]) => [id, { item, data: serialize(item) }])); transactions.push('begin');
      try { const result = await callback(); transactions.push('commit'); return result; }
      catch (error) { items.clear(); for (const [id, { item, data }] of before) { Object.assign(item, data); items.set(id, item); } transactions.push('rollback'); throw error; }
    } }
  };
  function addOwner(key = 'PAPER001', kind = 'item') {
    let owner;
    if (kind === 'note') { owner = new Note('note'); owner.html = '<p>Original independent prose</p>'; }
    else owner = { isNote: () => false, isRegularItem: () => true, deleted: false };
    Object.assign(owner, { id: ++nextID, key, libraryID }); items.set(owner.id, owner); return owner;
  }
  const owner = addOwner();
  const identity = item => ({ libraryID, key: item.key, title: 'Device ' + name });
  const dataNotes = () => [...items.values()].filter(item => item.isNote() && sync.decodeNote(item.getNote()));
  const heads = () => dataNotes().filter(item => sync.decodeNote(item.getNote()).kind === 'head');
  return { Zotero, items, prefs, writes, transactions, library, owner, addOwner, identity, dataNotes, heads, store: sync.create({ Zotero, core }),
    failSaveAfter(count) { failAt = writeCount + count; },
    receive(source, { filter = () => true } = {}) {
      // This deliberately copies no Reading flow files, prefs, device IDs, or numeric IDs.
      for (const note of source.dataNotes().filter(filter)) {
        let target = [...items.values()].find(item => item.key === note.key && item.libraryID === libraryID);
        if (!target) { target = new Note('note'); target.id = ++nextID; items.set(target.id, target); }
        const parentKey = note.parentID ? source.items.get(note.parentID).key : null;
        Object.assign(target, { key: note.key, libraryID, html: note.html, tags: [...note.tags], deleted: note.deleted,
          parentID: parentKey ? [...items.values()].find(item => item.key === parentKey && item.libraryID === libraryID)?.id : null });
      }
    }
  };
}
function stateFor(d, owner = d.owner, text = 'A conclusion') {
  const state = core.createSession(d.identity(owner)); state.pyramid.text = text; state.noteKey = owner.isNote() ? owner.key : 'PROSE001';
  state.pyramid.boldRanges = [{ start: 0, end: 1 }]; state.framing.situation = 'Background 背景'; state.framing.complication = 'Conflict 冲突';
  core.addNode(state, state.pyramid.id, 'child'); state.pyramid.children[0].text = 'Evidence 证据'; return state;
}
async function publish(d, state = stateFor(d), owner = d.owner) {
  const loaded = await d.store.load(d.identity(owner)); const saved = await d.store.save(d.identity(owner), state, loaded.token);
  return { state, saved, cache: { ...clone(state), readingFlowSync: saved.cacheMeta } };
}

test('sync codec preserves Unicode and HTML-like text while producing bounded ordinary note HTML', () => {
  const d = device(), state = stateFor(d, d.owner, '中文 😀 <script>alert("x")</script> & text');
  assert.deepEqual(sync.decodePayload(sync.encodePayload(state)), state);
  const envelope = { format: sync.FORMAT, kind: 'head', ownerKey: 'PAPER001', data: '<>&" 中文' }, html = sync.encodeNote(envelope);
  assert.deepEqual(sync.decodeNote(html), envelope); assert.ok(html.length < sync.MAX_NOTE); assert.doesNotMatch(html, /<script>/);
  assert.equal(sync.decodeNote('<p>Ordinary user note</p>'), null);
  assert.throws(() => sync.decodePayload('not valid base64!'), /损坏/);
});

test('a fresh second device reconstructs the editable pyramid using only synced native records and portable keys', async () => {
  const a = device(), b = device({ libraryID: 27, name: 'B' }), { state } = await publish(a, { ...stateFor(a), pyramidFontSize: 24 }); b.receive(a);
  assert.notEqual(a.owner.id, b.owner.id); assert.notEqual(a.owner.libraryID, b.owner.libraryID);
  const loaded = await b.store.load(b.identity(b.owner)); assert.equal(loaded.conflict, false); assert.equal(loaded.hasRemote, true);
  assert.equal(loaded.state.item.libraryID, 27); assert.equal(loaded.state.item.key, a.owner.key); assert.equal(loaded.state.pyramid.text, state.pyramid.text);
  assert.deepEqual(loaded.state.pyramid.boldRanges, state.pyramid.boldRanges); assert.deepEqual(loaded.state.framing, state.framing);
  assert.equal(loaded.state.pyramidFontSize, 24, 'font size belongs to synced note data, not this device preferences or files');
  assert.equal(loaded.state.pyramid.children[0].text, 'Evidence 证据'); assert.equal(b.writes.length, 0);
  assert.equal(b.prefs.get(sync.DEVICE_PREF), 'device-B');
});

test('concurrent size-only changes preserve both reading layouts until an explicit version is adopted', async () => {
  const a = device(), b = device({ name: 'B' }), first = await publish(a); b.receive(a);
  const baseB = await b.store.load(b.identity(b.owner)), stateA = clone(first.state);
  stateA.pyramidFontSize = 24;
  baseB.state.pyramidFontSize = 32;
  await a.store.save(a.identity(a.owner), stateA, first.saved.token);
  await b.store.save(b.identity(b.owner), baseB.state, baseB.token);
  a.receive(b, { filter: note => sync.decodeNote(note.getNote()).deviceID === 'device-B' }); b.receive(a);
  const conflict = await a.store.load(a.identity(a.owner));
  assert.equal(conflict.conflict, true);
  assert.deepEqual(new Set(conflict.versions.map(value => value.state.pyramidFontSize)), new Set([24, 32]));
  assert.deepEqual(new Set(conflict.versions.map(value => value.state.pyramid.text)), new Set([first.state.pyramid.text]));
  const count = a.writes.length;
  await assert.rejects(() => a.store.save(a.identity(a.owner), conflict.state, conflict.token), /多个版本|选择版本/);
  assert.equal(a.writes.length, count);
  const chosen = conflict.versions.find(value => value.state.pyramidFontSize === 32);
  await a.store.save(a.identity(a.owner), chosen.state, conflict.token, { resolve: true });
  b.receive(a);
  const resolved = await b.store.load(b.identity(b.owner));
  assert.equal(resolved.conflict, false);
  assert.equal(resolved.state.pyramidFontSize, 32);
  assert.deepEqual(resolved.state.pyramid.boldRanges, first.state.pyramid.boldRanges);
});

test('a causally newer remote edit replaces a clean local cache regardless of wall-clock timestamps', async () => {
  const a = device(), b = device({ name: 'B' }), first = await publish(a); b.receive(a);
  const loadedB = await b.store.load(b.identity(b.owner)); loadedB.state.pyramid.text = 'Second device edit'; loadedB.state.updatedAt = '1900-01-01T00:00:00.000Z';
  await b.store.save(b.identity(b.owner), loadedB.state, loadedB.token); a.receive(b);
  first.cache.updatedAt = '2999-01-01T00:00:00.000Z'; const returned = await a.store.load(a.identity(a.owner), first.cache);
  assert.equal(returned.conflict, false); assert.equal(returned.needsPublish, false); assert.equal(returned.state.pyramid.text, 'Second device edit');
});

test('concurrent offline devices preserve both branches and require explicit resolution before a new shared version', async () => {
  const a = device(), b = device({ name: 'B' }), first = await publish(a); b.receive(a);
  const baseB = await b.store.load(b.identity(b.owner));
  const stateA = clone(first.state); stateA.pyramid.text = 'Offline A'; await a.store.save(a.identity(a.owner), stateA, first.saved.token);
  const stateB = clone(baseB.state); stateB.pyramid.text = 'Offline B'; await b.store.save(b.identity(b.owner), stateB, baseB.token);
  // B uploads only its own changed records; its cached older A head is unchanged.
  a.receive(b, { filter: note => sync.decodeNote(note.getNote()).deviceID === 'device-B' }); b.receive(a); const conflict = await a.store.load(a.identity(a.owner));
  assert.equal(conflict.conflict, true); assert.deepEqual(new Set(conflict.versions.map(value => value.state.pyramid.text)), new Set(['Offline A', 'Offline B']));
  const count = a.writes.length; await assert.rejects(() => a.store.save(a.identity(a.owner), conflict.state, conflict.token), /多个版本|选择版本/); assert.equal(a.writes.length, count);
  const chosen = conflict.versions.find(value => value.state.pyramid.text === 'Offline B'); await a.store.save(a.identity(a.owner), chosen.state, conflict.token, { resolve: true });
  b.receive(a); const resolved = await b.store.load(b.identity(b.owner)); assert.equal(resolved.conflict, false); assert.equal(resolved.state.pyramid.text, 'Offline B');
});

test('a remote arrival invalidates an old save token rather than overwriting either device', async () => {
  const a = device(), b = device({ name: 'B' }); await publish(a); b.receive(a);
  const openedA = await a.store.load(a.identity(a.owner)), openedB = await b.store.load(b.identity(b.owner));
  openedB.state.pyramid.text = 'Incoming remote'; await b.store.save(b.identity(b.owner), openedB.state, openedB.token); a.receive(b);
  openedA.state.pyramid.text = 'Unsaved local'; const before = a.writes.length;
  await assert.rejects(() => a.store.save(a.identity(a.owner), openedA.state, openedA.token), /另一设备.*已到达/); assert.equal(a.writes.length, before);
  assert.equal((await a.store.load(a.identity(a.owner))).state.pyramid.text, 'Incoming remote');
});

test('large pyramids are split into bounded notes and an incomplete transfer never opens a misleading empty tree', async () => {
  const a = device(), b = device({ name: 'B' }), state = stateFor(a);
  for (let i = 0; i < 20; i++) { const node = core.addNode(state, state.pyramid.id, 'child'); node.text = '中文大数据😀'.repeat(1000); }
  await publish(a, state); const head = a.heads()[0], envelope = sync.decodeNote(head.getNote()); assert.ok(envelope.partKeys.length > 1);
  for (const note of a.dataNotes()) assert.ok(note.getNote().length < sync.MAX_NOTE);
  b.receive(a, { filter: note => note.key !== envelope.partKeys[0] });
  await assert.rejects(() => b.store.load(b.identity(b.owner)), /尚未到齐|损坏/);
  const local = stateFor(b, b.owner, 'Existing local reasoning'), pending = await b.store.load(b.identity(b.owner), local);
  assert.equal(pending.pending, true); assert.equal(pending.state.pyramid.text, 'Existing local reasoning');
  await assert.rejects(() => b.store.save(b.identity(b.owner), pending.state, pending.token), /尚未完整/);
  b.receive(a); const complete = await b.store.load(b.identity(b.owner)); assert.equal(complete.pending, false); assert.equal(complete.state.pyramid.children.length, state.pyramid.children.length);
});

test('legacy local work conflicts with different remote work instead of silently replacing it', async () => {
  const a = device(), b = device({ name: 'B' }); await publish(a); b.receive(a);
  const legacy = stateFor(b, b.owner, 'Old local-only tree'), loaded = await b.store.load(b.identity(b.owner), legacy);
  assert.equal(loaded.conflict, true); assert.equal(loaded.state.pyramid.text, legacy.pyramid.text);
  assert.deepEqual(new Set(loaded.versions.map(value => value.state.pyramid.text)), new Set(['A conclusion', 'Old local-only tree']));
  await assert.rejects(() => b.store.save(b.identity(b.owner), loaded.state, loaded.token), /多个版本/);
});

test('read-only libraries can load synced data without writing new notes or touching the owner prose', async () => {
  const a = device(), b = device({ name: 'B' }); await publish(a); b.receive(a); b.library.editable = false;
  const loaded = await b.store.load(b.identity(b.owner)); assert.equal(loaded.state.pyramid.text, 'A conclusion'); assert.equal(b.writes.length, 0);
  await assert.rejects(() => b.store.save(b.identity(b.owner), loaded.state, loaded.token), /只读/); assert.equal(b.writes.length, 0);
});

test('independent note data syncs beside the same note without changing prose, while moved or trashed owners are rejected', async () => {
  const a = device(), b = device({ name: 'B', libraryID: 8 }), ownerA = a.addOwner('OWNNOTE1', 'note'), ownerB = b.addOwner('OWNNOTE1', 'note');
  const original = ownerA.getNote(); await publish(a, stateFor(a, ownerA, 'Independent reasoning'), ownerA); b.receive(a);
  assert.equal(ownerA.getNote(), original); const loaded = await b.store.load(b.identity(ownerB)); assert.equal(loaded.state.noteKey, 'OWNNOTE1'); assert.equal(loaded.state.pyramid.text, 'Independent reasoning');
  assert.equal(ownerB.getNote(), '<p>Original independent prose</p>'); assert.ok(b.dataNotes().every(note => !note.parentID));
  ownerB.parentID = b.owner.id; await assert.rejects(() => b.store.load(b.identity(ownerB)), /关联已改变/);
  ownerB.parentID = null; ownerB.deleted = true; await assert.rejects(() => b.store.save(b.identity(ownerB), loaded.state, loaded.token), /已移除/);
});

test('metadata position and owner keys prevent another paper from adopting a reparented sync record', async () => {
  const a = device(), { state } = await publish(a), another = a.addOwner('PAPER002');
  for (const note of a.dataNotes()) { note.parentID = another.id; note.tags = []; }
  const different = await a.store.load(a.identity(another)); assert.equal(different.hasRemote, false); assert.notEqual(different.state.pyramid.text, state.pyramid.text);
  const original = await a.store.load(a.identity(a.owner)); assert.equal(original.hasRemote, false);
});

test('same-content saves and local migration publish once without growing metadata notes on every reopen', async () => {
  const a = device(), legacy = stateFor(a), first = await a.store.load(a.identity(a.owner), legacy); assert.equal(first.needsPublish, true);
  const saved = await a.store.save(a.identity(a.owner), first.state, first.token), count = a.writes.length;
  const cached = { ...clone(first.state), readingFlowSync: saved.cacheMeta }, reopened = await a.store.load(a.identity(a.owner), cached);
  assert.equal(reopened.needsPublish, false); assert.equal(reopened.conflict, false);
  await a.store.save(a.identity(a.owner), reopened.state, reopened.token); assert.equal(a.writes.length, count);
  a.heads()[0].tags = []; assert.equal((await a.store.load(a.identity(a.owner))).state.pyramid.text, legacy.pyramid.text);
});

test('a failed multi-note save rolls back its new parts and preserves the previous readable head', async () => {
  const a = device(), first = await publish(a), original = a.heads()[0].getNote(), state = clone(first.state);
  for (let i = 0; i < 12; i++) { const node = core.addNode(state, state.pyramid.id, 'child'); node.text = 'Long quoted evidence'.repeat(1000); }
  const before = a.dataNotes().length; a.failSaveAfter(2);
  await assert.rejects(() => a.store.save(a.identity(a.owner), state, first.saved.token), /transaction failure/);
  assert.equal(a.dataNotes().length, before); assert.equal(a.heads()[0].getNote(), original); assert.equal(a.transactions.at(-1), 'rollback');
  assert.equal((await a.store.load(a.identity(a.owner))).state.pyramid.text, first.state.pyramid.text);
});

test('a malformed or truncated metadata payload is detected without discarding an existing local version', async () => {
  const a = device(), first = await publish(a), head = a.heads()[0], envelope = sync.decodeNote(head.getNote());
  envelope.data = envelope.data.slice(0, -4); head.setNote(sync.encodeNote(envelope));
  await assert.rejects(() => a.store.load(a.identity(a.owner)), /尚未到齐|损坏/);
  const safe = await a.store.load(a.identity(a.owner), first.cache); assert.equal(safe.pending, true); assert.equal(safe.state.pyramid.text, first.state.pyramid.text);
  assert.equal(a.heads()[0], head);
});
