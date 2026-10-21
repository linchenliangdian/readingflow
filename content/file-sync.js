/*
 * Reading data is stored beneath one ordinary library item as imported JSON
 * attachments. Each activation owns a new writer lease and each publication
 * imports a new, immutable snapshot. Nothing edits an imported file while
 * Zotero may be uploading it. A lease aggregates multiple reading sessions;
 * retained snapshots are intentionally not compacted until a future protocol
 * can prove they are safely replaceable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReadingFlowFileSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const FILE_FORMAT = "READING_FLOW_FILE_SYNC_V2";
  const RECORD_FORMAT = "READING_FLOW_SYNC_V1";
  const CONTAINER_MARKER = "READING_FLOW_DATA_CONTAINER_V2";
  const CONTAINER_TAG = "Reading flow · data", FILE_TAG = "Reading flow · sync file";
  const MAX_JOURNAL_BYTES = 64 * 1024 * 1024, MAX_RECORDS = 100000;
  const validID = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  function checksum(value) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b); }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }
  function validRecord(value) {
    if (!value || value.format !== RECORD_FORMAT || value.kind !== "head" || !validID(value.ownerKey) ||
        !["item", "note"].includes(value.ownerKind) || !validID(value.deviceID) || !validID(value.revision) ||
        !value.state || typeof value.state !== "object" || Array.isArray(value.state) ||
        !value.state.item || value.state.item.key !== value.ownerKey ||
        typeof value.hash !== "string" || !/^[0-9a-f]{16}$/.test(value.hash) ||
        !value.clock || typeof value.clock !== "object" || Array.isArray(value.clock)) return false;
    const entries = Object.entries(value.clock);
    return entries.length <= 1000 && entries.length > 0 && !!value.clock[value.deviceID] &&
      entries.every(([key, count]) => validID(key) && Number.isSafeInteger(count) && count > 0);
  }
  function recordIdentity(value) { return value.ownerKind + ":" + value.ownerKey + ":" + value.revision + ":" + value.hash; }
  function sameRecord(left, right) {
    function portable(value) {
      const result = clone(value);
      delete result.state.readingFlowSync; delete result.state.updatedAt;
      if (result.state.item) { delete result.state.item.libraryID; delete result.state.item.title; }
      return result;
    }
    return JSON.stringify(portable(left)) === JSON.stringify(portable(right));
  }
  function encodeJournal(writerID, records) {
    if (!validID(writerID) || !Array.isArray(records) || !records.length || records.length > MAX_RECORDS || !records.every(validRecord)) {
      throw new Error("金字塔数据文件内容无效，原数据已保留。");
    }
    const body = JSON.stringify(records), value = JSON.stringify({ format: FILE_FORMAT, version: 2, writerID,
      checksum: checksum(body), records });
    if (new TextEncoder().encode(value).length > MAX_JOURNAL_BYTES) throw new Error("金字塔数据文件超过 64 MB，原数据和本机草稿已保留。");
    return value;
  }
  function decodeJournal(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_JOURNAL_BYTES) throw new Error("金字塔数据文件过大或无效。");
    const value = JSON.parse(text);
    if (!value || value.format !== FILE_FORMAT || value.version !== 2 || !validID(value.writerID) ||
        !Array.isArray(value.records) || !value.records.length || value.records.length > MAX_RECORDS ||
        !value.records.every(validRecord) || value.checksum !== checksum(JSON.stringify(value.records))) {
      throw new Error("金字塔数据文件不完整或已损坏，原数据已保留。");
    }
    const identities = new Set();
    for (const record of value.records) {
      const identity = recordIdentity(record);
      if (identities.has(identity)) throw new Error("金字塔数据文件含重复记录，原数据已保留。");
      identities.add(identity);
    }
    return value;
  }
  function create({ Zotero, IOUtils, PathUtils }) {
    if (!Zotero || !IOUtils || !PathUtils || typeof IOUtils.readUTF8 !== "function" ||
        typeof IOUtils.writeUTF8 !== "function" || typeof PathUtils.join !== "function") {
      throw new Error("Reading flow 文件同步接口不可用，原数据已保留。");
    }
    const writerID = "w-" + (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : Date.now().toString(36) + "-" + Zotero.Utilities.randomString(32));
    const queues = new Map(), ownFiles = new Map(), protectedRevisions = new Map(), downloads = new Map(), downloadAttempts = new Map();
    let publication = 0;
    function queued(libraryID, task) {
      const previous = queues.get(libraryID) || Promise.resolve();
      const current = previous.catch(() => {}).then(task);
      queues.set(libraryID, current);
      current.finally(() => { if (queues.get(libraryID) === current) queues.delete(libraryID); }).catch(() => {});
      return current;
    }
    function isContainer(item) {
      return !!(item && !item.deleted && typeof item.isRegularItem === "function" && item.isRegularItem() &&
        item.itemType === "document" && typeof item.getField === "function" &&
        String(item.getField("extra") || "").split(/\r?\n/).includes(CONTAINER_MARKER));
    }
    function isDataAttachment(item) {
      return !!(item && !item.deleted && typeof item.isStoredFileAttachment === "function" &&
        item.isStoredFileAttachment() && item.parentID &&
        /^application\/json(?:;|$)/i.test(item.attachmentContentType || "") &&
        /^file-sync-\d+-[A-Za-z0-9_-]{1,100}\.json$/.test(item.attachmentFilename || ""));
    }
    function isManagedItem(item) {
      if (isContainer(item)) return true;
      return isDataAttachment(item) && isContainer(Zotero.Items.get(item.parentID));
    }
    async function containers(libraryID) {
      const search = new Zotero.Search(); search.libraryID = libraryID;
      search.addCondition("itemType", "is", "document"); search.addCondition("deleted", "false");
      search.addCondition("extra", "contains", CONTAINER_MARKER);
      const values = [];
      for (const id of await search.search()) {
        const item = await Zotero.Items.getAsync(id);
        if (item && typeof item.loadDataType === "function") {
          await item.loadDataType("itemData"); await item.loadDataType("childItems");
        }
        if (item && item.libraryID === libraryID && isContainer(item)) values.push(item);
      }
      return values.sort((a, b) => a.key.localeCompare(b.key));
    }
    async function attachmentItems(libraryID) {
      const values = [], seen = new Set();
      for (const container of await containers(libraryID)) {
        for (const id of container.getAttachments()) {
          if (seen.has(id)) continue; seen.add(id);
          const item = await Zotero.Items.getAsync(id);
          if (item && item.libraryID === libraryID && item.parentID === container.id &&
              isDataAttachment(item)) values.push(item);
        }
      }
      return values;
    }
    function needsDownload(item) {
      const constants = Zotero.Sync?.Storage?.Local;
      return !!constants && [constants.SYNC_STATE_TO_DOWNLOAD, constants.SYNC_STATE_FORCE_DOWNLOAD,
        constants.SYNC_STATE_IN_CONFLICT].includes(item.attachmentSyncState);
    }
    async function readAttachment(item, { download = false } = {}) {
      let path = await item.getFilePathAsync();
      let available = path && await IOUtils.exists(path);
      if ((!available || needsDownload(item)) && download && typeof Zotero.Sync?.Runner?.downloadFile === "function") {
        // One request per attachment at a time; false means unavailable, never success.
        let pending = downloads.get(item.id);
        if (!pending) {
          pending = Promise.resolve().then(() => Zotero.Sync.Runner.downloadFile(item));
          downloads.set(item.id, pending);
          pending.finally(() => { if (downloads.get(item.id) === pending) downloads.delete(item.id); }).catch(() => {});
        }
        try { await pending; } catch (_) { /* Return pending; preserve any cached draft. */ }
        path = await item.getFilePathAsync(); available = path && await IOUtils.exists(path);
      }
      if (!available || needsDownload(item)) throw new Error("金字塔数据文件尚未下载完成；请完成 Zotero 文件同步后重试。");
      const stat = await IOUtils.stat(path);
      if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_JOURNAL_BYTES) throw new Error("金字塔数据文件大小无效，原数据已保留。");
      const text = await IOUtils.readUTF8(path);
      return { journal: decodeJournal(text), path, text };
    }
    async function read(libraryID) {
      const records = [], pending = [], copies = new Map();
      for (const item of await attachmentItems(libraryID)) {
        try {
          const { journal } = await readAttachment(item);
          for (const record of journal.records) {
            const identity = recordIdentity(record), previous = copies.get(identity) || [];
            // Later immutable snapshots carry earlier owners. Identical copies
            // are one logical record; differing clocks/content remain visible
            // so the synchronizer can detect a real conflict or damaged record.
            if (previous.some(value => sameRecord(value, record))) continue;
            previous.push(record); copies.set(identity, previous);
            records.push({ record: clone(record), sourceKey: item.key });
          }
        }
        catch (error) { pending.push({ key: item.key, reason: error.message || String(error) }); }
      }
      const fingerprint = records.map(({ record, sourceKey }) => sourceKey + ":" + recordIdentity(record))
        .concat(pending.map(value => value.key + ":pending")).sort().join("|");
      return { records, pending, fingerprint };
    }
    async function getWritableContainer(libraryID) {
      const found = await containers(libraryID);
      if (found.length) return found[0];
      const item = new Zotero.Item("document"); item.libraryID = libraryID;
      item.setField("title", "Reading flow 数据"); item.setField("extra", CONTAINER_MARKER);
      await item.saveTx(); return item;
    }
    async function consolidate(libraryID) {
      return queued(libraryID, async () => {
        const library = Zotero.Libraries.get(libraryID);
        if (!library?.editable || library.filesEditable === false || (await containers(libraryID)).length < 2) return 0;
        return Zotero.DB.executeTransaction(async () => {
          const found = await containers(libraryID), canonical = found[0];
          if (!canonical || canonical.deleted) return 0;
          let moved = 0;
          for (const duplicate of found.slice(1)) {
            if (typeof duplicate.loadDataType === "function") await duplicate.loadDataType("tags");
            const attachments = await Zotero.Items.getAsync(duplicate.getAttachments());
            const managed = attachments.filter(item => item && item.libraryID === libraryID &&
              item.parentID === duplicate.id && isManagedItem(item));
            const hasUserContent = duplicate.getNotes().length || managed.length !== attachments.length ||
              duplicate.getField("title") !== "Reading flow 数据" ||
              String(duplicate.getField("extra") || "").trim() !== CONTAINER_MARKER ||
              duplicate.getTags().some(value => value.tag !== CONTAINER_TAG);
            for (const item of managed) {
              // Reparent only native metadata; storage paths, file bytes, keys,
              // and every retained writer version remain exactly the same.
              item.parentID = canonical.id; await item.save(); moved++;
            }
            if (!hasUserContent) await Zotero.Items.trash([duplicate.id]);
          }
          return moved;
        });
      });
    }
    async function write(libraryID, incoming, { replaceOwnCurrent = true } = {}) {
      if (!Array.isArray(incoming) || !incoming.length || !incoming.every(validRecord)) throw new Error("金字塔同步记录无效，原数据已保留。");
      return queued(libraryID, async () => {
        const library = Zotero.Libraries.get(libraryID);
        if (!library?.editable || library.filesEditable === false) throw new Error("此文献库不允许写入附件，金字塔本机草稿已保留。");
        let item = ownFiles.get(libraryID) || null, records = [];
        if (item) {
          if (item.deleted || !isManagedItem(item)) throw new Error("金字塔数据文件关联已改变，本机草稿已保留。");
          const current = await readAttachment(item, { download: false });
          if (current.journal.writerID !== writerID) throw new Error("金字塔数据文件归属已改变，本机草稿已保留。");
          records = current.journal.records;
        }
        const before = JSON.stringify(records);
        const retained = protectedRevisions.get(libraryID) || new Set();
        if (!replaceOwnCurrent) for (const value of incoming) {
          if (value.deviceID !== writerID) continue;
          for (const previous of records) if (previous.deviceID === writerID && previous.ownerKey === value.ownerKey && previous.ownerKind === value.ownerKind) {
            retained.add(recordIdentity(previous));
          }
        }
        for (const value of incoming) {
          const identity = recordIdentity(value), existing = records.find(record => recordIdentity(record) === identity);
          if (existing) {
            if (!sameRecord(existing, value)) throw new Error("金字塔版本内容不一致，原数据已保留。");
            continue;
          }
          if (replaceOwnCurrent && value.deviceID === writerID) records = records.filter(record =>
            record.deviceID !== writerID || record.ownerKey !== value.ownerKey || record.ownerKind !== value.ownerKind || retained.has(recordIdentity(record)));
          records.push(clone(value));
        }
        const text = encodeJournal(writerID, records);
        if (item && before === JSON.stringify(records)) return { sourceKey: item.key, fingerprint: item.key + ":" + checksum(text) };
        const directory = PathUtils.join(Zotero.DataDirectory.dir, "reading-flow");
        await IOUtils.makeDirectory(directory, { ignoreExisting: true });
        const container = await getWritableContainer(libraryID);
        const snapshotID = writerID + "-" + (++publication).toString(36) + "-" + Zotero.Utilities.randomString(12);
        const temporary = PathUtils.join(directory, "file-sync-" + libraryID + "-" + snapshotID + ".json");
        await IOUtils.writeUTF8(temporary, text, { tmpPath: temporary + ".tmp" });
        try {
          // An imported attachment is immutable even during this activation.
          // Zotero can finish syncing the old snapshot without racing an edit
          // to its bytes, hash, mtime, or upload metadata.
          item = await Zotero.Attachments.importFromFile({ file: temporary, parentItemID: container.id,
            title: "Reading flow · 数据 · " + writerID.slice(0, 14), contentType: "application/json" });
          item.attachmentSyncState = "to_upload"; await item.saveTx();
        }
        finally {
          // Only our own temporary import source is removed; imported storage stays native.
          if (typeof IOUtils.remove === "function") await IOUtils.remove(temporary, { ignoreAbsent: true }).catch(() => {});
        }
        const reread = await readAttachment(item, { download: false });
        if (JSON.stringify(reread.journal.records) !== JSON.stringify(records)) throw new Error("金字塔数据文件读回校验失败，本机草稿已保留。");
        ownFiles.set(libraryID, item); protectedRevisions.set(libraryID, retained);
        return { sourceKey: item.key, fingerprint: item.key + ":" + checksum(text) };
      });
    }
    async function uploaded(libraryID, expected) {
      if (!Array.isArray(expected) || !expected.length || !expected.every(validRecord)) return false;
      const found = new Set(), constant = Zotero.Sync?.Storage?.Local?.SYNC_STATE_IN_SYNC;
      if (constant === undefined || typeof Zotero.Utilities?.Internal?.md5Async !== "function") return false;
      for (const item of await attachmentItems(libraryID)) {
        if (item.synced !== true || item.attachmentSyncState !== constant || !/^[0-9a-f]{32}$/i.test(item.attachmentSyncedHash || "")) continue;
        try {
          const { journal, path, text } = await readAttachment(item, { download: false });
          const hash = await Zotero.Utilities.Internal.md5Async(path);
          if (!hash || hash.toLowerCase() !== item.attachmentSyncedHash.toLowerCase() ||
              item.synced !== true || item.attachmentSyncState !== constant) continue;
          // Bind the decoded records to those exact uploaded bytes, not merely a
          // path whose contents could have changed while an async hash was read.
          if (typeof Zotero.Utilities.Internal.md5 !== "function" ||
              Zotero.Utilities.Internal.md5(text).toLowerCase() !== hash.toLowerCase()) continue;
          for (const record of journal.records) {
            for (const value of expected) if (recordIdentity(record) === recordIdentity(value) && sameRecord(record, value)) {
              found.add(recordIdentity(value));
            }
          }
        }
        catch (_) { /* Missing/stale/corrupt files never authorize legacy removal. */ }
      }
      return expected.every(record => found.has(recordIdentity(record)));
    }
    async function requestDownloads(libraryID) {
      const requested = [];
      if (typeof Zotero.Sync?.Runner?.downloadFile !== "function") return requested;
      for (const item of await attachmentItems(libraryID)) {
        const path = await item.getFilePathAsync(), available = path && await IOUtils.exists(path);
        if (available && !needsDownload(item)) continue;
        let request = downloads.get(item.id);
        if (!request) {
          if (Date.now() - (downloadAttempts.get(item.id) || 0) < 60000) continue;
          downloadAttempts.set(item.id, Date.now());
          // Zotero owns the actual network task and native file installation.
          // Completion only clears volatile bookkeeping: no plugin DB mutation
          // runs later if Reading flow has been disabled or shut down meanwhile.
          request = Promise.resolve().then(() => Zotero.Sync.Runner.downloadFile(item));
          downloads.set(item.id, request);
          request.finally(() => { if (downloads.get(item.id) === request) downloads.delete(item.id); }).catch(() => {});
        }
        requested.push(request.then(result => ({ key: item.key, downloaded: !!result }),
          () => ({ key: item.key, downloaded: false })));
      }
      return Promise.all(requested);
    }
    return { writerID, read, write, uploaded, isManagedItem, requestDownloads, consolidate };
  }
  return { FILE_FORMAT, RECORD_FORMAT, CONTAINER_MARKER, CONTAINER_TAG, FILE_TAG, MAX_JOURNAL_BYTES,
    MAX_RECORDS, validRecord, recordIdentity, sameRecord, encodeJournal, decodeJournal, checksum, create };
});
