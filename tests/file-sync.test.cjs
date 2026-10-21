const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { device, stateFor, recordFor, core, clone } = require('./file-sync-harness.cjs');
const files = require('../content/file-sync.js');

function removeAllTags(d) {
  for (const item of d.items.values()) item.setTags([]);
}

async function ordinaryJSON(d, container, name = 'my-reading-data.json') {
  const source = d.PathUtils.join(d.root, name);
  fs.writeFileSync(source, JSON.stringify({ text: 'Personal JSON, not Reading flow sync data' }));
  return d.Zotero.Attachments.importFromFile({ file: source, parentItemID: container.id,
    title: 'Reading flow · 数据 · personal', contentType: 'application/json' });
}

test('journal codec preserves Unicode, formatting, owners and integrity without HTML notes', t => {
  const d = device(t), state = stateFor(d, d.owner, '中文 😀 <b>literal text</b>'), record = recordFor(d, state);
  const encoded = files.encodeJournal('writer-1', [record]), decoded = files.decodeJournal(encoded);
  assert.equal(decoded.format, files.FILE_FORMAT); assert.deepEqual(decoded.records, [record]);
  const damaged = JSON.parse(encoded); damaged.records[0].state.pyramid.text = 'Truncated or edited';
  assert.throws(() => files.decodeJournal(JSON.stringify(damaged)), /损坏|不完整/);
  assert.throws(() => files.decodeJournal('{'), /JSON|Unexpected|property/i);
  assert.throws(() => files.encodeJournal('writer-1', [{ ...record, ownerKey: 'WRONGKEY' }]), /无效/);
  assert.throws(() => files.encodeJournal('../escape', [record]), /无效/);
  assert.throws(() => files.decodeJournal(files.encodeJournal('writer-1', [record, record])), /重复/);
});

test('serialized publications aggregate owners in immutable snapshots and preserve earlier revisions', async t => {
  const d = device(t), other = d.addOwner('PAPER002'), active = d.fileStore.writerID;
  const a = recordFor(d, stateFor(d, d.owner, 'A v1'), { deviceID: active }), b = recordFor(d, stateFor(d, other, 'B v1'), { owner: other, deviceID: active });
  await Promise.all([d.fileStore.write(1, [a]), d.fileStore.write(1, [b])]);
  assert.equal(d.containers().length, 1); assert.equal(d.attachments().length, 2);
  const next = recordFor(d, stateFor(d, d.owner, 'A v2'), { deviceID: active, clock: { [active]: 2 } });
  await d.fileStore.write(1, [next]); const read = await d.fileStore.read(1);
  assert.equal(read.pending.length, 0); assert.equal(read.records.length, 3);
  assert.deepEqual(new Set(read.records.map(value => value.record.state.pyramid.text)), new Set(['A v1', 'A v2', 'B v1']));
  const latest = files.decodeJournal(fs.readFileSync(d.attachments().at(-1).filePath, 'utf8'));
  assert.deepEqual(new Set(latest.records.map(value => value.state.pyramid.text)), new Set(['A v2', 'B v1']));
  const prior = recordFor(d, stateFor(d, d.owner, 'Conflict retained'), { deviceID: active, clock: { [active]: 3 } });
  await d.fileStore.write(1, [prior], { replaceOwnCurrent: false }); assert.equal((await d.fileStore.read(1)).records.length, 4);
});

test('removing every tag during an active writer lease preserves binding and all owners on the next save', async t => {
  const d = device(t), active = d.fileStore.writerID, other = d.addOwner('PAPER002');
  const first = recordFor(d, stateFor(d, d.owner, 'Original tagless reasoning'), { deviceID: active });
  await d.fileStore.write(1, [first]); const file = d.attachments()[0], container = d.containers()[0], before = fs.readFileSync(file.filePath, 'utf8');
  removeAllTags(d);
  const second = recordFor(d, stateFor(d, other, 'Second owner reasoning'), { owner: other, deviceID: active });
  await d.fileStore.write(1, [second]);
  assert.equal(d.fileStore.isManagedItem(container), true); assert.equal(d.fileStore.isManagedItem(file), true);
  assert.equal(d.containers().length, 1); assert.equal(d.attachments().length, 2);
  assert.equal(d.attachments()[0].key, file.key); assert.equal(d.containers()[0].key, container.key);
  assert.equal(fs.readFileSync(file.filePath, 'utf8'), before);
  assert.deepEqual((await d.fileStore.read(1)).records.map(value => value.record), [first, second]);
  assert.ok([...d.items.values()].every(item => item.getTags().length === 0), 'saving cannot recreate tags');
});

test('a cold device discovers tagless journals across different numeric library IDs without cache or preferences', async t => {
  const a = device(t), b = device(t, { libraryID: 17, name: 'B' });
  const first = recordFor(a, stateFor(a, a.owner, 'Cross-device tagless reasoning'));
  await a.fileStore.write(1, [first]); removeAllTags(a); b.receive(a); b.prefs.clear(); b.restart();
  assert.equal(b.containers().length, 1); assert.equal(b.attachments().length, 1);
  assert.match(b.attachments()[0].attachmentFilename, /^file-sync-1-w-/);
  const loaded = await b.store.load(b.identity(b.owner));
  assert.equal(loaded.state.item.libraryID, 17); assert.equal(loaded.state.pyramid.text, first.state.pyramid.text);
  assert.deepEqual(loaded.state.pyramid.boldRanges, first.state.pyramid.boldRanges);
  assert.deepEqual(loaded.state.framing, first.state.framing); assert.equal(loaded.state.pyramidFontSize, 24);
  assert.equal(b.writes.length, 0, 'read-only recovery must not create a new container or attachment');
  loaded.state.pyramid.text = 'Edited after cold recovery';
  await b.store.save(b.identity(b.owner), loaded.state, loaded.token);
  assert.equal(b.containers().length, 1); assert.equal(b.attachments().length, 2, 'a new activation writes its own file under the existing container');
  assert.ok([...b.items.values()].every(item => item.getTags().length === 0), 'cold save cannot recreate tags');
});

test('separate writers never edit each other files, even with cloned stable device preferences', async t => {
  const a = device(t), b = device(t, { name: 'B' }); b.prefs.set('readingFlow.syncDeviceID', 'device-A');
  assert.notEqual(a.fileStore.writerID, b.fileStore.writerID);
  await a.fileStore.write(1, [recordFor(a, stateFor(a, a.owner, 'A'), { deviceID: a.fileStore.writerID })]);
  const first = a.attachments()[0], original = fs.readFileSync(first.filePath, 'utf8'); b.receive(a);
  await b.fileStore.write(1, [recordFor(b, stateFor(b, b.owner, 'B'), { deviceID: b.fileStore.writerID })]);
  const copied = b.attachments().find(item => item.key === first.key); assert.equal(fs.readFileSync(copied.filePath, 'utf8'), original);
  a.receive(b); assert.equal(a.attachments().length, 2); assert.equal(fs.readFileSync(first.filePath, 'utf8'), original);
  assert.deepEqual(new Set((await a.fileStore.read(1)).records.map(value => value.record.state.pyramid.text)), new Set(['A', 'B']));
});

test('offline duplicate containers are read together and no device data disappears', async t => {
  const a = device(t), b = device(t, { name: 'B' });
  await a.fileStore.write(1, [recordFor(a, stateFor(a, a.owner, 'Offline A'))]);
  await b.fileStore.write(1, [recordFor(b, stateFor(b, b.owner, 'Offline B'), { deviceID: 'device-B' })]);
  assert.notEqual(a.containers()[0].key, b.containers()[0].key); removeAllTags(a); removeAllTags(b); a.receive(b); b.receive(a);
  assert.equal(a.containers().length, 2); assert.equal(b.containers().length, 2);
  assert.deepEqual(new Set((await a.fileStore.read(1)).records.map(value => value.record.state.pyramid.text)), new Set(['Offline A', 'Offline B']));
  assert.equal((await b.fileStore.read(1)).records.length, 2);
  const bytes = new Map(a.attachments().map(item => [item.key, fs.readFileSync(item.filePath, 'utf8')]));
  assert.equal(await a.fileStore.consolidate(1), 1); assert.equal(a.containers().length, 1);
  assert.ok(a.attachments().every(item => item.parentID === a.containers()[0].id && !item.deleted));
  for (const item of a.attachments()) assert.equal(fs.readFileSync(item.filePath, 'utf8'), bytes.get(item.key));
  assert.equal((await a.fileStore.read(1)).records.length, 2); assert.equal(await a.fileStore.consolidate(1), 0);
  assert.ok([...a.items.values()].every(item => item.getTags().length === 0));
});

test('duplicate consolidation preserves user-added notes and unrelated attachments', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await a.fileStore.write(1, [recordFor(a)]); await b.fileStore.write(1, [recordFor(b)]); a.receive(b);
  const duplicate = a.containers().sort((left, right) => left.key.localeCompare(right.key))[1];
  const prose = new a.Zotero.Item('note'); prose.parentID = duplicate.id; prose.setNote('<p>User added prose</p>'); await prose.save();
  const unrelated = new a.Zotero.Item('attachment'); unrelated.parentID = duplicate.id; unrelated.attachmentLinkMode = 0; await unrelated.save();
  const personalJSON = await ordinaryJSON(a, duplicate); removeAllTags(a);
  a.failTrash(); await a.fileStore.consolidate(1); a.failTrash(false);
  assert.equal(duplicate.deleted, false); assert.equal(prose.deleted, false); assert.equal(prose.parentID, duplicate.id); assert.equal(unrelated.parentID, duplicate.id);
  assert.equal(personalJSON.parentID, duplicate.id); assert.equal(personalJSON.deleted, false);
  assert.equal((await a.fileStore.read(1)).records.length, 2);
});

test('a failed duplicate cleanup rolls back reparenting and preserves every stored byte', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await a.fileStore.write(1, [recordFor(a)]); await b.fileStore.write(1, [recordFor(b)]); a.receive(b);
  const before = new Map(a.attachments().map(item => [item.key, { parentID: item.parentID, bytes: fs.readFileSync(item.filePath, 'utf8') }]));
  a.failTrash(); await assert.rejects(a.fileStore.consolidate(1), /trash transaction failure/);
  assert.equal(a.containers().length, 2);
  for (const item of a.attachments()) { assert.equal(item.parentID, before.get(item.key).parentID); assert.equal(fs.readFileSync(item.filePath, 'utf8'), before.get(item.key).bytes); }
  assert.equal((await a.fileStore.read(1)).records.length, 2);
});

test('missing, corrupt, and awaiting-download files stay pending with a stable fingerprint', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await a.fileStore.write(1, [recordFor(a)]); removeAllTags(a); b.receive(a, { files: false });
  const missing = await b.fileStore.read(1); assert.equal(missing.records.length, 0); assert.equal(missing.pending.length, 1); assert.match(missing.fingerprint, /pending/);
  b.receive(a); const item = b.attachments()[0], text = fs.readFileSync(item.filePath, 'utf8'); fs.writeFileSync(item.filePath, 'bad JSON');
  const corrupt = await b.fileStore.read(1); assert.equal(corrupt.records.length, 0); assert.equal(corrupt.pending.length, 1);
  fs.writeFileSync(item.filePath, text); b.Zotero.Sync.Storage.Local.SYNC_STATE_TO_DOWNLOAD = 1; item.attachmentSyncState = 1;
  const stale = await b.fileStore.read(1); assert.equal(stale.pending.length, 1, 'a stale local file cannot stand in for a pending remote download');
  item.attachmentSyncState = 2; assert.equal((await b.fileStore.read(1)).records.length, 1);
});

test('ordinary same-title items and unrelated attachments are never treated as managed data', async t => {
  const d = device(t), ordinary = new d.Zotero.Item('document'); ordinary.setField('title', 'Reading flow 数据'); ordinary.setField('extra', 'User prose'); await ordinary.save();
  const spoof = new d.Zotero.Item('document'); spoof.setField('extra', 'User text: ' + files.CONTAINER_MARKER); await spoof.save();
  const wrongType = new d.Zotero.Item('journalArticle'); wrongType.setField('extra', files.CONTAINER_MARKER); await wrongType.save();
  assert.equal(d.fileStore.isManagedItem(ordinary), false); assert.equal(d.fileStore.isManagedItem(spoof), false); assert.equal(d.fileStore.isManagedItem(wrongType), false);
  const record = recordFor(d); await d.fileStore.write(1, [record]); const container = d.containers()[0];
  const unrelated = new d.Zotero.Item('attachment'); unrelated.parentID = container.id; unrelated.attachmentLinkMode = 0; await unrelated.save();
  const personalJSON = await ordinaryJSON(d, container); const personalBytes = fs.readFileSync(personalJSON.filePath, 'utf8');
  assert.equal(d.fileStore.isManagedItem(unrelated), false); assert.equal((await d.fileStore.read(1)).pending.length, 0);
  assert.equal(d.fileStore.isManagedItem(personalJSON), false); assert.equal(fs.readFileSync(personalJSON.filePath, 'utf8'), personalBytes);
  assert.equal(d.fileStore.isManagedItem(container), true); assert.equal(d.fileStore.isManagedItem(d.attachments().find(item => item !== unrelated && item !== personalJSON)), true);
  fs.writeFileSync(personalJSON.filePath, 'Unrelated malformed JSON');
  assert.equal((await d.fileStore.read(1)).pending.length, 0, 'an unrelated malformed JSON must not block Reading flow');
  fs.unlinkSync(personalJSON.filePath);
  assert.equal((await d.fileStore.read(1)).pending.length, 0, 'an unrelated missing JSON must not block Reading flow');
});

test('removing a reserved marker or moving an active file to an ordinary item still refuses unsafe writes', async t => {
  const d = device(t), first = recordFor(d); await d.fileStore.write(1, [first]);
  const item = d.attachments()[0], container = d.containers()[0], before = fs.readFileSync(item.filePath, 'utf8');
  container.setField('extra', 'User prose instead of a reserved data marker');
  await assert.rejects(d.fileStore.write(1, [recordFor(d)]), /关联已改变/);
  assert.equal(fs.readFileSync(item.filePath, 'utf8'), before);
  container.setField('extra', files.CONTAINER_MARKER); item.parentID = d.owner.id;
  await assert.rejects(d.fileStore.write(1, [recordFor(d)]), /关联已改变/);
  assert.equal(fs.readFileSync(item.filePath, 'utf8'), before);
});

test('only exact bytes confirmed by Zotero file sync authorize uploaded records', async t => {
  const d = device(t), record = recordFor(d); await d.fileStore.write(1, [record]); const item = d.attachments()[0];
  assert.equal(await d.fileStore.uploaded(1, [record]), false);
  d.uploadAll(); assert.equal(await d.fileStore.uploaded(1, [record]), true);
  const changed = clone(record); changed.state.pyramid.text = 'Unuploaded content';
  assert.equal(await d.fileStore.uploaded(1, [changed]), false);
  item.attachmentSyncedHash = '0'.repeat(32); assert.equal(await d.fileStore.uploaded(1, [record]), false);
  d.uploadAll(); fs.unlinkSync(item.filePath); assert.equal(await d.fileStore.uploaded(1, [record]), false);
});

test('a failed snapshot publication leaves every old owner record and uploaded confirmation unchanged', async t => {
  const d = device(t), a = recordFor(d), second = d.addOwner('PAPER002'), b = recordFor(d, stateFor(d, second), { owner: second });
  await d.fileStore.write(1, [a, b]); d.uploadAll(); const item = d.attachments()[0], before = fs.readFileSync(item.filePath, 'utf8');
  d.failFileWriteAfter(1); await assert.rejects(() => d.fileStore.write(1, [recordFor(d, stateFor(d, d.owner, 'Failed edit'))]), /atomic file write failure/);
  assert.equal(fs.readFileSync(item.filePath, 'utf8'), before); assert.equal((await d.fileStore.read(1)).records.length, 2); assert.equal(await d.fileStore.uploaded(1, [a, b]), true);
});

test('publishing while an earlier native upload is in flight never edits its bytes or metadata', async t => {
  const d = device(t), active = d.fileStore.writerID;
  const first = recordFor(d, stateFor(d, d.owner, 'Snapshot being uploaded'), { deviceID: active });
  await d.fileStore.write(1, [first]); const old = d.attachments()[0];
  const oldText = fs.readFileSync(old.filePath, 'utf8'), oldMD5 = d.md5(old.filePath);
  const beforeWrites = d.writes.length, originalImport = d.Zotero.Attachments.importFromFile;
  d.Zotero.Attachments.importFromFile = async options => {
    assert.equal(fs.readFileSync(old.filePath, 'utf8'), oldText, 'native upload still reads the exact bytes it started with');
    assert.equal(old.attachmentSyncState, 'to_upload');
    // Simulate Zotero completing the old upload while a newer snapshot is imported.
    old.synced = true; old.attachmentSyncState = 2; old.attachmentSyncedHash = oldMD5;
    return originalImport(options);
  };
  const next = recordFor(d, stateFor(d, d.owner, 'Later complete snapshot'), { deviceID: active, clock: { [active]: 2 } });
  await d.fileStore.write(1, [next]);
  assert.equal(d.attachments().length, 2); assert.notEqual(d.attachments()[1].attachmentFilename, old.attachmentFilename);
  assert.equal(fs.readFileSync(old.filePath, 'utf8'), oldText);
  assert.equal(old.attachmentSyncedHash, oldMD5); assert.equal(old.attachmentSyncState, 2); assert.equal(old.synced, true);
  assert.ok(d.writes.slice(beforeWrites).every(value => value.key !== old.key), 'plugin never saves metadata of an imported earlier snapshot');
  assert.equal(await d.fileStore.uploaded(1, [first]), true);
  const count = d.writes.length, latest = d.attachments()[1];
  await d.fileStore.write(1, [next]);
  assert.equal(d.writes.length, count); assert.equal(d.attachments().length, 2, 'same-record publication is a no-op');
  assert.equal(files.decodeJournal(fs.readFileSync(latest.filePath, 'utf8')).writerID, active);
});

test('identical carried records deduplicate but changed clocks or content cannot disappear as copies', async t => {
  const d = device(t), first = recordFor(d);
  await d.fileStore.write(1, [first]);
  const other = d.addOwner('PAPER002');
  await d.fileStore.write(1, [recordFor(d, stateFor(d, other), { owner: other })]);
  assert.equal((await d.fileStore.read(1)).records.length, 2);
  const second = d.attachments()[1], journal = files.decodeJournal(fs.readFileSync(second.filePath, 'utf8'));
  journal.records[0].clock['another-device'] = 1;
  fs.writeFileSync(second.filePath, files.encodeJournal(journal.writerID, journal.records));
  const differing = await d.fileStore.read(1);
  assert.equal(differing.records.length, 3, 'same identity with changed causal metadata stays available for validation');
});

test('file-store refuses read-only and attachment-read-only writes without creating a container', async t => {
  const d = device(t), record = recordFor(d); d.library.editable = false;
  await assert.rejects(() => d.fileStore.write(1, [record]), /不允许写入/); assert.equal(d.containers().length, 0);
  d.library.editable = true; d.library.filesEditable = false;
  await assert.rejects(() => d.fileStore.write(1, [record]), /不允许写入/); assert.equal(d.containers().length, 0); assert.equal(d.attachments().length, 0);
});
