/* Devices exchange Zotero item metadata and stored attachment files only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { device, stateFor, publish, addLegacy, core, sync, clone } = require('./file-sync-harness.cjs');

test('legacy note codec remains a bounded, lossless migration reader', t => {
  const d = device(t), state = stateFor(d, d.owner, '中文 😀 <script>alert("x")</script> & text');
  assert.deepEqual(sync.decodePayload(sync.encodePayload(state)), state);
  const envelope = { format: sync.FORMAT, kind: 'head', ownerKey: 'PAPER001', data: '<>&" 中文' }, html = sync.encodeNote(envelope);
  assert.deepEqual(sync.decodeNote(html), envelope); assert.ok(html.length < sync.MAX_NOTE); assert.doesNotMatch(html, /<script>/);
  assert.equal(sync.decodeNote('<p>Ordinary user note</p>'), null);
  assert.throws(() => sync.decodePayload('not valid base64!'), /损坏/);
});

test('all owners share a central native item and one current writer file without creating sync notes', async t => {
  const d = device(t), second = d.addOwner('PAPER002'), note = d.addOwner('OWNNOTE1', 'note'), original = note.getNote();
  await publish(d, stateFor(d, d.owner, 'First paper'));
  await publish(d, stateFor(d, second, 'Second paper'), second);
  await publish(d, stateFor(d, note, 'Independent reasoning'), note);
  assert.equal(d.containers().length, 1); assert.equal(d.containers()[0].getField('title'), 'Reading flow 数据');
  assert.equal(d.attachments().length, 1); assert.equal(d.legacyNotes().length, 0);
  assert.equal(d.nativeNotes().length, 1); assert.equal(note.getNote(), original);
  const records = (await d.fileStore.read(1)).records.map(value => value.record);
  assert.deepEqual(new Set(records.map(record => record.ownerKey)), new Set(['PAPER001', 'PAPER002', 'OWNNOTE1']));
  for (const [owner, text] of [[d.owner, 'First paper'], [second, 'Second paper'], [note, 'Independent reasoning']]) {
    assert.equal((await d.store.load(d.identity(owner))).state.pyramid.text, text);
  }
});

test('a cold device restores editable state from native central attachments with different local numeric IDs', async t => {
  const a = device(t), b = device(t, { name: 'B', libraryID: 27 }), { state } = await publish(a); a.uploadAll(); b.receive(a);
  assert.notEqual(a.owner.id, b.owner.id); assert.notEqual(a.root, b.root);
  const loaded = await b.store.load(b.identity(b.owner));
  assert.equal(loaded.hasRemote, true); assert.equal(loaded.conflict, false); assert.equal(loaded.pending, false);
  assert.equal(loaded.state.item.libraryID, 27); assert.equal(loaded.state.item.key, a.owner.key); assert.equal(loaded.state.pyramid.text, state.pyramid.text);
  assert.deepEqual(loaded.state.pyramid.boldRanges, state.pyramid.boldRanges); assert.deepEqual(loaded.state.framing, state.framing);
  assert.equal(loaded.state.pyramidFontSize, 24); assert.equal(loaded.state.pyramid.children[0].text, 'Evidence 证据');
  assert.equal(b.writes.length, 0); assert.equal(b.prefs.get(sync.DEVICE_PREF), 'device-B');
});

test('concurrent offline central files preserve both branches until explicit conflict resolution', async t => {
  const a = device(t), b = device(t, { name: 'B' }), first = await publish(a); b.receive(a);
  const baseB = await b.store.load(b.identity(b.owner)), stateA = clone(first.state);
  stateA.pyramid.text = 'Offline A'; baseB.state.pyramid.text = 'Offline B';
  await a.store.save(a.identity(a.owner), stateA, first.saved.token);
  await b.store.save(b.identity(b.owner), baseB.state, baseB.token);
  const remoteA = a.attachments().find(item => item.key === b.attachments().find(item => item.key !== a.attachments()[0].key)?.key);
  assert.equal(remoteA, undefined, 'A has not seen the other writer yet');
  a.receiveWriter(b); b.receiveWriter(a);
  const conflict = await a.store.load(a.identity(a.owner)); assert.equal(conflict.conflict, true);
  assert.deepEqual(new Set(conflict.versions.map(value => value.state.pyramid.text)), new Set(['Offline A', 'Offline B']));
  const count = a.writes.length;
  await assert.rejects(() => a.store.save(a.identity(a.owner), conflict.state, conflict.token), /多个版本|选择版本/); assert.equal(a.writes.length, count);
  const chosen = conflict.versions.find(value => value.state.pyramid.text === 'Offline B');
  await a.store.save(a.identity(a.owner), chosen.state, conflict.token, { resolve: true }); b.receive(a);
  assert.equal((await b.store.load(b.identity(b.owner))).conflict, false);
  assert.equal((await b.store.load(b.identity(b.owner))).state.pyramid.text, 'Offline B');
});

test('format-only offline edits keep both font and annotation variants', async t => {
  const a = device(t), b = device(t, { name: 'B' }), first = await publish(a); b.receive(a);
  const opened = await b.store.load(b.identity(b.owner)), other = clone(first.state);
  other.pyramidFontSize = 32; opened.state.pyramidFontSize = 18; opened.state.framing.situationBoldRanges = [{ start: 11, end: 13 }];
  await a.store.save(a.identity(a.owner), other, first.saved.token); await b.store.save(b.identity(b.owner), opened.state, opened.token);
  a.receiveWriter(b); const conflict = await a.store.load(a.identity(a.owner)); assert.equal(conflict.conflict, true);
  assert.deepEqual(new Set(conflict.versions.map(value => value.state.pyramidFontSize)), new Set([18, 32]));
  assert.ok(conflict.versions.some(value => JSON.stringify(value.state.framing.situationBoldRanges) === JSON.stringify([{ start: 11, end: 13 }])));
});

test('a causal remote edit supersedes clean cache regardless of wall-clock time', async t => {
  const a = device(t), b = device(t, { name: 'B' }), first = await publish(a); b.receive(a);
  const loaded = await b.store.load(b.identity(b.owner)); loaded.state.pyramid.text = 'Remote descendant'; loaded.state.updatedAt = '1900-01-01T00:00:00.000Z';
  await b.store.save(b.identity(b.owner), loaded.state, loaded.token); a.receive(b);
  first.cache.updatedAt = '2999-01-01T00:00:00.000Z'; const current = await a.store.load(a.identity(a.owner), first.cache);
  assert.equal(current.conflict, false); assert.equal(current.needsPublish, false); assert.equal(current.state.pyramid.text, 'Remote descendant');
});

test('a new remote record invalidates an old token instead of overwriting either device', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await publish(a); b.receive(a);
  const openedA = await a.store.load(a.identity(a.owner)), openedB = await b.store.load(b.identity(b.owner));
  openedB.state.pyramid.text = 'Incoming remote'; await b.store.save(b.identity(b.owner), openedB.state, openedB.token); a.receive(b);
  openedA.state.pyramid.text = 'Unsaved local'; const before = a.writes.length;
  await assert.rejects(() => a.store.save(a.identity(a.owner), openedA.state, openedA.token), /另一设备.*已到达/); assert.equal(a.writes.length, before);
  assert.equal((await a.store.load(a.identity(a.owner))).state.pyramid.text, 'Incoming remote');
});

test('attachment metadata arriving before its file blocks empty state and preserves a local draft', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await publish(a); b.receive(a, { files: false });
  await assert.rejects(() => b.store.load(b.identity(b.owner)), /尚未到齐|损坏|文件/);
  const local = stateFor(b, b.owner, 'Existing local reasoning'), pending = await b.store.load(b.identity(b.owner), local);
  assert.equal(pending.pending, true); assert.equal(pending.state.pyramid.text, local.pyramid.text);
  await assert.rejects(() => b.store.save(b.identity(b.owner), pending.state, pending.token), /尚未完整|文件/);
  b.receive(a); const complete = await b.store.load(b.identity(b.owner)); assert.equal(complete.pending, false); assert.equal(complete.state.pyramid.text, 'A conclusion');
});

test('corrupted file contents are pending and never replace the last usable local tree', async t => {
  const d = device(t), first = await publish(d), item = d.attachments()[0]; fs.writeFileSync(item.filePath, '{"truncated":');
  await assert.rejects(() => d.store.load(d.identity(d.owner)), /尚未到齐|损坏|文件/);
  const safe = await d.store.load(d.identity(d.owner), first.cache); assert.equal(safe.pending, true); assert.equal(safe.state.pyramid.text, first.state.pyramid.text);
  await assert.rejects(() => d.store.save(d.identity(d.owner), safe.state, safe.token), /尚未完整|文件/); assert.equal(fs.readFileSync(item.filePath, 'utf8'), '{"truncated":');
});

test('read-only or file-read-only libraries restore data but refuse new records', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await publish(a); b.receive(a); b.library.editable = false;
  const loaded = await b.store.load(b.identity(b.owner)); assert.equal(loaded.state.pyramid.text, 'A conclusion'); assert.equal(b.writes.length, 0);
  await assert.rejects(() => b.store.save(b.identity(b.owner), loaded.state, loaded.token), /只读|不允许写入/);
  b.library.editable = true; b.library.filesEditable = false; loaded.state.pyramid.text = 'Not permitted';
  await assert.rejects(() => b.store.save(b.identity(b.owner), loaded.state, loaded.token), /不允许写入|只读/); assert.equal(b.writes.length, 0);
});

test('standalone notes retain exact prose and reject moved or trashed targets', async t => {
  const a = device(t), b = device(t, { name: 'B', libraryID: 8 }), ownerA = a.addOwner('OWNNOTE1', 'note'), ownerB = b.addOwner('OWNNOTE1', 'note');
  const original = ownerA.getNote(); await publish(a, stateFor(a, ownerA, 'Independent reasoning'), ownerA); b.receive(a);
  assert.equal(ownerA.getNote(), original); const loaded = await b.store.load(b.identity(ownerB)); assert.equal(loaded.state.noteKey, 'OWNNOTE1');
  assert.equal(ownerB.getNote(), original); assert.equal(a.nativeNotes().length, 1);
  ownerB.parentID = b.owner.id; await assert.rejects(() => b.store.load(b.identity(ownerB)), /关联已改变/);
  ownerB.parentID = null; ownerB.deleted = true; await assert.rejects(() => b.store.save(b.identity(ownerB), loaded.state, loaded.token), /已移除/);
});

test('same-content saves do not grow files and a later activation never rewrites an earlier lease', async t => {
  const d = device(t), first = await publish(d), originalFile = d.attachments()[0], originalText = fs.readFileSync(originalFile.filePath, 'utf8');
  const reopened = await d.store.load(d.identity(d.owner), first.cache), before = d.writes.length;
  await d.store.save(d.identity(d.owner), reopened.state, reopened.token); assert.equal(d.writes.length, before); assert.equal(d.attachments().length, 1);
  const oldWriter = d.fileStore.writerID; d.restart(); assert.notEqual(d.fileStore.writerID, oldWriter);
  const afterRestart = await d.store.load(d.identity(d.owner)); afterRestart.state.pyramid.text = 'Later activation';
  await d.store.save(d.identity(d.owner), afterRestart.state, afterRestart.token);
  assert.equal(d.attachments().length, 2); assert.equal(fs.readFileSync(originalFile.filePath, 'utf8'), originalText);
  assert.equal((await d.store.load(d.identity(d.owner))).state.pyramid.text, 'Later activation');
});

test('an atomic file-write failure preserves the preceding readable remote record', async t => {
  const d = device(t), first = await publish(d), item = d.attachments()[0], previous = fs.readFileSync(item.filePath, 'utf8');
  const changed = clone(first.state); changed.pyramid.text = 'Failed change'; d.failFileWriteAfter(1);
  await assert.rejects(() => d.store.save(d.identity(d.owner), changed, first.saved.token), /atomic file write failure/);
  assert.equal(fs.readFileSync(item.filePath, 'utf8'), previous); assert.equal((await d.store.load(d.identity(d.owner))).state.pyramid.text, first.state.pyramid.text);
  assert.equal(d.trashCalls.length, 0);
});

test('migration copies every valid legacy owner and conflict, then trashes exact managed notes only after confirmed file upload', async t => {
  const d = device(t), second = d.addOwner('PAPER002'), independent = d.addOwner('OWNNOTE1', 'note'), prose = independent.getNote();
  const first = await addLegacy(d, stateFor(d, d.owner, 'Offline legacy A'), { deviceID: 'legacy-A' });
  const other = await addLegacy(d, stateFor(d, d.owner, 'Offline legacy B'), { deviceID: 'legacy-B' });
  const large = stateFor(d, second, 'Large legacy'); for (let i = 0; i < 10; i++) { const child = core.addNode(large, large.pyramid.id, 'child'); child.text = '中文 legacy evidence 😀'.repeat(1000); }
  const split = await addLegacy(d, large, { owner: second }); assert.ok(split.notes.length > 1);
  const standalone = await addLegacy(d, stateFor(d, independent, 'Independent old tree'), { owner: independent });
  const all = [...first.notes, ...other.notes, ...split.notes, ...standalone.notes];
  const copied = await d.store.maintenance(); assert.ok(copied.migrated >= 4); assert.ok(all.every(note => !note.deleted)); assert.equal(d.trashCalls.length, 0);
  const records = (await d.fileStore.read(1)).records.map(value => value.record);
  assert.deepEqual(new Set(records.map(record => record.ownerKey)), new Set(['PAPER001', 'PAPER002', 'OWNNOTE1']));
  assert.ok(records.some(record => record.state.pyramid.text === 'Offline legacy A')); assert.ok(records.some(record => record.state.pyramid.text === 'Offline legacy B'));
  assert.equal((await d.store.load(d.identity(d.owner))).conflict, true);
  const cold = device(t, { name: 'C', libraryID: 9 }); cold.addOwner('PAPER002'); cold.addOwner('OWNNOTE1', 'note'); d.uploadAll(); cold.receive(d, { filter: item => !item.isNote() });
  assert.equal((await cold.store.load(cold.identity(cold.owner))).conflict, true);
  assert.equal((await cold.store.load(cold.identity([...cold.items.values()].find(item => item.key === 'PAPER002')))).state.pyramid.children.length, large.pyramid.children.length);
  const archived = await d.store.maintenance(); assert.ok(archived.archived >= all.length); assert.ok(all.every(note => note.deleted));
  assert.equal(independent.getNote(), prose); assert.equal(independent.deleted, false); assert.deepEqual(new Set(d.trashCalls), new Set(all.map(note => note.key)));
});

test('migration keeps incomplete legacy chunks and ordinary prose, then succeeds when the missing part arrives', async t => {
  const d = device(t), state = stateFor(d); for (let i = 0; i < 8; i++) { const child = core.addNode(state, state.pyramid.id, 'child'); child.text = 'Evidence'.repeat(6000); }
  const old = await addLegacy(d, state), missing = old.notes.find(note => sync.decodeNote(note.getNote()).kind === 'part'); assert.ok(missing);
  d.items.delete(missing.id); const prose = d.addOwner('OWNNOTE2', 'note'); prose.setNote('<p>I wrote about READING_FLOW_SYNC_V1 but this is ordinary prose.</p>');
  const result = await d.store.maintenance(); assert.ok(result.pending >= 1); d.uploadAll(); await d.store.maintenance();
  assert.equal(old.head.deleted, false); assert.equal(prose.deleted, false); assert.equal(d.trashCalls.length, 0);
  d.items.set(missing.id, missing); await d.store.maintenance(); d.uploadAll(); await d.store.maintenance();
  assert.ok(old.notes.every(note => note.deleted)); assert.equal(prose.deleted, false); assert.match(prose.getNote(), /ordinary prose/);
});

test('unconfirmed metadata or a mismatched uploaded hash never authorizes legacy cleanup', async t => {
  const d = device(t), old = await addLegacy(d); await d.store.maintenance(); const attachment = d.attachments()[0];
  attachment.synced = true; attachment.attachmentSyncState = 2; attachment.attachmentSyncedHash = '0'.repeat(32);
  await d.store.maintenance(); assert.equal(old.head.deleted, false); assert.equal(d.trashCalls.length, 0);
  d.uploadAll(); attachment.synced = false; await d.store.maintenance(); assert.equal(old.head.deleted, false);
  d.uploadAll(); await d.store.maintenance(); assert.equal(old.head.deleted, true);
});

test('read-only migration and failed writes keep all old data and never edit user prose', async t => {
  const d = device(t), old = await addLegacy(d), prose = d.addOwner('OWNNOTE2', 'note'); const original = prose.getNote();
  d.library.editable = false; await d.store.maintenance(); assert.equal(d.attachments().length, 0); assert.equal(old.head.deleted, false);
  d.library.editable = true; d.failFileWriteAfter(1); await d.store.maintenance(); assert.equal(old.head.deleted, false); assert.equal(d.trashCalls.length, 0);
  assert.equal(prose.getNote(), original); assert.equal(prose.deleted, false);
});
test('saving another owner does not invalidate the current owner token', async t => {
  const d = device(t), first = await publish(d), second = d.addOwner('PAPER002');
  const opened = await d.store.load(d.identity(d.owner)); await publish(d, stateFor(d, second, 'Separate reasoning'), second);
  opened.state.pyramid.text = 'Still valid edit'; await d.store.save(d.identity(d.owner), opened.state, opened.token);
  assert.equal((await d.store.load(d.identity(d.owner))).state.pyramid.text, 'Still valid edit');
  assert.equal((await d.store.load(d.identity(second))).state.pyramid.text, 'Separate reasoning');
  assert.equal(d.attachments().length, 1);
});

test('reparented legacy metadata is neither adopted by a different owner nor removed as migrated', async t => {
  const d = device(t), old = await addLegacy(d), second = d.addOwner('PAPER002'); old.head.parentID = second.id;
  assert.equal((await d.store.load(d.identity(second))).hasRemote, false);
  assert.equal((await d.store.load(d.identity(d.owner))).hasRemote, false);
  await d.store.maintenance(); d.uploadAll(); await d.store.maintenance();
  assert.equal(old.head.deleted, false); assert.equal(d.trashCalls.length, 0);
});

test('a failing legacy trash transaction retains migrated recoverable files and all source notes', async t => {
  const d = device(t), old = await addLegacy(d); await d.store.maintenance(); d.uploadAll(); d.failTrash();
  await d.store.maintenance(); assert.ok(old.notes.every(note => !note.deleted));
  assert.equal((await d.store.load(d.identity(d.owner))).state.pyramid.text, old.state.pyramid.text);
  d.failTrash(false); await d.store.maintenance(); assert.ok(old.notes.every(note => note.deleted));
});

test('a legacy clock changed during upload verification cannot authorize cleanup of unuploaded metadata', async t => {
  const d = device(t), old = await addLegacy(d); await d.store.maintenance(); d.uploadAll();
  const uploaded = d.fileStore.uploaded.bind(d.fileStore); let changed = false;
  d.fileStore.uploaded = async (...args) => {
    const result = await uploaded(...args);
    if (result && !changed) { changed = true; const envelope = sync.decodeNote(old.head.getNote()); envelope.clock['late-device'] = 1; old.head.setNote(sync.encodeNote(envelope)); }
    return result;
  };
  await d.store.maintenance(); assert.equal(old.head.deleted, false); assert.equal(d.trashCalls.length, 0);
});

test('late source-note edits at the trash transaction boundary remain in place', async t => {
  const d = device(t), old = await addLegacy(d); await d.store.maintenance(); d.uploadAll();
  const transaction = d.Zotero.DB.executeTransaction; let changed = false;
  d.Zotero.DB.executeTransaction = async callback => {
    if (!changed) { changed = true; old.head.setNote(old.head.getNote().replace('</div>', '<p>New user annotation</p></div>')); }
    return transaction(callback);
  };
  await d.store.maintenance(); assert.equal(old.head.deleted, false); assert.match(old.head.getNote(), /New user annotation/); assert.equal(d.trashCalls.length, 0);
});
