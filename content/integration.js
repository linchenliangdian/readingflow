/* Zotero 9 sidebar boundary. The main editor is Zotero's native note-editor. */
var ReadingFlowIntegration = (function () {
  "use strict";
  const core = ReadingFlowCore;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
  const SIDEBAR_NOTE_TAG = "Reading Flow · sidebar";
  const ICON = "chrome://reading-flow/content/icons/pyramid.svg";
  const hosts = new Map(), saveQueues = new Map(), pendingOpens = new Set(), pendingDetaches = new Set(), detachOperations = new Map(), noteQueues = new Map(), activeHandles = new Map(), focusVersions = new Map(), menuIDs = [];
  const unsavedNotes = new WeakMap();
  const localRecords = new Map(), dataDownloads = new Map();
  let syncStore = null, fileStore = null, migrationPromise = null, syncRefreshTimer = null;
  let dataMaintenancePromise = null, dataMaintenanceTimer = null, dataMaintenanceAgain = false;
  let resourceVersion = "";
  let active = false, dataDirectory = null, FilePicker = null, publicAPI = null, registeredPaneID = null, readerHandler = null, notifierID = null, stopPromise = null;
  function sessionKey(item) { return item.libraryID + "-" + item.key; }
  function draftPath(item) { return PathUtils.join(dataDirectory, sessionKey(item) + ".json"); }
  function standaloneNote(item) { return !!(item && !item.deleted && typeof item.isNote === "function" && item.isNote() && !item.parentID); }
  function parentOf(item) {
    if (fileStore?.isManagedItem(item)) return null;
    if (item && typeof item.isNote === "function" && item.isNote() && typeof item.getNote === "function" && item.getNote().includes("READING_FLOW_SYNC_V1")) return null;
    if (standaloneNote(item)) return item;
    const parent = item && (item.topLevelItem || item);
    return parent && parent.isRegularItem() && !parent.deleted && !fileStore?.isManagedItem(parent) ? parent : null;
  }
  function identity(parent) {
    const note = typeof parent.isNote === "function" && parent.isNote();
    const title = note && typeof parent.getNoteTitle === "function" ? parent.getNoteTitle() : typeof parent.getField === "function" ? parent.getField("title") : "";
    return { libraryID: parent.libraryID, key: parent.key, title: title || (note ? "未命名笔记" : "未命名文献") };
  }
  function validNativeNote(note, item, parentID) {
    return !!(note && item && !note.deleted && note.isNote() && note.libraryID === item.libraryID &&
      (parentID === null ? !note.parentID && note.key === item.key : note.parentID === parentID));
  }
  function validHandleNote(handle) { return validNativeNote(handle.note, handle.item, handle.parentID); }
  function disableUnboundInstance(handle, instance) {
    if (instance && !instance._disableSaving) { instance._disableSaving = true; handle.invalidatedNativeInstance = instance; }
  }
  function stopSavingUnboundNote(handle) {
    if (!handle.note || validHandleNote(handle)) return;
    const instance = handle.editor && handle.editor.getCurrentInstance();
    disableUnboundInstance(handle, instance);
  }
  function selectedParent(context, window) {
    let items = context && Array.isArray(context.items) ? context.items.filter(Boolean) : [];
    if (!items.length && window && window.Zotero_Tabs && window.Zotero_Tabs.selectedType !== "library") {
      const host = hosts.get(window), handle = host && host.panels.get("reader");
      const target = handle && panelParent(handle); if (target) return target;
    }
    if (!items.length && window && window.reader) items = [Zotero.Items.get(window.reader.itemID)];
    if (!items.length && window && window.Zotero_Tabs && window.Zotero_Tabs.selectedType !== "library") {
      const reader = Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID);
      if (reader) items = [Zotero.Items.get(reader.itemID)];
    }
    if (!items.length && window && window.ZoteroPane) items = window.ZoteroPane.getSelectedItems().filter(Boolean);
    return items.length === 1 ? parentOf(items[0]) : null;
  }
  function ownerWindow(event) { return event && event.target && event.target.ownerDocument ? event.target.ownerDocument.defaultView : Zotero.getMainWindow(); }
  function showError(error, window) {
    Zotero.logError(error);
    const host = hosts.get(window || Zotero.getMainWindow());
    const handle = host && Array.from(host.panels.values()).find(p => p.deck.selectedPanel === p.panel);
    const app = handle && handle.frame.contentWindow && handle.frame.contentWindow.ReadingFlowApp;
    if (app && typeof app.showNotice === "function") { app.showNotice(error.message || String(error)); return; }
    Services.prompt.alert(window || Zotero.getMainWindow(), "Reading Flow 阅读台", error.message || String(error));
  }
  function snapshot(state, item) { const normalized = core.normalizeSession(state, item); normalized.updatedAt = Date.now(); return normalized; }
  function serialized(state) {
    const content = JSON.stringify(state, null, 2) + "\n";
    if (new TextEncoder().encode(content).byteLength > MAX_BACKUP_BYTES) throw new Error("阅读数据超过 16 MB，请精简过长的原文摘录后重试。");
    return content;
  }
  function queueSave(item, work) {
    const key = sessionKey(item);
    const operation = (saveQueues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    saveQueues.set(key, operation); operation.catch(error => Zotero.logError(error)); return operation;
  }
  async function writeDraft(item, state, meta, { published = false } = {}) {
    const value = snapshot(state, item), path = draftPath(item);
    // A timer may expire while a successful file publication is awaiting I/O.
    // Bind its clean-cache baseline to the canonical view actually persisted.
    // Unpublished and ordinary draft writes retain the last published baseline.
    if (meta) value.readingFlowSync = published ? { ...meta, stateHash: ReadingFlowSync.stateHash(value) } : meta;
    const content = serialized(value);
    await IOUtils.makeDirectory(dataDirectory, { ignoreExisting: true });
    await IOUtils.writeUTF8(path, content, { tmpPath: path + ".tmp" });
    localRecords.set(sessionKey(item), value);
    return { message: "已保存", path };
  }
  function saveState(item, state) {
    return queueSave(item, () => writeDraft(item, state, localRecords.get(sessionKey(item))?.readingFlowSync));
  }
  function requestDataDownloads(libraryID) {
    const store = fileStore;
    if (!active || !store?.requestDownloads || dataDownloads.has(libraryID)) return;
    const request = Promise.resolve().then(() => store.requestDownloads(libraryID));
    dataDownloads.set(libraryID, request);
    request.then(results => {
      if (active && fileStore === store && results?.some(result => result.downloaded)) {
        scheduleDataMaintenance(); scheduleSyncRefresh();
      }
    }).catch(error => { if (active && fileStore === store) Zotero.logError(error); })
      .finally(() => { if (dataDownloads.get(libraryID) === request) dataDownloads.delete(libraryID); });
  }
  async function loadSyncedState(item, localRaw) {
    try {
      const loaded = await syncStore.load(item, localRaw);
      if (loaded.pending) requestDataDownloads(item.libraryID);
      return loaded;
    } catch (error) { requestDataDownloads(item.libraryID); throw error; }
  }
  function saveSyncedState(item, state, token, options) {
    return queueSave(item, async () => {
      if (options?.canPublish && !options.canPublish()) return { ignored: true };
      if (options?.migration) {
        const busy = () => !active || activeHandles.has(sessionKey(item)) || pendingOpens.size > 0;
        if (busy()) return { ignored: true };
        const raw = await readJSON(draftPath(item)); localRecords.set(sessionKey(item), raw);
        const fresh = await loadSyncedState(item, raw);
        if (busy() || fresh.conflict || fresh.pending || !fresh.needsPublish && fresh.hasRemote) return { ignored: true };
        state = fresh.state; token = fresh.token;
      }
      const oldMeta = localRecords.get(sessionKey(item))?.readingFlowSync;
      await writeDraft(item, state, { ...oldMeta, pending: true });
      const result = await syncStore.save(item, state, typeof token === "function" ? token() : token, options);
      await writeDraft(item, state, result.cacheMeta, { published: true });
      return result;
    });
  }
  async function readJSON(path) {
    if ((await IOUtils.stat(path)).size > MAX_BACKUP_BYTES) throw new Error("备份超过 16 MB，无法导入。");
    try { return JSON.parse(await IOUtils.readUTF8(path)); }
    catch (_) { throw new Error("无法读取阅读数据，请保留原文件并检查 JSON 格式。\n" + path); }
  }
  async function initialState(item) {
    const key = sessionKey(item), pending = saveQueues.get(key);
    if (pending) {
      try { await pending; }
      catch (_) { if (saveQueues.get(key) === pending) saveQueues.delete(key); }
    }
    const path = draftPath(item); if (!(await IOUtils.exists(path))) { localRecords.delete(key); return core.createSession(item); }
    try { const raw = await readJSON(path); localRecords.set(key, raw); return core.normalizeSession(raw, item); }
    catch (error) { throw new Error(error.message + "\n本机草稿：" + path); }
  }
  function safeName(title) { return title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 70) || "reading-flow"; }
  async function exportJSON(item, state, window) {
    const content = serialized(snapshot(state, item)), picker = new FilePicker();
    picker.init(window || Zotero.getMainWindow(), "导出阅读备份", picker.modeSave); picker.appendFilter("Reading Flow JSON", "*.json");
    picker.defaultExtension = "json"; picker.defaultString = safeName(item.title) + "-" + item.key + ".reading-flow.json";
    const result = await picker.show(); if (result !== picker.returnOK && result !== picker.returnReplace) return { cancelled: true, message: "已取消导出" };
    const path = picker.file; await IOUtils.writeUTF8(path, content, { tmpPath: path + ".reading-flow-" + Zotero.Utilities.randomString(8) + ".tmp" });
    return { message: "阅读备份已导出", path };
  }
  async function importJSON(item, window) {
    const picker = new FilePicker(); picker.init(window || Zotero.getMainWindow(), "导入当前文献的阅读备份", picker.modeOpen); picker.appendFilter("Reading Flow JSON", "*.json");
    if ((await picker.show()) !== picker.returnOK) return null; return core.normalizeSession(await readJSON(picker.file), item);
  }
  async function backupBeforeNoteRelink(item) {
    const path = draftPath(item); if (!(await IOUtils.exists(path))) return null;
    const backupPath = path.replace(/\.json$/, ".before-note-relink-" + Date.now() + "-" + Zotero.Utilities.randomString(8) + ".json");
    // Zotero 9 supports raw-byte IO, preserving even a UTF-8 BOM in the original.
    if (typeof IOUtils.read === "function" && typeof IOUtils.write === "function") await IOUtils.write(backupPath, await IOUtils.read(path), { tmpPath: backupPath + ".tmp" });
    else await IOUtils.writeUTF8(backupPath, await IOUtils.readUTF8(path), { tmpPath: backupPath + ".tmp" });
    return backupPath;
  }
  async function managedNote(parent, item, state, options = {}) {
    const key = sessionKey(item), pending = noteQueues.get(key);
    if (pending) { const result = await pending; state.noteKey = result.note ? result.note.key : state.noteKey; return result; }
    const operation = (async () => {
      const library = Zotero.Libraries.get(item.libraryID), editable = !!(library && library.editable);
      if (parent.isNote()) {
        if (!validNativeNote(parent, item, null)) throw new Error("独立笔记已移除或移到文献下，请重新选择笔记后打开阅读台。");
        if (state.noteKey && state.noteKey !== parent.key) throw new Error("独立笔记的草稿关联不匹配，请保留草稿并检查备份。");
        if (state.noteKey !== parent.key) { state.noteKey = parent.key; await saveState(item, state); }
        if (!validNativeNote(parent, item, null)) throw new Error("独立笔记已改变，请重新打开阅读台；工具草稿已保留。");
        return { note: parent, readOnly: !editable, notice: "" };
      }
      let note = state.noteKey ? await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, state.noteKey) : null;
      if (!note && state.noteKey && options.waitForSyncedNote) return { note: null, readOnly: !editable, notice: "阅读正文尚未同步到本机，请先完成 Zotero 同步；金字塔已保留。", awaitingSyncedNote: true };
      if (note && (!note.isNote() || note.libraryID !== item.libraryID)) throw new Error("草稿关联的条目不是当前文献库中的笔记。请保留草稿并检查关联。");
      if (note && note.parentID !== parent.id) throw new Error("阅读笔记已移到另一篇文献。请保留草稿，检查原文献下的 Reading Flow 笔记。");
      const recovery = state.noteKey && (!note || note.deleted) ? note ? "trashed" : "missing" : null;
      // A valid persisted key is the binding; its user-editable tags are not required.
      // Trashed notes remain in the trash with their original contents untouched.
      if (note && note.deleted) note = null;
      if (!note) {
        const candidates = [];
        if (typeof parent.loadDataType === "function") await parent.loadDataType("childItems");
        for (const noteID of parent.getNotes()) {
          const candidate = await Zotero.Items.getAsync(noteID);
          if (!candidate || candidate.deleted || !candidate.isNote() || candidate.libraryID !== item.libraryID || candidate.parentID !== parent.id) continue;
          if (typeof candidate.loadDataType === "function") await candidate.loadDataType("tags");
          if (candidate.hasTag(SIDEBAR_NOTE_TAG)) candidates.push(candidate);
        }
        // Multiple marked notes may be copies. Preserve them rather than guessing.
        if (candidates.length === 1) note = candidates[0];
      }
      if (!note && !editable) return { note: null, readOnly: true, notice: recovery ? "原阅读笔记已移除；当前文献库只读，倒计时和金字塔草稿仍保留。" : "" };
      if (recovery) await backupBeforeNoteRelink(item);
      const created = !note;
      if (!note) {
        await queueSave(item, () => Zotero.DB.executeTransaction(async () => {
          note = new Zotero.Item("note"); note.libraryID = item.libraryID; note.parentID = parent.id;
          note.setNote(core.renderStarterNoteHTML ? core.renderStarterNoteHTML(state) : core.renderNoteHTML(state)); await note.save();
          state.noteKey = note.key;
          await writeDraft(item, state, localRecords.get(key)?.readingFlowSync);
        }));
      }
      if (state.noteKey !== note.key) { state.noteKey = note.key; await saveState(item, state); }
      const notice = recovery ? (recovery === "trashed" ? "原阅读笔记在回收站。" : "原阅读笔记已移除。") + (created ? "已建立新笔记" : "已重新关联现有阅读笔记") + "，并保留倒计时和金字塔草稿。" : "";
      return { note, readOnly: !editable, notice };
    })();
    noteQueues.set(key, operation);
    try { return await operation; } finally { if (noteQueues.get(key) === operation) noteQueues.delete(key); }
  }
  async function cleanLegacyNoteTags(note, item, parentID) {
    if (parentID === null || !validNativeNote(note, item, parentID)) return;
    let previousTags = null;
    try {
      if (typeof note.loadDataType === "function") await note.loadDataType("tags");
      if (!note.hasTag(SIDEBAR_NOTE_TAG)) return;
      await Zotero.DB.executeTransaction(async () => {
        if (!validNativeNote(note, item, parentID) || !Zotero.Libraries.get(item.libraryID)?.editable || !note.hasTag(SIDEBAR_NOTE_TAG)) return;
        previousTags = note.getTags();
        note.removeTag(SIDEBAR_NOTE_TAG); note.removeTag("Reading Flow");
        await note.save({ skipDateModifiedUpdate: true });
      });
    } catch (error) {
      if (previousTags) {
        if (typeof note.reload === "function") { try { await note.reload(["tags"], true); } catch (reloadError) { Zotero.logError(reloadError); } }
        else note.setTags(previousTags);
      }
      Zotero.logError(error);
    }
  }
  async function flushNative(handle) {
    stopSavingUnboundNote(handle);
    if (!handle.editor || !validHandleNote(handle) || handle.readOnly) return;
    const note = handle.note, item = handle.item, parentID = handle.parentID, instance = handle.editor.getCurrentInstance(); if (!instance) return; await instance._initPromise;
    if (handle.note !== note || !validNativeNote(note, item, parentID)) { if (!validNativeNote(note, item, parentID)) disableUnboundInstance(handle, instance); return; }
    handle.editor.saveSync();
    const frameWindow = instance._iframeWindow && (instance._iframeWindow.wrappedJSObject || instance._iframeWindow);
    const data = frameWindow && typeof frameWindow.getDataSync === "function" ? frameWindow.getDataSync(true) : null;
    if (data && validNativeNote(note, item, parentID) && typeof instance._save === "function") await instance._save(JSON.parse(JSON.stringify(data)));
  }
  async function flushHandle(handle) {
    const app = toolsWindow(handle) && toolsWindow(handle).ReadingFlowApp;
    if (app && typeof app.flushPendingSave === "function") await app.flushPendingSave(); await flushNative(handle);
  }
  async function exportNote(handle) {
    await flushNative(handle);
    if (!validHandleNote(handle)) throw new Error("阅读笔记已移除或关联已改变；请重新打开阅读台，草稿仍保留。");
    if (handle.readOnly) throw new Error("此文献库不允许写入笔记，阅读草稿已保存。");
    return { message: handle.parentID === null ? "已保存到当前独立笔记" : "已保存到文献下的阅读笔记", noteKey: handle.note.key };
  }
  async function insertPyramid(handle, image) {
    if (handle.readOnly || !handle.note) throw new Error("当前文献库不允许编辑笔记。");
    if (!validHandleNote(handle)) { stopSavingUnboundNote(handle); throw new Error("阅读笔记已移除或关联已改变；请重新打开阅读台，草稿仍保留。"); }
    const { pngDataURL, width, height } = image || {};
    if (typeof pngDataURL !== "string" || pngDataURL.length > MAX_BACKUP_BYTES || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(pngDataURL)
      || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8000000) throw new Error("金字塔图片格式或大小无效，请重新生成。");
    const note = handle.note, editor = handle.editor, generation = handle.generation;
    let instance = editor.getCurrentInstance();
    if (!instance) throw new Error("笔记编辑器仍在载入，请稍后重试。"); await instance._initPromise;
    const stillBound = () => !handle.disposed && handle.generation === generation && handle.editor === editor && handle.note === note && validHandleNote(handle);
    const requireBound = () => { if (!stillBound()) { stopSavingUnboundNote(handle); throw new Error("当前笔记已改变，请重新打开阅读台后插入。"); } };
    requireBound();
    const library = Zotero.Libraries.get(note.libraryID);
    if (!library || !library.editable || library.filesEditable === false || instance._filesReadOnly) throw new Error("此文献库不允许保存图片附件；金字塔内容已保留。");
    const originalFrame = instance._iframeWindow && (instance._iframeWindow.wrappedJSObject || instance._iframeWindow);
    const originalData = originalFrame && typeof originalFrame.getDataSync === "function" ? originalFrame.getDataSync(false) : null;
    if (!originalData || typeof instance._save !== "function" || typeof instance._importImage !== "function") throw new Error("无法确认图片已插入笔记，请重新打开阅读台后重试。");
    // Commit the current prose before import notifies other editors of this note.
    await instance._save(JSON.parse(JSON.stringify(originalData))); requireBound();
    const attachmentKey = await instance._importImage(pngDataURL); requireBound();
    const attachment = typeof attachmentKey === "string" && /^[A-Z0-9]{8}$/.test(attachmentKey)
      ? await Zotero.Items.getByLibraryAndKeyAsync(note.libraryID, attachmentKey) : null;
    requireBound();
    if (!attachment || attachment.deleted || typeof attachment.isEmbeddedImageAttachment !== "function" || !attachment.isEmbeddedImageAttachment()
      || attachment.libraryID !== note.libraryID || attachment.parentID !== note.id) throw new Error("金字塔图片附件未正确保存到当前笔记，请重试；金字塔内容已保留。");
    const path = await attachment.getFilePathAsync(); requireBound();
    if (!path || !(await IOUtils.exists(path))) throw new Error("金字塔图片文件尚未保存，请重试；金字塔内容已保留。");
    // Import can refresh the note editor. Read its live selection afterwards.
    instance = editor.getCurrentInstance();
    if (!instance) throw new Error("笔记编辑器仍在载入，请稍后重试。"); await instance._initPromise; requireBound();
    const frame = instance._iframeWindow && (instance._iframeWindow.wrappedJSObject || instance._iframeWindow);
    if (!frame || typeof frame.getDataSync !== "function") throw new Error("无法确认图片已插入笔记，请重新打开阅读台后重试。");
    const before = frame.getDataSync(false);
    const html = '<p><img data-attachment-key="' + attachmentKey + '" alt="金字塔：结论与支持论据" width="' + Math.min(width, 1200) + '" height="' + Math.round(height * Math.min(width, 1200) / width) + '" /></p>';
    let exportedState = before && before.state;
    if (typeof exportedState === "string") { try { exportedState = JSON.parse(exportedState); } catch (_) { exportedState = null; } }
    const editorState = frame._currentEditorInstance?._editorCore?.view?.state;
    let position = -1;
    for (const candidate of [editorState, exportedState]) {
      const to = candidate?.selection?.to, size = candidate?.doc?.content?.size;
      if (Number.isInteger(to) && Number.isInteger(size) && to >= 0 && to <= size) { position = to; break; }
    }
    // Insert only the durable attachment reference. No editor ever receives a
    // transient data URL to re-import when another note view updates it.
    // A numeric cursor avoids the native null-position branch's invalid selection.
    instance._postMessage({ action: "insertHTML", pos: position, html });
    const deadline = Date.now() + 15000, keyPattern = new RegExp('data-attachment-key=["\']' + attachmentKey + '["\']');
    let delay = 50;
    while (true) {
      requireBound();
      // false returns the complete current document even after its automatic save.
      const data = frame.getDataSync(false);
      if (keyPattern.test(data?.html || "")) break;
      if (Date.now() >= deadline || handle.hostWindow.closed) throw new Error("图片尚未完成插入，请稍后检查笔记；金字塔内容已保留。");
      await new Promise(resolve => handle.hostWindow.setTimeout(resolve, delay)); delay = Math.min(400, delay * 2);
    }
    await flushNative(handle); requireBound();
    const finalData = frame.getDataSync(false);
    if (!finalData || !keyPattern.test(finalData.html || "") || typeof instance._save !== "function") throw new Error("无法确认图片已保存，请稍后重试；金字塔内容已保留。");
    // saveSync schedules an asynchronous native save and can reset docChanged.
    // Await a complete-document save so success follows the committed note write.
    await instance._save(JSON.parse(JSON.stringify(finalData))); requireBound();
    const persisted = await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [note.id]); requireBound();
    if (!keyPattern.test(persisted || "")) throw new Error("图片尚未保存到笔记，请稍后重试；金字塔内容已保留。");
    return { message: "金字塔已插入笔记" };
  }
  function findButton(handle) { return handle.sidenav && Array.from(handle.sidenav.querySelectorAll(".btn[data-pane]")).find(node => node.dataset.pane === registeredPaneID); }
  function nativeEditor(doc, kind) {
    const editor = doc.createXULElement("note-editor"); editor.id = "reading-flow-" + kind + "-note-editor"; editor.setAttribute("flex", "1"); editor.setAttribute("notitle", "1"); editor.style.cssText = "min-width:0;min-height:0;flex:1";
    return editor;
  }
  async function rebuildInvalidatedEditor(handle, note, generation) {
    const editor = handle.editor, instance = editor.getCurrentInstance();
    if (!instance || instance !== handle.invalidatedNativeInstance || note !== handle.note) return false;
    if (typeof instance.uninit === "function") await instance.uninit();
    if (!active || handle.disposed || generation !== handle.generation || handle.editor !== editor || handle.note !== note) return false;
    if (editor._editorInstance === instance) editor._editorInstance = null;
    const replacement = nativeEditor(handle.hostWindow.document, handle.kind);
    handle.panel.append(replacement); editor.remove(); handle.editor = replacement; handle.invalidatedNativeInstance = null;
    return true;
  }
  function toolsWindow(handle) { const window = handle.frame.contentWindow; return window && (window.wrappedJSObject || window); }
  function enableNativeNoteTarget(handle) {
    if (handle.kind !== "reader" || !handle.pane) return;
    let prototype = handle.pane, getter = null;
    handle.originalActiveEditorDescriptor = Object.getOwnPropertyDescriptor(handle.pane, "activeEditor");
    while (prototype && !getter) { const descriptor = Object.getOwnPropertyDescriptor(prototype, "activeEditor"); if (descriptor && descriptor.get) getter = descriptor.get; prototype = Object.getPrototypeOf(prototype); }
    if (!getter) return;
    handle.originalActiveEditorGetter = getter;
    Object.defineProperty(handle.pane, "activeEditor", {
      configurable: true,
      get() {
        if (handle.deck.selectedPanel === handle.panel) {
          if (validHandleNote(handle)) return handle.editor;
          stopSavingUnboundNote(handle);
        }
        return getter.call(this);
      }
    });
    handle.nativeNoteTargetEnabled = true;
  }
  function updateNativeNoteTarget(handle) {
    if (handle.kind === "reader" && handle.hostWindow.ZoteroContextPane && typeof handle.hostWindow.ZoteroContextPane.updateAddToNote === "function") handle.hostWindow.ZoteroContextPane.updateAddToNote();
  }
  function hideOwnNoteFooter(editor) {
    // Native edit/view mode otherwise shows the note's technical tag/link footer.
    // Hide only our editor's footer; the note metadata remains available in Zotero.
    const footer = editor.querySelector("#links-container");
    if (footer) { footer.hidden = true; footer.style.display = "none"; }
  }
  function refreshLibraryNoteRail(handle) {
    if (!active || handle.disposed || handle.kind !== "library" || handle.refreshingNoteRail || !registeredPaneID) return;
    handle.refreshingNoteRail = true;
    try {
      const selected = handle.hostWindow.ZoteroPane && handle.hostWindow.ZoteroPane.getSelectedItems();
      const note = selected && selected.length === 1 && standaloneNote(selected[0]) ? selected[0] : null;
      if (note && !findButton(handle) && handle.pane && handle.pane._itemDetails && typeof handle.pane._itemDetails.renderCustomSections === "function") handle.pane._itemDetails.renderCustomSections();
      const button = findButton(handle); if (!button) return;
      if (note) {
        button.removeAttribute("disabled");
        if (button.parentElement) button.parentElement.hidden = false;
        labelButtons(hosts.get(handle.hostWindow));
      } else if (handle.pane && handle.pane.mode === "note") {
        button.setAttribute("disabled", "true");
        if (button.parentElement) button.parentElement.hidden = true;
      }
    } catch (error) { Zotero.logError(error); }
    finally { handle.refreshingNoteRail = false; }
  }
  function wrapLibraryMethod(handle, owner, key, createWrapper) {
    if (!owner || typeof owner[key] !== "function") return;
    const original = owner[key], descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const wrapper = createWrapper(original); owner[key] = wrapper;
    handle.noteHooks.push({ owner, key, descriptor, wrapper });
  }
  function setupLibraryNoteHooks(handle) {
    if (handle.kind !== "library") return;
    handle.noteHooks = [];
    wrapLibraryMethod(handle, handle.sidenav, "renderDefaultStatus", original => function () {
      const result = original.apply(this, arguments); refreshLibraryNoteRail(handle); return result;
    });
    wrapLibraryMethod(handle, handle.pane, "renderNoteEditor", original => function (note) {
      const wasActive = handle.deck.selectedPanel === handle.panel;
      const result = original.apply(this, arguments);
      if (active && !handle.disposed) {
        refreshLibraryNoteRail(handle);
        if (wasActive && standaloneNote(note)) openInHandle(handle, note).catch(error => showError(error, handle.hostWindow));
      }
      return result;
    });
  }
  function removeLibraryNoteHooks(handle) {
    for (const { owner, key, descriptor, wrapper } of handle.noteHooks || []) {
      // Preserve wrappers installed later by another plugin. Ours becomes inert.
      if (owner[key] !== wrapper) continue;
      if (descriptor) Object.defineProperty(owner, key, descriptor); else delete owner[key];
    }
    handle.noteHooks = [];
  }
  function originalReaderEditor(handle) {
    try { return handle.originalActiveEditorGetter && handle.originalActiveEditorGetter.call(handle.pane); }
    catch (_) { return null; }
  }
  function readerContextToken(handle) {
    const window = handle.hostWindow;
    return window.Zotero_Tabs ? window.Zotero_Tabs.selectedID : window.reader && window.reader.itemID;
  }
  async function flushExternalNote(handle, note) {
    const library = Zotero.Libraries.get(note.libraryID); if (!library || !library.editable) return;
    const editor = handle.kind === "library" ? handle.hostWindow.document.getElementById("zotero-note-editor") : originalReaderEditor(handle);
    if (!editor || editor.item !== note || !editor.getCurrentInstance || handle.editor === editor) return;
    const instance = editor.getCurrentInstance(); if (!instance) return; await instance._initPromise;
    if (editor.item !== note || !standaloneNote(note) || instance._disableSaving) return;
    editor.saveSync();
    const window = instance._iframeWindow && (instance._iframeWindow.wrappedJSObject || instance._iframeWindow);
    const data = window && typeof window.getDataSync === "function" ? window.getDataSync(true) : null;
    if (data && editor.item === note && standaloneNote(note) && typeof instance._save === "function") await instance._save(JSON.parse(JSON.stringify(data)));
  }
  async function prepareStandaloneNote(handle, note) {
    const pending = unsavedNotes.get(note); if (pending) return pending;
    const operation = (async () => {
      const library = Zotero.Libraries.get(note.libraryID);
      if (!library || !library.editable) throw new Error("请先在可编辑的文献库保存这篇独立笔记，再打开阅读台。");
      await flushExternalNote(handle, note);
      if (!standaloneNote(note)) throw new Error("独立笔记已改变，请重新选择笔记。");
      if (!note.id || !note.key) await note.saveTx();
      if (!note.id || !note.key) throw new Error("独立笔记尚未保存，请稍后重试。");
    })();
    unsavedNotes.set(note, operation);
    try { return await operation; } finally { if (unsavedNotes.get(note) === operation) unsavedNotes.delete(note); }
  }
  function pyramidHeightPreference() {
    try { const value = Zotero.Prefs.get("readingFlow.pyramidHeight"); return Number.isInteger(value) && value >= 64 && value <= 1600 ? value : null; }
    catch (_) { return null; }
  }
  function savePyramidHeight(value) {
    if (value !== null && (!Number.isInteger(value) || value < 64 || value > 1600)) throw new Error("显示高度无效，请重新调整。");
    if (value === null) Zotero.Prefs.clear("readingFlow.pyramidHeight");
    else Zotero.Prefs.set("readingFlow.pyramidHeight", value);
    for (const host of hosts.values()) for (const handle of host.panels.values()) if (handle.config) handle.config.pyramidHeight = value;
    return value;
  }
  function resizeTools(handle, requestedHeight, options) {
    if (handle.disposed) return handle.allocatedToolsHeight;
    if (options && typeof options.manual === "boolean") handle.manualToolsHeight = options.manual;
    const requested = Number(requestedHeight);
    if (Number.isFinite(requested) && requested > 0) handle.requestedToolsHeight = Math.max(58, Math.ceil(requested));
    let panelRect = handle.panel.getBoundingClientRect();
    const viewportHeight = Number(handle.hostWindow.innerHeight);
    const panelTop = Number.isFinite(Number(panelRect.top)) ? Math.max(0, Number(panelRect.top)) : 0;
    const viewportAvailable = Number.isFinite(viewportHeight) && viewportHeight > 0 ? Math.max(0, Math.floor(viewportHeight - panelTop)) : null;
    if (Number(panelRect.height) > 0 && viewportAvailable !== null && viewportAvailable > 0) {
      // Reader XUL decks can retain their previous tall height after window.resizeTo.
      // Limit only our sibling panel to the current visible viewport. The cap comes
      // from the viewport, so a later larger window can expand this panel again.
      const maxHeight = viewportAvailable + "px";
      if (handle.panel.style.maxHeight !== maxHeight) handle.panel.style.maxHeight = maxHeight;
      panelRect = handle.panel.getBoundingClientRect();
    }
    const panelHeight = viewportAvailable === null ? Number(panelRect.height) || 0 : Math.min(Number(panelRect.height) || 0, viewportAvailable);
    handle.visiblePanelHeight = panelHeight;
    let allocated = handle.allocatedToolsHeight;
    if (panelHeight > 0) {
      handle.lastPositivePanelHeight = panelHeight;
      // The native toolbar remains visible; our technical metadata footer is hidden.
      const noteReserve = Math.min(160, Math.max(80, Math.round(panelHeight * .3)));
      const cap = Math.max(58, handle.manualToolsHeight ? Math.floor(panelHeight - noteReserve) : Math.min(Math.floor(panelHeight * .65), Math.floor(panelHeight - noteReserve)));
      allocated = Math.min(handle.requestedToolsHeight, cap);
    }
    else {
      // Hidden XUL deck panels have no height. Keep the expanded request for the
      // next visible layout; a temporary zero must never become a smaller request.
      allocated = Math.min(handle.requestedToolsHeight, allocated);
    }
    if (allocated !== handle.allocatedToolsHeight || !handle.frame.style.height) {
      handle.allocatedToolsHeight = allocated;
      handle.frame.style.height = allocated + "px";
      handle.frame.style.minHeight = allocated + "px";
    }
    return allocated;
  }
  function createHandle(host, kind, deck, sidenav, pane) {
    if (host.panels.has(kind)) return host.panels.get(kind);
    const doc = host.window.document, panel = doc.createXULElement("vbox"); panel.id = "reading-flow-" + kind + "-panel"; panel.setAttribute("flex", "1");
    panel.style.cssText = "min-width:0;min-height:0;overflow:hidden;background:var(--material-background,#fff)";
    const frame = doc.createElementNS(HTML_NS, "iframe"); frame.id = "reading-flow-" + kind + "-tools"; frame.setAttribute("title", "阅读计时与金字塔");
    frame.style.cssText = "border:0;display:block;width:100%;height:88px;min-height:88px;flex:none;background:transparent";
    const editor = nativeEditor(doc, kind);
    panel.append(frame, editor); deck.append(panel);
    hideOwnNoteFooter(editor);
    const handle = { hostWindow: host.window, kind, panel, deck, sidenav, pane, frame, editor, item: null, parentID: null, note: null, config: null, generation: 0, opening: null, readOnly: false, previousPanel: null, requestedToolsHeight: 88, allocatedToolsHeight: 88, lastPositivePanelHeight: 0, visiblePanelHeight: 0, disposed: false, sizeObserver: null };
    Object.defineProperty(handle, "toolsWindow", { get: () => toolsWindow(handle) }); Object.defineProperty(handle, "button", { get: () => findButton(handle) || handle.standaloneButton });
    handle.getState = () => { const app = toolsWindow(handle) && toolsWindow(handle).ReadingFlowApp; return app && typeof app.getState === "function" ? app.getState() : handle.config && handle.config.initialState; };
    handle.hide = () => restorePanel(handle); handle.show = () => selectPanel(handle); enableNativeNoteTarget(handle); host.panels.set(kind, handle); setupLibraryNoteHooks(handle);
    if (typeof host.window.ResizeObserver === "function") {
      handle.sizeObserver = new host.window.ResizeObserver(() => resizeTools(handle));
      handle.sizeObserver.observe(panel);
    }
    return handle;
  }
  function ensureMainPanels(host) {
    const doc = host.window.document;
    for (const [kind, deckID, navID, paneID] of [["library", "zotero-item-pane-content", "zotero-view-item-sidenav", "zotero-item-pane"], ["reader", "zotero-context-pane-deck", "zotero-context-pane-sidenav", "zotero-context-pane-inner"]]) {
      const deck = doc.getElementById(deckID), nav = doc.getElementById(navID); if (deck && nav) createHandle(host, kind, deck, nav, doc.getElementById(paneID));
    }
    const library = host.panels.get("library"); if (library) refreshLibraryNoteRail(library);
  }
  function panelParent(handle) {
    if (handle.kind === "library" && handle.hostWindow.ZoteroPane) {
      const selected = handle.hostWindow.ZoteroPane.getSelectedItems().filter(Boolean);
      return selected.length === 1 ? parentOf(selected[0]) : null;
    }
    if (handle.kind === "reader") {
      if (handle.deck.selectedPanel === handle.panel && handle.readerContext === readerContextToken(handle) && validHandleNote(handle)) {
        if (handle.parentID === null) return handle.note;
        const parent = parentOf(Zotero.Items.get(handle.parentID)); if (parent) return parent;
      }
      const editor = originalReaderEditor(handle);
      if (editor && standaloneNote(editor.item)) return editor.item;
    }
    return handle.sidenav && handle.sidenav.container ? parentOf(handle.sidenav.container.item) : selectedParent(null, handle.hostWindow);
  }
  function restorePanel(handle) {
    if (handle.deck.selectedPanel !== handle.panel) return;
    const previous = handle.previousPanel && handle.previousPanel.isConnected ? handle.previousPanel : Array.from(handle.deck.children).find(node => node !== handle.panel);
    if (previous) handle.deck.selectedPanel = previous; handle.panel.removeAttribute("data-active"); const button = findButton(handle); if (button) button.setAttribute("aria-selected", "false"); updateNativeNoteTarget(handle);
  }
  function selectPanel(handle) {
    if (handle.deck.selectedPanel !== handle.panel) handle.previousPanel = handle.deck.selectedPanel;
    handle.deck.selectedPanel = handle.panel; handle.panel.setAttribute("data-active", "true"); if (handle.pane) handle.pane.collapsed = false;
    const button = findButton(handle); if (button) button.setAttribute("aria-selected", "true"); updateNativeNoteTarget(handle); resizeTools(handle);
  }
  function labelButtons(host) {
    if (!registeredPaneID) return;
    for (const button of host.window.document.querySelectorAll(".btn[data-pane]")) if (button.dataset.pane === registeredPaneID) {
      button.setAttribute("tooltiptext", "阅读台"); button.setAttribute("title", "阅读台"); button.setAttribute("aria-label", "阅读台");
    }
  }
  function attachWindow(window) {
    if (!active || !window || window.closed) return null;
    if (hosts.has(window)) { const host = hosts.get(window); ensureMainPanels(host); return host; }
    const host = { window, panels: new Map(), click: null, unload: null, resize: null }; hosts.set(window, host); ensureMainPanels(host);
    host.click = event => {
      const button = event.target && event.target.closest ? event.target.closest(".btn[data-pane]") : null; if (!button) return;
      const sidenav = button.closest("item-pane-sidenav"), handle = Array.from(host.panels.values()).find(panel => panel.sidenav === sidenav); if (!handle) return;
      if (button.dataset.pane === registeredPaneID) {
        if (event.button !== 0) return; event.preventDefault(); event.stopImmediatePropagation(); const parent = panelParent(handle);
        if (parent) openInHandle(handle, parent).catch(error => showError(error, window));
      } else restorePanel(handle);
    };
    window.document.addEventListener("click", host.click, true); host.unload = () => detachWindow(window).catch(error => Zotero.logError(error)); window.addEventListener("unload", host.unload, { once: true });
    host.resize = () => { for (const handle of host.panels.values()) resizeTools(handle); };
    window.addEventListener("resize", host.resize);
    return host;
  }
  function detachWindow(window) {
    if (detachOperations.has(window)) return detachOperations.get(window);
    if (!hosts.has(window)) return Promise.resolve();
    const operation = detachWindowNow(window);
    detachOperations.set(window, operation); pendingDetaches.add(operation);
    const cleanup = () => { detachOperations.delete(window); pendingDetaches.delete(operation); };
    operation.then(cleanup, cleanup);
    return operation;
  }
  async function detachWindowNow(window) {
    const host = hosts.get(window); if (!host) return; hosts.delete(window); window.document.removeEventListener("click", host.click, true); window.removeEventListener("unload", host.unload); window.removeEventListener("resize", host.resize);
    for (const handle of host.panels.values()) {
      handle.disposed = true;
      removeLibraryNoteHooks(handle);
      if (handle.sizeObserver) handle.sizeObserver.disconnect();
      handle.generation++; let flushed = false;
      try { await flushHandle(handle); flushed = true; } catch (error) { Zotero.logError(error); }
      // Native note-editor.destroy() fires uninit without awaiting it. Finish our own
      // editor's cleanup while SQLite is open, and avoid a second save on DOM removal.
      const instance = handle.editor.getCurrentInstance();
      if (instance && typeof instance.uninit === "function") {
        if (flushed) instance._disableSaving = true;
        try { await instance.uninit(); }
        catch (error) { Zotero.logError(error); }
        if (handle.editor._editorInstance === instance) handle.editor._editorInstance = null;
      }
      if (handle.item && activeHandles.get(sessionKey(handle.item)) === handle) activeHandles.delete(sessionKey(handle.item));
      restorePanel(handle); handle.panel.remove();
      if (handle.nativeNoteTargetEnabled) {
        if (handle.originalActiveEditorDescriptor) Object.defineProperty(handle.pane, "activeEditor", handle.originalActiveEditorDescriptor);
        else delete handle.pane.activeEditor;
        updateNativeNoteTarget(handle);
      }
      if (handle.sideRail) handle.sideRail.remove(); if (handle.splitter) handle.splitter.remove(); if (handle.kind === "standalone") handle.deck.remove();
    }
  }
  async function loadTools(handle, config, generation) {
    const tools = toolsWindow(handle), app = tools && tools.ReadingFlowApp;
    if (app && typeof app.loadConfig === "function") { tools.ReadingFlowConfig = config; await app.loadConfig(config); return; }
    await new Promise((resolve, reject) => {
      let timeout = null, poll = null, settled = false;
      const cleanup = () => {
        handle.frame.removeEventListener("load", loaded);
        handle.frame.removeEventListener("DOMContentLoaded", loaded, true);
        if (timeout !== null) handle.hostWindow.clearTimeout(timeout);
        if (poll !== null) handle.hostWindow.clearInterval(poll);
      };
      const loaded = () => {
        if (settled) return;
        if (!active || generation !== handle.generation) { settled = true; cleanup(); resolve(); return; }
        try {
          const tools = toolsWindow(handle);
          if (!tools || !tools.ReadingFlowApp) return;
          settled = true; cleanup(); tools.ReadingFlowConfig = config; tools.arguments = [config];
          Promise.resolve(tools.ReadingFlowApp.loadConfig(config)).then(resolve, reject);
        }
        catch (error) { settled = true; cleanup(); reject(error); }
      };
      handle.frame.addEventListener("load", loaded);
      handle.frame.addEventListener("DOMContentLoaded", loaded, true);
      timeout = handle.hostWindow.setTimeout(() => {
        if (settled) return; settled = true; cleanup();
        let detail = "";
        try { detail = " [" + handle.frame.contentWindow.location.href + "; " + handle.frame.contentDocument.readyState + "; app=" + !!handle.frame.contentWindow.ReadingFlowApp + "]"; } catch (_) {}
        reject(new Error("阅读工具未能载入，请重新启用插件后重试。" + detail));
      }, 15000);
      // Gecko can suppress a hidden subframe's load notification during a XUL deck switch.
      // The ready app is the same success condition and never depends on a popup.
      poll = handle.hostWindow.setInterval(loaded, 100);
      handle.frame.setAttribute("src", "chrome://reading-flow/content/app.xhtml?v=" + encodeURIComponent(resourceVersion) + "&sidebar=" + generation);
    });
  }
  async function openInHandle(handle, parent, options = {}) {
    if (!active) throw new Error("阅读台正在关闭，请重新启用插件后再打开。");
    if (standaloneNote(parent) && (!parent.id || !parent.key)) {
      const preparation = ++handle.generation;
      const savingNote = prepareStandaloneNote(handle, parent); pendingOpens.add(savingNote);
      try { await savingNote; } finally { pendingOpens.delete(savingNote); }
      if (!active || preparation !== handle.generation) return null;
    }
    const item = identity(parent), parentID = parent.isNote() ? null : parent.id;
    if (handle.opening && handle.opening.key === sessionKey(item)) return handle.opening.promise;
    const key = sessionKey(item), focusVersion = (focusVersions.get(key) || 0) + 1;
    focusVersions.set(key, focusVersion);
    const sameItem = handle.item && sessionKey(handle.item) === key && handle.config;
    if (!options.refresh && sameItem && activeHandles.get(key) === handle && handle.parentID === parentID && validHandleNote(handle) && handle.editor.getCurrentInstance() !== handle.invalidatedNativeInstance) {
      if (handle.opening) handle.generation++;
      handle.opening = null; selectPanel(handle); return handle;
    }
    const generation = ++handle.generation;
    const operation = (async () => {
      const previousWriter = activeHandles.get(key);
      if (previousWriter && previousWriter !== handle) await flushHandle(previousWriter);
      if (options.refresh) await flushNative(handle); else await flushHandle(handle);
      if (!active || generation !== handle.generation) return null;
      if (parentID === null) { await flushExternalNote(handle, parent); if (!active || generation !== handle.generation) return null; }
      const localState = await initialState(item); if (!active || generation !== handle.generation) return null;
      const localRaw = localRecords.get(key) || null;
      let synced = await loadSyncedState(item, localRaw);
      const state = synced.state || localState;
      if (!active || generation !== handle.generation || focusVersions.get(key) !== focusVersion) return null;
      const syncedNoteKey = state.noteKey;
      const { note, readOnly, notice, awaitingSyncedNote } = await managedNote(parent, item, state, { waitForSyncedNote: synced.hasRemote && !localRaw }); if (!active || generation !== handle.generation) return null;
      if (focusVersions.get(key) !== focusVersion) return null;
      if (awaitingSyncedNote) synced = { ...synced, pending: true };
      handle.syncToken = synced.token; handle.syncSignature = synced.token?.signature;
      if (!readOnly && !synced.conflict && !synced.pending && (synced.needsPublish || !synced.hasRemote || syncedNoteKey !== state.noteKey)) {
        const saved = await saveSyncedState(item, state, handle.syncToken, { canPublish: () => active && generation === handle.generation && focusVersions.get(key) === focusVersion });
        if (saved.ignored) return null;
        handle.syncToken = saved.token; handle.syncSignature = saved.token?.signature;
        synced = { ...synced, token: saved.token, needsPublish: false };
      }
      if (focusVersions.get(key) !== focusVersion) return null;
      // Keep legacy recovery tags until the accepted synced state contains the
      // same note key, so another device can still recover a failed publication.
      if (!readOnly && !synced.conflict && !synced.pending && !handle.syncToken?.pending && handle.syncToken?.selected) await cleanLegacyNoteTags(note, item, parentID);
      if (!active || generation !== handle.generation || focusVersions.get(key) !== focusVersion) return null;
      if (handle.item && activeHandles.get(sessionKey(handle.item)) === handle) activeHandles.delete(sessionKey(handle.item));
      const rebuilt = await rebuildInvalidatedEditor(handle, note, generation); if (!active || generation !== handle.generation) return null;
      const noteChanged = rebuilt || handle.note !== note;
      stopSavingUnboundNote(handle);
      handle.item = item; handle.parentID = parentID; handle.note = note; handle.readOnly = readOnly; const boundNoteKey = note && note.key;
      if (handle.kind === "reader") handle.readerContext = readerContextToken(handle);
      activeHandles.set(key, handle);
      const guardedSave = value => {
        const normalized = snapshot(value, item);
        if (handle.config !== config || activeHandles.get(key) !== handle) return Promise.resolve({ message: "已在当前阅读侧栏保存", ignored: true });
        if (config.syncConflict || config.syncPending) return Promise.resolve({ message: "各版本已保留，请先完成同步或选择版本", ignored: true });
        normalized.noteKey = boundNoteKey || normalized.noteKey || "";
        if (readOnly) return saveState(item, normalized);
        if (!validHandleNote(handle)) {
          stopSavingUnboundNote(handle);
          return queueSave(item, () => writeDraft(item, normalized, { ...localRecords.get(key)?.readingFlowSync, pending: true }));
        }
        return saveSyncedState(item, normalized, () => handle.syncToken).then(result => {
          if (handle.config === config) { handle.syncToken = result.token; handle.syncSignature = result.token?.signature; }
          return result;
        }).catch(error => { scheduleSyncRefresh(); throw error; });
      };
      const config = { item, initialState: state, readOnly: readOnly || synced.conflict || synced.pending, syncConflict: !!synced.conflict, syncPending: !!synced.pending, syncVersions: synced.versions || [], selectedSyncVersion: synced.token?.selected, syncCanResolve: !readOnly, pyramidHeight: pyramidHeightPreference(), bridge: {
        saveState: guardedSave, saveDraft: guardedSave, flushState: guardedSave,
        exportNote: async value => {
          if (handle.config !== config || activeHandles.get(key) !== handle) throw new Error("当前文献已切换，请在当前阅读侧栏保存笔记。");
          await guardedSave(value);
          if (handle.config !== config || activeHandles.get(key) !== handle) throw new Error("当前文献已切换，阅读草稿已保留。");
          return exportNote(handle);
        },
        exportJSON: value => exportJSON(item, value, handle.hostWindow), importJSON: () => importJSON(item, handle.hostWindow), canEdit: !readOnly && !synced.conflict && !synced.pending,
        async resolveSyncVersion(id) {
          if (readOnly || handle.config !== config || activeHandles.get(key) !== handle) throw new Error("请在当前可编辑的阅读侧栏选择版本。");
          let fresh = await loadSyncedState(item, localRecords.get(key) || null);
          const version = fresh.versions.find(version => version.id === id);
          if (!version || fresh.pending) throw new Error("同步版本已变化或尚未下载完整，请稍后重新选择。");
          const chosen = snapshot(version.state, item); chosen.noteKey = boundNoteKey || chosen.noteKey;
          const unpublished = fresh.versions.find(version => version.id === "local");
          if (unpublished && id !== "local") {
            // A legacy/offline draft has no synced head yet. Archive it first,
            // so explicitly choosing another version cannot erase its only copy.
            const preserved = snapshot(unpublished.state, item); preserved.noteKey = boundNoteKey || preserved.noteKey;
            await saveSyncedState(item, preserved, fresh.token, { resolve: true });
            fresh = await loadSyncedState(item, localRecords.get(key) || null);
          }
          const saved = await saveSyncedState(item, chosen, fresh.token, { resolve: true });
          handle.syncToken = saved.token; handle.syncSignature = saved.token?.signature;
          await openInHandle(handle, parent, { refresh: true });
          return { message: "已采用所选版本，并保存到 Zotero" };
        },
        resizeTools(height, options) {
          if (handle.config !== config) return handle.allocatedToolsHeight;
          return resizeTools(handle, height, options);
        },
        savePyramidHeight(value) { if (handle.config !== config) return { ignored: true }; return savePyramidHeight(value); },
        insertPyramid: image => { if (handle.config !== config || activeHandles.get(key) !== handle) throw new Error("当前文献已切换，请在新的阅读笔记中重新插入。"); return insertPyramid(handle, image); }
      } };
      handle.config = config; handle.editor.mode = readOnly ? "view" : "edit"; handle.editor.viewMode = handle.kind === "library" ? "library" : "reader"; handle.editor.parent = null; if (note && noteChanged) handle.editor.item = note; handle.editor.hidden = !note;
      hideOwnNoteFooter(handle.editor);
      selectPanel(handle); await loadTools(handle, config, generation); if (!active || generation !== handle.generation) return null;
      const app = toolsWindow(handle) && toolsWindow(handle).ReadingFlowApp;
      const message = [notice, synced.notice].filter(Boolean).join(" ");
      if (message && handle.config === config && app && typeof app.showNotice === "function") app.showNotice(message);
      return handle;
    })();
    handle.opening = { key: sessionKey(item), promise: operation }; pendingOpens.add(operation);
    try { return await operation; } finally {
      pendingOpens.delete(operation); if (handle.opening && handle.opening.promise === operation) handle.opening = null;
      if (handle.syncRefreshAfterOpen) { handle.syncRefreshAfterOpen = false; scheduleSyncRefresh(); }
    }
  }
  function ensureStandalone(host, reader) {
    if (host.panels.has("standalone")) return host.panels.get("standalone"); const doc = host.window.document, readerBox = doc.getElementById("zotero-reader"); if (!readerBox) return null;
    const row = readerBox.parentElement, splitter = doc.createXULElement("splitter"); splitter.setAttribute("collapse", "after");
    const deck = doc.createXULElement("deck"); deck.style.cssText = "width:390px;min-width:300px;max-width:70vw;min-height:0"; deck.append(doc.createXULElement("vbox")); row.append(splitter, deck);
    const handle = createHandle(host, "standalone", deck, null, null); handle.splitter = splitter;
    const rail = doc.createXULElement("vbox"); rail.style.cssText = "width:34px;border-inline-start:1px solid var(--fill-secondary,#ddd);padding-top:8px";
    const button = doc.createXULElement("toolbarbutton"); button.setAttribute("tooltiptext", "阅读台"); button.setAttribute("aria-label", "阅读台"); button.setAttribute("image", ICON); button.style.cssText = "width:28px;height:28px;margin:2px";
    button.addEventListener("command", () => {
      if (!deck.hidden && deck.selectedPanel === handle.panel) { deck.hidden = true; splitter.hidden = true; }
      else { deck.hidden = false; splitter.hidden = false; const parent = parentOf(Zotero.Items.get(reader.itemID)); if (parent) openInHandle(handle, parent).catch(error => showError(error, host.window)); }
    });
    rail.append(button); row.append(rail); deck.hidden = true; splitter.hidden = true; handle.sideRail = rail; handle.standaloneButton = button; return handle;
  }
  async function open(parent, window) {
    window = window || Zotero.getMainWindow(); if (!window) throw new Error("请打开 Zotero 主窗口后再打开阅读台。"); const host = attachWindow(window); if (!host) throw new Error("阅读台正在关闭，请重新启用插件后再打开。");
    if (window.reader && !window.ZoteroPane) { const handle = ensureStandalone(host, window.reader); if (!handle) throw new Error("未能加载 PDF 阅读侧栏。"); handle.deck.hidden = false; handle.splitter.hidden = false; return openInHandle(handle, parent); }
    ensureMainPanels(host); const readerHandle = host.panels.get("reader");
    if (window.Zotero_Tabs && window.Zotero_Tabs.selectedType !== "library" && readerHandle) {
      const current = panelParent(readerHandle), documentParent = readerHandle.sidenav && readerHandle.sidenav.container && parentOf(readerHandle.sidenav.container.item);
      if (current && current.id === parent.id || documentParent && documentParent.id === parent.id) return openInHandle(readerHandle, parent);
    }
    const handle = host.panels.get("library"); if (!handle) throw new Error("Zotero 条目侧栏尚未就绪，请稍后重试。");
    if (window.Zotero_Tabs) window.Zotero_Tabs.select("zotero-pane"); if (window.ZoteroPane) await window.ZoteroPane.selectItem(parent.id); return openInHandle(handle, parent);
  }
  function registerMenu(pluginID, target) {
    const registered = Zotero.MenuManager.registerMenu({ menuID: "reading-flow-" + target.replace(/\//g, "-"), pluginID, target, menus: [{ menuType: "menuitem",
      onShowing(event, context) { context.menuElem.label = "阅读台"; context.setEnabled(active && !!selectedParent(context, ownerWindow(event))); },
      onCommand(event, context) { const host = ownerWindow(event), parent = selectedParent(context, host); if (!parent) return showError(new Error("请选中文献条目或独立笔记，或打开文献的 PDF。独立 PDF 需要先建立父条目。"), host); open(parent, host).catch(error => showError(error, host)); }
    }] });
    if (!registered) throw new Error("无法注册阅读台菜单，请检查 Zotero 版本是否为 9.0.x。"); menuIDs.push(registered);
  }
  async function refreshSyncedHandles() {
    for (const handle of Array.from(activeHandles.values())) {
      if (!active || handle.disposed || !handle.item || !handle.config) continue;
      if (handle.opening) { handle.syncRefreshAfterOpen = true; continue; }
      const config = handle.config, item = handle.item, key = sessionKey(item);
      try {
        const pending = saveQueues.get(key); if (pending) await pending.catch(() => {});
        let remote = await loadSyncedState(item, localRecords.get(key) || null);
        const bindingArrived = !handle.note && remote.state?.noteKey && await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, remote.state.noteKey);
        if (!active || handle.config !== config || remote.token?.signature === handle.syncSignature && !bindingArrived) continue;
        const app = toolsWindow(handle)?.ReadingFlowApp;
        if (app && typeof app.hasPendingChanges === "function" && app.hasPendingChanges()) {
          try { await app.flushPendingSave(); } catch (_) { /* The local draft remains available as a conflict version. */ }
          remote = await loadSyncedState(item, localRecords.get(key) || null);
        }
        if (!active || handle.config !== config || remote.token?.signature === handle.syncSignature && !bindingArrived) continue;
        const parent = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, item.key);
        if (parentOf(parent)) await openInHandle(handle, parent, { refresh: true });
      }
      catch (error) {
        Zotero.logError(error);
        const app = toolsWindow(handle)?.ReadingFlowApp;
        if (handle.config === config && app?.showNotice) app.showNotice(error.message || String(error));
      }
    }
  }
  function scheduleSyncRefresh() {
    if (!active || syncRefreshTimer !== null) return;
    const window = Zotero.getMainWindow(); if (!window) return;
    syncRefreshTimer = window.setTimeout(() => { syncRefreshTimer = null; refreshSyncedHandles().catch(error => Zotero.logError(error)); }, 250);
  }
  function maintainDataFiles() {
    if (!active || !syncStore?.maintenance) return Promise.resolve();
    if (dataMaintenancePromise) return dataMaintenancePromise;
    const store = syncStore;
    const operation = Promise.resolve().then(() => store.maintenance());
    dataMaintenancePromise = operation;
    operation.catch(error => Zotero.logError(error)).finally(() => {
      if (dataMaintenancePromise !== operation) return;
      dataMaintenancePromise = null;
      if (active && dataMaintenanceAgain) { dataMaintenanceAgain = false; scheduleDataMaintenance(); }
    });
    return operation;
  }
  function scheduleDataMaintenance() {
    if (!active) return;
    if (dataMaintenancePromise) { dataMaintenanceAgain = true; return; }
    if (dataMaintenanceTimer !== null) return;
    const window = Zotero.getMainWindow(); if (!window) return;
    dataMaintenanceTimer = window.setTimeout(() => {
      dataMaintenanceTimer = null;
      Promise.resolve(migrationPromise).catch(() => {}).then(() => {
        if (active) return maintainDataFiles();
      }).catch(error => Zotero.logError(error));
    }, 500);
  }
  async function migrateLocalDrafts() {
    if (typeof IOUtils.getChildren !== "function" || !(await IOUtils.exists(dataDirectory))) return;
    for (const path of await IOUtils.getChildren(dataDirectory)) {
      if (!active) break;
      const match = /(?:^|[\\/])(\d+)-([A-Z0-9]{8})\.json$/.exec(path); if (!match) continue;
      try {
        const parent = await Zotero.Items.getByLibraryAndKeyAsync(Number(match[1]), match[2]);
        if (!parentOf(parent) || !Zotero.Libraries.get(parent.libraryID)?.editable) continue;
        const item = identity(parent), key = sessionKey(item);
        if (activeHandles.has(key) || Array.from(pendingOpens).length) continue;
        await initialState(item);
        const loaded = await loadSyncedState(item, localRecords.get(key) || null);
        if (!active || activeHandles.has(key) || loaded.pending || loaded.conflict || !loaded.needsPublish && loaded.hasRemote) continue;
        if (loaded.state.noteKey) {
          const note = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, loaded.state.noteKey);
          if (!validNativeNote(note, item, parent.isNote() ? null : parent.id)) continue;
        }
        await saveSyncedState(item, loaded.state, loaded.token, { migration: true });
      }
      catch (error) { Zotero.logError(new Error("Reading flow：旧草稿仍保留，迁移未完成。" + path + "\n" + (error.message || error))); }
    }
  }
  async function start({ id, version }) {
    resourceVersion = typeof version === "string" ? version : "";
    if (!Zotero.ItemPaneManager || !Zotero.ItemPaneManager.registerSection) throw new Error("当前 Zotero 缺少所需的侧栏接口。");
    ({ FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs")); dataDirectory = PathUtils.join(Zotero.DataDirectory.dir, "reading-flow"); stopPromise = null; active = true;
    if (typeof ReadingFlowFileSync === "undefined") throw new Error("Reading flow 数据文件模块未能载入，请重新启用插件。");
    fileStore = ReadingFlowFileSync.create({ Zotero, IOUtils, PathUtils });
    syncStore = ReadingFlowSync.create({ Zotero, core, fileStore });
    registeredPaneID = Zotero.ItemPaneManager.registerSection({ paneID: "reading-flow", pluginID: id, header: { l10nID: "sidenav-notes", icon: ICON }, sidenav: { l10nID: "sidenav-notes", icon: ICON, orderable: false },
      onInit({ doc, body }) { attachWindow(doc.defaultView); body.closest("item-pane-custom-section").style.display = "none"; },
      onItemChange({ doc, item, tabType, setEnabled }) {
        const parent = parentOf(item); setEnabled(!!parent); const host = attachWindow(doc.defaultView); if (!host) return;
        const handle = host.panels.get(tabType === "library" ? "library" : "reader");
        if (handle && handle.deck.selectedPanel === handle.panel) {
          if (parent) openInHandle(handle, parent).catch(error => showError(error, doc.defaultView));
          else {
            const clearingGeneration = ++handle.generation; handle.opening = null;
            flushHandle(handle).catch(error => Zotero.logError(error)).finally(() => {
              if (handle.generation === clearingGeneration && handle.item && activeHandles.get(sessionKey(handle.item)) === handle) activeHandles.delete(sessionKey(handle.item));
            });
            restorePanel(handle);
          }
        }
        labelButtons(host);
      },
      onRender({ doc }) { const host = attachWindow(doc.defaultView); if (host) labelButtons(host); }
    });
    if (!registeredPaneID) throw new Error("无法注册阅读台侧栏，请检查 Zotero 版本。");
    for (const window of (Zotero.getMainWindows ? Zotero.getMainWindows() : [Zotero.getMainWindow()])) attachWindow(window);
    readerHandler = ({ reader }) => { if (!active || !reader || !reader._window) return; const host = attachWindow(reader._window); if (host && reader._window.reader && !reader._window.ZoteroPane) ensureStandalone(host, reader); };
    if (Zotero.Reader) { Zotero.Reader.registerEventListener("renderToolbar", readerHandler, id); for (const reader of Zotero.Reader._readers || []) readerHandler({ reader }); }
    notifierID = Zotero.Notifier.registerObserver({ notify(action, type) {
      if (type === "sync" && action === "finish") { scheduleDataMaintenance(); scheduleSyncRefresh(); return; }
      if (type === "item" && ["add", "modify", "delete", "trash", "refresh"].includes(action)) { scheduleDataMaintenance(); scheduleSyncRefresh(); return; }
      if (type !== "tab" || !["select", "load"].includes(action)) return;
      for (const host of hosts.values()) { const handle = host.panels.get("reader"); if (!handle || handle.deck.selectedPanel !== handle.panel) continue; const parent = panelParent(handle); if (parent) openInHandle(handle, parent).catch(error => Zotero.logError(error)); }
    } }, ["tab", "item", "sync"], "reading-flow");
    registerMenu(id, "main/menubar/tools"); registerMenu(id, "main/library/item"); registerMenu(id, "reader/menubar/file");
    publicAPI = {
      async openItem(itemID, window) { if (!Number.isInteger(itemID) || itemID <= 0) throw new Error("文献编号无效。"); const parent = parentOf(await Zotero.Items.getAsync(itemID)); if (!parent) throw new Error("请从文献条目、它的子附件或独立笔记打开阅读台。"); return open(parent, window); },
      inspect(window) { const host = hosts.get(window || Zotero.getMainWindow()); return host ? Array.from(host.panels.values()) : []; },
      maintenance() { return maintainDataFiles(); },
      get paneID() { return registeredPaneID; }
    }; Zotero.ReadingFlow = publicAPI;
    migrationPromise = maintainDataFiles().catch(error => Zotero.logError(error)).then(() => migrateLocalDrafts()).catch(error => Zotero.logError(error));
    if (typeof Zotero.addShutdownListener === "function") {
      const ownedAPI = publicAPI;
      Zotero.addShutdownListener(async () => {
        // Zotero has no removeShutdownListener. Disabled or replaced plugin scopes are inert.
        if (!active || publicAPI !== ownedAPI) {
          // A concurrent disable may already be flushing its last unload; await that
          // existing work without registering anything or starting new transactions.
          if (stopPromise && (pendingDetaches.size || pendingOpens.size || saveQueues.size)) await stopPromise;
          return;
        }
        if (typeof Zotero.debug === "function") Zotero.debug("Reading Flow: early shutdown cleanup begins");
        await stop();
        if (Zotero.DB && typeof Zotero.DB.waitForTransaction === "function") await Zotero.DB.waitForTransaction();
        if (typeof Zotero.debug === "function") Zotero.debug("Reading Flow: early shutdown cleanup complete before database close");
      });
    }
  }
  function stop() {
    if (stopPromise) return stopPromise;
    active = false; if (Zotero.ReadingFlow === publicAPI) delete Zotero.ReadingFlow; publicAPI = null;
    stopPromise = stopNow();
    return stopPromise;
  }
  async function stopNow() {
    dataMaintenanceAgain = false;
    if (syncRefreshTimer !== null) { Zotero.getMainWindow()?.clearTimeout(syncRefreshTimer); syncRefreshTimer = null; }
    if (dataMaintenanceTimer !== null) { Zotero.getMainWindow()?.clearTimeout(dataMaintenanceTimer); dataMaintenanceTimer = null; }
    if (migrationPromise) await migrationPromise; migrationPromise = null;
    if (dataMaintenancePromise) { try { await dataMaintenancePromise; } catch (_) {} } dataMaintenancePromise = null;
    if (readerHandler && Zotero.Reader) {
      // Zotero 9.0.6's public unregister filter incorrectly keeps matching listeners.
      // Remove just our listener and preserve every other plugin's reader hooks.
      if (Array.isArray(Zotero.Reader._registeredListeners)) Zotero.Reader._registeredListeners = Zotero.Reader._registeredListeners.filter(entry => entry.handler !== readerHandler);
      else Zotero.Reader.unregisterEventListener("renderToolbar", readerHandler);
    }
    readerHandler = null;
    if (notifierID) Zotero.Notifier.unregisterObserver(notifierID); notifierID = null;
    for (const id of menuIDs.splice(0)) Zotero.MenuManager.unregisterMenu(id); await Promise.allSettled(Array.from(pendingOpens));
    for (const window of Array.from(hosts.keys())) await detachWindow(window);
    while (pendingDetaches.size) await Promise.allSettled(Array.from(pendingDetaches));
    if (registeredPaneID) Zotero.ItemPaneManager.unregisterSection(registeredPaneID); registeredPaneID = null;
    await Promise.allSettled(Array.from(saveQueues.values()));
    // Plugin API unregister refreshes start SQLite transactions but return boolean.
    if (Zotero.DB && typeof Zotero.DB.waitForTransaction === "function") await Zotero.DB.waitForTransaction();
    pendingOpens.clear(); saveQueues.clear(); noteQueues.clear(); activeHandles.clear(); focusVersions.clear(); detachOperations.clear(); localRecords.clear(); dataDownloads.clear(); syncStore = null; fileStore = null;
  }
  return { start, stop, attachWindow, detachWindow };
})();
