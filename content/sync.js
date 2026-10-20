/* Editable reading data travels as centrally stored JSON attachments. V1 notes
 * remain readable until every complete version has a verified uploaded copy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReadingFlowSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const FORMAT = "READING_FLOW_SYNC_V1", TAG = "Reading flow · sync data";
  const MAX_BYTES = 16 * 1024 * 1024, MAX_NOTE = 180000, PART_SIZE = 120000;
  const DEVICE_PREF = "readingFlow.syncDeviceID";
  const validID = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function escapeHTML(value) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function unescapeHTML(value) {
    return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
      const known = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
      if (known[entity.toLowerCase()] !== undefined) return known[entity.toLowerCase()];
      const point = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    });
  }
  function encodeNote(envelope) {
    const marker = FORMAT + " OWNER:" + envelope.ownerKey + " KIND:" + envelope.kind;
    const title = envelope.kind === "part" ? "Reading flow · 金字塔数据（分块）" : "Reading flow · 金字塔数据";
    const result = '<div data-schema-version="9"><p>' + title + '</p><p>由 Reading flow 自动保存，用于同步。请勿编辑或删除。</p><p>' + marker + '</p><pre>' + escapeHTML(JSON.stringify(envelope)) + '</pre></div>';
    if (result.length >= MAX_NOTE) throw new Error("同步数据分块超过安全长度，请保留本机备份。");
    return result;
  }
  function decodeNote(html) {
    if (typeof html !== "string" || html.length >= MAX_NOTE || !html.includes(FORMAT)) return null;
    const match = html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
    if (!match) return null;
    try {
      const value = JSON.parse(unescapeHTML(match[1].replace(/<[^>]*>/g, "")));
      return value && value.format === FORMAT ? value : null;
    }
    catch (_) { return null; }
  }
  function normalizeClock(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("金字塔同步版本信息损坏，原数据已保留。");
    const entries = Object.entries(value);
    if (entries.length > 1000) throw new Error("金字塔同步设备记录过多，请保留备份。");
    const result = Object.create(null);
    for (const [key, count] of entries) {
      if (!validID(key) || !Number.isSafeInteger(count) || count < 1) throw new Error("金字塔同步版本信息损坏，原数据已保留。");
      result[key] = count;
    }
    return result;
  }
  function mergeClocks(values) {
    const result = Object.create(null);
    for (const value of values) for (const [key, count] of Object.entries(normalizeClock(value))) result[key] = Math.max(result[key] || 0, count);
    return result;
  }
  function dominates(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return Array.from(keys).every(key => (a[key] || 0) >= (b[key] || 0));
  }
  function sameClock(a, b) { return dominates(a, b) && dominates(b, a); }
  // Integrity checks detect missing/truncated text; Zotero itself authenticates transport.
  function checksum(value) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b); }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }
  function encodePayload(state) {
    const json = JSON.stringify(state), bytes = new TextEncoder().encode(json);
    if (bytes.length > MAX_BYTES) throw new Error("阅读数据超过 16 MB，请精简过长的原文摘录后重试。");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function decodePayload(value) {
    if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("金字塔同步内容损坏，原数据已保留。");
    const binary = atob(value);
    if (binary.length > MAX_BYTES) throw new Error("金字塔同步内容超过 16 MB。");
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  function splitPayload(state) {
    const payload = encodePayload(state), parts = [];
    for (let offset = 0; offset < payload.length; offset += PART_SIZE) parts.push(payload.slice(offset, offset + PART_SIZE));
    return { parts, hash: checksum(payload), length: payload.length };
  }
  function stateHash(state) {
    const value = clone(state);
    delete value.readingFlowSync; delete value.updatedAt;
    if (value.item) { delete value.item.libraryID; delete value.item.title; }
    return checksum(JSON.stringify(value));
  }
  function create({ Zotero, core, fileStore }) {
    if (!Zotero || !core || !fileStore || !validID(fileStore.writerID) ||
        !["read", "write", "uploaded"].every(name => typeof fileStore[name] === "function")) {
      throw new Error("Reading flow sync requires Zotero, core, and its file store.");
    }
    let maintenancePromise = null;
    function randomID() {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
      return "d-" + Date.now().toString(36) + "-" + Zotero.Utilities.randomString(24);
    }
    function deviceID() {
      let value = Zotero.Prefs.get(DEVICE_PREF);
      if (!validID(value)) { value = randomID(); Zotero.Prefs.set(DEVICE_PREF, value); }
      return value;
    }
    async function ownerContext(item) {
      if (!item || !Number.isInteger(item.libraryID) || !validID(item.key)) throw new Error("同步目标无效。");
      const owner = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, item.key);
      if (!owner || owner.deleted) throw new Error("当前文献或独立笔记已移除，阅读数据已保留。");
      const isNote = owner.isNote();
      if (isNote ? !!owner.parentID : !owner.isRegularItem()) throw new Error("金字塔同步目标关联已改变，请重新打开阅读台。");
      return { item, owner, ownerKind: isNote ? "note" : "item", parentID: isNote ? null : owner.id };
    }
    function positioned(note, context) {
      return !!(note && !note.deleted && note.isNote() && note.libraryID === context.item.libraryID &&
        (context.parentID === null ? !note.parentID && note.key !== context.item.key : note.parentID === context.parentID));
    }
    function owned(value, context) {
      return !!(value && value.format === FORMAT && value.ownerKey === context.item.key && value.ownerKind === context.ownerKind &&
        validID(value.deviceID) && validID(value.revision));
    }
    async function noteEnvelope(note) {
      if (typeof note.loadDataType === "function") await note.loadDataType("note");
      return decodeNote(note.getNote());
    }
    function normalizeRemote(raw, item) {
      if (!raw || !raw.item || raw.item.key !== item.key) throw new Error("金字塔同步内容关联不匹配，原数据已保留。");
      const portable = clone(raw); portable.item.libraryID = item.libraryID;
      return core.normalizeSession(portable, item);
    }
    async function discoverLegacy(context) {
      const search = new Zotero.Search(); search.libraryID = context.item.libraryID;
      search.addCondition("itemType", "is", "note"); search.addCondition("deleted", "false");
      search.addCondition("note", "contains", FORMAT); search.addCondition("note", "contains", "OWNER:" + context.item.key);
      search.addCondition("note", "contains", "KIND:head");
      const ids = await search.search(), heads = [], broken = [];
      for (const id of ids) {
        const note = await Zotero.Items.getAsync(id);
        if (!positioned(note, context)) continue;
        const value = await noteEnvelope(note), originalHTML = note.getNote();
        if (!value) {
          if (note.getNote().includes("OWNER:" + context.item.key)) broken.push(note.key);
          continue;
        }
        if (value.ownerKind && value.ownerKind !== context.ownerKind) continue;
        if (!owned(value, context) || value.kind !== "head") {
          if (note.getNote().includes("OWNER:" + context.item.key + " KIND:head")) broken.push(note.key);
          continue;
        }
        try {
          const clock = normalizeClock(value.clock);
          if (!clock[value.deviceID] || typeof value.hash !== "string" || !Number.isSafeInteger(value.length) || value.length < 1 ||
            value.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw new Error("invalid head");
          const pieces = [], partNotes = [], snapshots = [{ id: note.id, key: note.key, html: originalHTML }];
          if (typeof value.data === "string" && value.data.length <= PART_SIZE && !value.partKeys) pieces.push(value.data);
          else {
            if (!Array.isArray(value.partKeys) || !value.partKeys.length || value.partKeys.length > 200 ||
                !value.partKeys.every(validID) || new Set(value.partKeys).size !== value.partKeys.length) throw new Error("invalid part list");
            for (let index = 0; index < value.partKeys.length; index++) {
              const partNote = await Zotero.Items.getByLibraryAndKeyAsync(context.item.libraryID, value.partKeys[index]);
              if (!positioned(partNote, context)) throw new Error("missing part");
              const part = await noteEnvelope(partNote);
              if (!owned(part, context) || part.kind !== "part" || part.deviceID !== value.deviceID || part.revision !== value.revision ||
                part.index !== index || part.count !== value.partKeys.length || typeof part.data !== "string" || part.data.length > PART_SIZE) throw new Error("invalid part");
              pieces.push(part.data);
              partNotes.push(partNote);
              snapshots.push({ id: partNote.id, key: partNote.key, html: partNote.getNote() });
            }
          }
          const payload = pieces.join("");
          if (payload.length !== value.length || checksum(payload) !== value.hash) throw new Error("incomplete payload");
          const state = normalizeRemote(decodePayload(payload), context.item);
          heads.push({ id: value.revision, key: note.key, note, parts: partNotes, snapshots, envelope: value, clock, state,
            hash: stateHash(state), payloadHash: value.hash, deviceID: value.deviceID, legacy: true });
        }
        catch (_) { broken.push(note.key); }
      }
      const fingerprint = heads.map(head => head.key + ":" + head.id + ":" + checksum(JSON.stringify(head.envelope)) + ":" +
        head.snapshots.map(value => value.key + ":" + checksum(value.html)).join(","))
        .concat(broken.map(key => key + ":pending")).sort().join("|");
      return { heads, broken, fingerprint };
    }
    function recordFor(head, context) {
      return { format: FORMAT, kind: "head", ownerKey: context.item.key, ownerKind: context.ownerKind,
        deviceID: head.deviceID, revision: head.id, clock: clone(head.clock), state: clone(head.state), hash: head.hash };
    }
    async function discover(context) {
      const legacy = await discoverLegacy(context), files = await fileStore.read(context.item.libraryID);
      const heads = legacy.heads.slice(), broken = legacy.broken.slice();
      for (const value of files.pending || []) broken.push("file:" + value.key);
      for (const { record, sourceKey } of files.records || []) {
        if (!record || record.ownerKey !== context.item.key || record.ownerKind !== context.ownerKind) continue;
        try {
          if (!owned(record, context) || record.kind !== "head") throw new Error("invalid file record");
          const clock = normalizeClock(record.clock), state = normalizeRemote(record.state, context.item);
          if (!clock[record.deviceID] || stateHash(state) !== record.hash) throw new Error("invalid file state");
          heads.push({ id: record.revision, key: "file:" + sourceKey + ":" + record.revision,
            envelope: record, clock, state, hash: record.hash, payloadHash: record.hash,
            deviceID: record.deviceID, legacy: false, sourceKey });
        }
        catch (_) { broken.push("file:" + sourceKey + ":" + record.revision); }
      }
      const fingerprint = heads.map(head => head.key + ":" + head.id + ":" + head.payloadHash)
        .concat(broken.map(key => key + ":pending")).sort().join("|");
      return { heads, broken, fingerprint, legacy };
    }
    function maxima(heads) {
      return heads.filter(head => !heads.some(other => other !== head && dominates(other.clock, head.clock) && !sameClock(other.clock, head.clock)));
    }
    function uniqueMaxima(heads) {
      return maxima(heads).filter((head, index, values) => values.findIndex(other => other.hash === head.hash && sameClock(other.clock, head.clock)) === index);
    }
    function makeToken(context, found, selected, conflict, pending) {
      return { ownerKey: context.item.key, libraryID: context.item.libraryID, fingerprint: found.fingerprint, signature: found.fingerprint,
        clock: clone(selected ? selected.clock : {}), selected: selected ? selected.id : null, conflict, pending };
    }
    async function load(item, localRaw = null) {
      const context = await ownerContext(item), found = await discover(context), remoteUnique = uniqueMaxima(found.heads);
      let selected = remoteUnique.slice().sort((a, b) => a.id.localeCompare(b.id))[0] || null;
      const versions = remoteUnique.map(head => ({ id: head.id, label: "同步版本 · " + head.deviceID.slice(0, 8), state: clone(head.state) }));
      let local = null, legacy = false, localDirty = false, localClock = {};
      if (localRaw) {
        local = core.normalizeSession(localRaw, item);
        const meta = localRaw.readingFlowSync;
        if (meta && meta.format === FORMAT && meta.ownerKey === item.key && meta.clock) {
          try { localClock = normalizeClock(meta.clock); localDirty = meta.pending === true || meta.stateHash !== stateHash(local); }
          catch (_) { legacy = true; }
        }
        else legacy = true;
      }
      let conflict = remoteUnique.length > 1, needsPublish = false;
      if (local) {
        const hash = stateHash(local), equal = remoteUnique.find(head => head.hash === hash);
        if (equal && !legacy && !localDirty && dominates(equal.clock, localClock)) selected = equal;
        else if (equal && legacy) selected = equal;
        else if (!remoteUnique.length || !legacy && remoteUnique.every(head => dominates(localClock, head.clock))) {
          selected = { id: "local", state: local, clock: localClock, hash }; needsPublish = true;
          versions.push({ id: "local", label: "本机未同步版本", state: clone(local) });
        }
        else if (!legacy && !localDirty && remoteUnique.every(head => dominates(head.clock, localClock))) {
          // A clean cache is superseded by a causal descendant, never by wall-clock time.
        }
        else if (!equal) {
          conflict = true; versions.push({ id: "local", label: legacy ? "本机旧版草稿" : "本机未同步版本", state: clone(local) });
          selected = { id: "local", state: local, clock: localClock, hash };
        }
      }
      const pending = found.broken.length > 0;
      if (pending && !selected) throw new Error("金字塔同步数据尚未到齐或已损坏，未打开空白金字塔；请先完成 Zotero 数据和文件同步后重试。");
      const state = selected ? clone(selected.state) : core.createSession(item);
      const notice = pending ? "部分金字塔同步数据尚未到齐或已损坏，已保留现有版本；请完成 Zotero 数据和文件同步后重新打开。" :
        conflict ? "检测到不同设备的金字塔版本；各版本均已保留，请选择要继续使用的版本。" : "";
      return { state, token: makeToken(context, found, selected, conflict, pending), versions, conflict, pending,
        hasRemote: found.heads.length > 0 || pending, needsPublish, notice };
    }
    async function save(item, rawState, token, { resolve = false } = {}) {
      const context = await ownerContext(item), library = Zotero.Libraries.get(item.libraryID);
      if (!library || !library.editable) throw new Error("此文献库为只读，金字塔本机草稿已保留。");
      if (!token || token.ownerKey !== item.key || token.libraryID !== item.libraryID) throw new Error("金字塔同步关联已改变，请重新打开阅读台。");
      const found = await discover(context);
      if (found.broken.length) throw new Error("金字塔同步数据尚未完整，已保留本机草稿；请完成 Zotero 数据和文件同步后重试。");
      if (token.fingerprint !== found.fingerprint) throw new Error("另一设备的金字塔版本已到达，本机草稿已保留；请重新打开后选择版本。");
      if (!resolve && (token.conflict || token.pending || uniqueMaxima(found.heads).length > 1)) throw new Error("金字塔存在多个版本；请先选择版本，本机草稿已保留。");
      const state = core.normalizeSession(rawState, item), hash = stateHash(state);
      encodePayload(state); // Keep the established per-session 16 MB safety bound.
      if (!resolve && found.heads.length) {
        const latest = uniqueMaxima(found.heads);
        if (latest.length === 1 && latest[0].hash === hash) {
          const current = latest[0];
          if (found.legacy.heads.length) await fileStore.write(item.libraryID,
            found.legacy.heads.map(head => recordFor(head, context)), { replaceOwnCurrent: false });
          const refreshed = found.legacy.heads.length ? await discover(context) : found;
          return { token: makeToken(context, refreshed, current, false, refreshed.broken.length > 0),
            cacheMeta: { format: FORMAT, ownerKey: item.key, clock: clone(current.clock), stateHash: hash, revision: current.id, pending: false },
            message: "已保存，随 Zotero 文件同步" };
        }
      }
      // The lease, unlike a copied preference, cannot make two offline devices
      // increment the same vector-clock component or overwrite the same file.
      const id = fileStore.writerID, revision = randomID();
      const clock = mergeClocks(resolve ? found.heads.map(head => head.clock).concat([token.clock || {}]) : [token.clock || {}]);
      clock[id] = (clock[id] || 0) + 1;
      const record = { format: FORMAT, kind: "head", ownerKey: item.key, ownerKind: context.ownerKind,
        deviceID: id, revision, clock, state, hash };
      const preserved = found.legacy.heads.map(head => recordFor(head, context));
      await fileStore.write(item.libraryID, preserved.concat([record]), { replaceOwnCurrent: !resolve });
      const refreshed = await discover(context), pending = refreshed.broken.length > 0;
      const nextToken = { ownerKey: item.key, libraryID: item.libraryID, fingerprint: refreshed.fingerprint,
        signature: refreshed.fingerprint, clock: clone(clock), selected: revision, conflict: false, pending };
      const cacheMeta = { format: FORMAT, ownerKey: item.key, clock: clone(clock), stateHash: hash, revision, pending: false };
      return { token: nextToken, cacheMeta, message: "已保存，随 Zotero 文件同步" };
    }
    async function performMaintenance() {
      const result = { migrated: 0, archived: 0, pending: 0 };
      if (typeof fileStore.consolidate === "function") {
        for (const library of Zotero.Libraries.getAll()) {
          if (!library.editable || library.filesEditable === false) continue;
          try { await fileStore.consolidate(library.libraryID); }
          catch (error) { result.pending++; if (typeof Zotero.logError === "function") Zotero.logError(error); }
        }
      }
      const search = new Zotero.Search();
      search.addCondition("itemType", "is", "note"); search.addCondition("deleted", "false");
      search.addCondition("note", "contains", FORMAT); search.addCondition("note", "contains", "KIND:head");
      const groups = new Map();
      for (const id of await search.search()) {
        const note = await Zotero.Items.getAsync(id);
        if (!note || note.deleted || !note.isNote()) continue;
        let value;
        try { value = await noteEnvelope(note); } catch (_) { result.pending++; continue; }
        if (!value || value.kind !== "head" || !validID(value.ownerKey) || !["item", "note"].includes(value.ownerKind)) continue;
        const key = note.libraryID + ":" + value.ownerKind + ":" + value.ownerKey;
        groups.set(key, { libraryID: note.libraryID, key: value.ownerKey, title: "" });
      }
      for (const item of groups.values()) {
        const library = Zotero.Libraries.get(item.libraryID);
        if (!library?.editable || library.filesEditable === false) { result.pending++; continue; }
        try {
          const context = await ownerContext(item), found = await discoverLegacy(context);
          if (found.broken.length || !found.heads.length) { result.pending++; continue; }
          const records = found.heads.map(head => recordFor(head, context));
          // Reading back a local file is necessary but never sufficient to remove
          // notes: the storage transport must also acknowledge its uploaded hash.
          if (!(await fileStore.uploaded(item.libraryID, records))) {
            await fileStore.write(item.libraryID, records, { replaceOwnCurrent: false });
            result.migrated += records.length;
          }
          if (!(await fileStore.uploaded(item.libraryID, records))) { result.pending++; continue; }
          const fresh = await discoverLegacy(context);
          if (fresh.broken.length || fresh.fingerprint !== found.fingerprint) { result.pending++; continue; }
          const managed = [], snapshots = [];
          for (const head of fresh.heads) {
            const candidates = [head.note].concat(head.parts || []);
            // Only exact, well-formed plugin notes are eligible. Tags alone, old
            // orphan parts, and user prose never authorize deleting anything.
            if (!candidates.every(note => typeof note.hasTag === "function" ? note.hasTag(TAG) :
                typeof note.getTags === "function" && note.getTags().some(value => value.tag === TAG))) continue;
            managed.push(...candidates);
            snapshots.push(...head.snapshots);
          }
          const ids = Array.from(new Set(managed.map(note => note.id)));
          if (!ids.length) continue;
          // This is deliberately trash, never erase; original bytes remain in the
          // native recycle bin even after the JSON data is verified in storage.
          const archived = await Zotero.DB.executeTransaction(async () => {
            // Native sync changes are serialized with this transaction. Check
            // owner placement and exact original note bytes again at its edge;
            // a late clock edit or appended text must remain recoverable in place.
            await ownerContext(item);
            const library = Zotero.Libraries.get(item.libraryID);
            if (!library?.editable || library.filesEditable === false) return 0;
            for (const snapshot of snapshots) {
              const note = Zotero.Items.get(snapshot.id);
              if (!positioned(note, context) || note.key !== snapshot.key || note.getNote() !== snapshot.html ||
                  !(typeof note.hasTag === "function" ? note.hasTag(TAG) : note.getTags?.().some(value => value.tag === TAG))) return 0;
            }
            await Zotero.Items.trash(ids);
            return ids.length;
          });
          result.archived += archived;
        }
        catch (error) {
          result.pending++;
          if (typeof Zotero.logError === "function") Zotero.logError(error);
        }
      }
      return result;
    }
    function maintenance() {
      if (maintenancePromise) return maintenancePromise;
      maintenancePromise = performMaintenance();
      const pending = maintenancePromise;
      pending.finally(() => { if (maintenancePromise === pending) maintenancePromise = null; }).catch(() => {});
      return pending;
    }
    return { load, save, maintenance };
  }
  return { FORMAT, TAG, DEVICE_PREF, MAX_NOTE, MAX_BYTES, PART_SIZE, create, encodeNote, decodeNote, encodePayload, decodePayload, splitPayload,
    checksum, stateHash, normalizeClock, mergeClocks, dominates, sameClock };
});
