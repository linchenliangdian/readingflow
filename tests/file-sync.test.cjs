const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { device, stateFor, recordFor, core, clone } = require('./file-sync-harness.cjs');
const files = require('../content/file-sync.js');

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

test('serialized writes aggregate owners while replacing only the active writer current owner record', async t => {
  const d = device(t), other = d.addOwner('PAPER002'), active = d.fileStore.writerID;
  const a = recordFor(d, stateFor(d, d.owner, 'A v1'), { deviceID: active }), b = recordFor(d, stateFor(d, other, 'B v1'), { owner: other, deviceID: active });
  await Promise.all([d.fileStore.write(1, [a]), d.fileStore.write(1, [b])]);
  assert.equal(d.containers().length, 1); assert.equal(d.attachments().length, 1);
  const next = recordFor(d, stateFor(d, d.owner, 'A v2'), { deviceID: active, clock: { [active]: 2 } });
  await d.fileStore.write(1, [next]); const read = await d.fileStore.read(1);
  assert.equal(read.pending.length, 0); assert.equal(read.records.length, 2);
  assert.deepEqual(new Set(read.records.map(value => value.record.state.pyramid.text)), new Set(['A v2', 'B v1']));
  const prior = recordFor(d, stateFor(d, d.owner, 'Conflict retained'), { deviceID: active, clock: { [active]: 3 } });
  await d.fileStore.write(1, [prior], { replaceOwnCurrent: false }); assert.equal((await d.fileStore.read(1)).records.length, 3);
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
  assert.notEqual(a.containers()[0].key, b.containers()[0].key); a.receive(b); b.receive(a);
  assert.equal(a.containers().length, 2); assert.equal(b.containers().length, 2);
  assert.deepEqual(new Set((await a.fileStore.read(1)).records.map(value => value.record.state.pyramid.text)), new Set(['Offline A', 'Offline B']));
  assert.equal((await b.fileStore.read(1)).records.length, 2);
  const bytes = new Map(a.attachments().map(item => [item.key, fs.readFileSync(item.filePath, 'utf8')]));
  assert.equal(await a.fileStore.consolidate(1), 1); assert.equal(a.containers().length, 1);
  assert.ok(a.attachments().every(item => item.parentID === a.containers()[0].id && !item.deleted));
  for (const item of a.attachments()) assert.equal(fs.readFileSync(item.filePath, 'utf8'), bytes.get(item.key));
  assert.equal((await a.fileStore.read(1)).records.length, 2); assert.equal(await a.fileStore.consolidate(1), 0);
});

test('duplicate consolidation preserves user-added notes and unrelated attachments', async t => {
  const a = device(t), b = device(t, { name: 'B' }); await a.fileStore.write(1, [recordFor(a)]); await b.fileStore.write(1, [recordFor(b)]); a.receive(b);
  const duplicate = a.containers().sort((left, right) => left.key.localeCompare(right.key))[1];
  const prose = new a.Zotero.Item('note'); prose.parentID = duplicate.id; prose.setNote('<p>User added prose</p>'); await prose.save();
  const unrelated = new a.Zotero.Item('attachment'); unrelated.parentID = duplicate.id; unrelated.attachmentLinkMode = 0; await unrelated.save();
  a.failTrash(); await a.fileStore.consolidate(1); a.failTrash(false);
  assert.equal(duplicate.deleted, false); assert.equal(prose.deleted, false); assert.equal(prose.parentID, duplicate.id); assert.equal(unrelated.parentID, duplicate.id);
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
  const a = device(t), b = device(t, { name: 'B' }); await a.fileStore.write(1, [recordFor(a)]); b.receive(a, { files: false });
  const missing = await b.fileStore.read(1); assert.equal(missing.records.length, 0); assert.equal(missing.pending.length, 1); assert.match(missing.fingerprint, /pending/);
  b.receive(a); const item = b.attachments()[0], text = fs.readFileSync(item.filePath, 'utf8'); fs.writeFileSync(item.filePath, 'bad JSON');
  const corrupt = await b.fileStore.read(1); assert.equal(corrupt.records.length, 0); assert.equal(corrupt.pending.length, 1);
  fs.writeFileSync(item.filePath, text); b.Zotero.Sync.Storage.Local.SYNC_STATE_TO_DOWNLOAD = 1; item.attachmentSyncState = 1;
  const stale = await b.fileStore.read(1); assert.equal(stale.pending.length, 1, 'a stale local file cannot stand in for a pending remote download');
  item.attachmentSyncState = 2; assert.equal((await b.fileStore.read(1)).records.length, 1);
});

test('ordinary same-title items and unrelated attachments are never treated as managed data', async t => {
  const d = device(t), ordinary = new d.Zotero.Item('document'); ordinary.setField('title', 'Reading flow 数据'); ordinary.setField('extra', 'User prose'); await ordinary.save();
  const spoof = new d.Zotero.Item('document'); spoof.setField('extra', files.CONTAINER_MARKER); await spoof.save();
  assert.equal(d.fileStore.isManagedItem(ordinary), false); assert.equal(d.fileStore.isManagedItem(spoof), false);
  const record = recordFor(d); await d.fileStore.write(1, [record]); const container = d.containers()[0];
  const unrelated = new d.Zotero.Item('attachment'); unrelated.parentID = container.id; unrelated.attachmentLinkMode = 0; await unrelated.save();
  assert.equal(d.fileStore.isManagedItem(unrelated), false); assert.equal((await d.fileStore.read(1)).pending.length, 0);
  assert.equal(d.fileStore.isManagedItem(container), true); assert.equal(d.fileStore.isManagedItem(d.attachments().find(item => item !== unrelated)), true);
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

test('atomic rewrite failure leaves every owner record and uploaded confirmation unchanged', async t => {
  const d = device(t), a = recordFor(d), second = d.addOwner('PAPER002'), b = recordFor(d, stateFor(d, second), { owner: second });
  await d.fileStore.write(1, [a, b]); d.uploadAll(); const item = d.attachments()[0], before = fs.readFileSync(item.filePath, 'utf8');
  d.failFileWriteAfter(1); await assert.rejects(() => d.fileStore.write(1, [recordFor(d, stateFor(d, d.owner, 'Failed edit'))]), /atomic file write failure/);
  assert.equal(fs.readFileSync(item.filePath, 'utf8'), before); assert.equal((await d.fileStore.read(1)).records.length, 2); assert.equal(await d.fileStore.uploaded(1, [a, b]), true);
});

test('file-store refuses read-only and attachment-read-only writes without creating a container', async t => {
  const d = device(t), record = recordFor(d); d.library.editable = false;
  await assert.rejects(() => d.fileStore.write(1, [record]), /不允许写入/); assert.equal(d.containers().length, 0);
  d.library.editable = true; d.library.filesEditable = false;
  await assert.rejects(() => d.fileStore.write(1, [record]), /不允许写入/); assert.equal(d.containers().length, 0); assert.equal(d.attachments().length, 0);
});
