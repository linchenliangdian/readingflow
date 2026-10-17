/* Privileged smoke runner: executes only after both isolated paths are verified. */
const expectedProfile = __EXPECTED_PROFILE__;
const expectedData = __EXPECTED_DATA__;
const resultPath = __RESULT_PATH__;
const packagePath = __PACKAGE_PATH__;
const betterNotesPath = __BETTER_NOTES_PATH__;
const pdfFixturePath = __PDF_FIXTURE_PATH__;
const previewHoldMs = __PREVIEW_HOLD_MS__;
const shutdownBaseline = __SHUTDOWN_BASELINE__;
const capturePreviews = __CAPTURE_PREVIEWS__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let scheduled = null;

function startup() { scheduled = setTimeout(runSmokeTest, 100); }
function shutdown() { if (scheduled !== null) clearTimeout(scheduled); }
function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}

function legacySession(item) {
  const timer = duration => ({ durationMs: duration, remainingMs: duration, status: "idle", deadline: null });
  const node = (id, type, text, source = "", children = []) => ({ id, type, text, source, question: "", logic: "inductive", order: "structure", children });
  return {
    schemaVersion: 1,
    item: { libraryID: item.libraryID, key: item.key, title: item.getField("title") },
    phase: "inspection", timers: { inspection: timer(600000), analysis: timer(1200000) },
    inspection: { question: "旧版问题 <script>不可执行</script>", structure: "旧版整体结构", checklist: [true, false, true, false, true], classified: true },
    terms: [{ id: "term-old", term: "旧版控制变量", meaning: "旧版术语理解", source: "第 2 页", uncertain: false }],
    pyramid: node("root", "thesis", "总论点：旧版证据支持结论", "", [
      node("old-argument", "argument", "旧版分论点", "", [node("old-evidence", "evidence", "旧版底层证据", "第 3 页，图 2")])
    ]),
    framing: { situation: "旧版情境", complication: "旧版冲突", question: "旧版 SCQ" },
    checks: { summary: true, sameKind: false, order: true, coverage: false },
    reflection: { unresolved: "旧版未理解内容", nextStep: "旧版下一步" },
    createdAt: Date.now() - 60000, updatedAt: Date.now() - 5000, completedAt: null
  };
}

async function runSmokeTest() {
  const result = { status: "running", scenario: "native-sidebar-v2", version: Zotero.version, checks: [], startedAt: new Date().toISOString() };
  let safeToQuit = false;
  let current = null;
  let checkpoint = Promise.resolve();
  function check(name, condition, detail) {
    result.checks.push({ name, passed: !!condition, detail: detail ?? null });
    if (!condition || result.checks.length % 5 === 0) {
      const content = JSON.stringify(result, null, 2);
      checkpoint = checkpoint.catch(() => {}).then(() => IOUtils.writeUTF8(resultPath, content, { tmpPath: resultPath + ".tmp" }));
    }
    if (!condition) throw new Error("Failed: " + name + (detail ? " — " + detail : ""));
  }
  async function waitFor(test, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await test();
      if (value) return value;
      await delay(100);
    }
    throw new Error("Timeout waiting for " + label);
  }
  async function openItem(api, item, host) {
    return Promise.race([
      api.openItem(item.id, host),
      delay(30000).then(() => { throw new Error("Timeout opening sidebar for " + item.key); })
    ]);
  }
  function chromeWindows() {
    const windows = [];
    const enumerator = Services.wm.getEnumerator(null);
    while (enumerator.hasMoreElements()) windows.push(enumerator.getNext());
    return windows;
  }
  function newWindowDetails(beforeWindows) {
    return chromeWindows().filter(window => !beforeWindows.includes(window)).map(window => {
      try {
        return { title: window.document?.title || "", location: String(window.location?.href || ""), windowtype: window.document?.documentElement?.getAttribute("windowtype") || "", closed: window.closed, body: window.document?.body?.textContent?.slice(0, 400) || window.document?.documentElement?.textContent?.slice(0, 400) || "", openerLocation: window.opener?.location?.href || null };
      } catch (error) { return { inaccessible: error.message || String(error) }; }
    });
  }
  async function savedNoteHTML(note) {
    return Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [note.id]);
  }
  async function proseNotes(libraryID, parent = null) {
    // Sync records are intentionally ordinary Zotero notes, separate from the
    // native prose note whose identity and multiplicity this regression checks.
    const notes = parent ? await Zotero.Items.getAsync(parent.getNotes()) : await Zotero.Items.getAll(libraryID, false, true);
    const prose = [];
    for (const note of notes) {
      if (!note.isNote()) continue;
      await note.loadDataType("note");
      if (!/READING_FLOW_SYNC_V1 OWNER:[A-Z0-9]{8} KIND:(?:head|part)/.test(note.getNote())) prose.push(note);
    }
    return prose;
  }
  async function captureNativeWindow(host, filename) {
    const path = PathUtils.join(PathUtils.parent(resultPath), filename);
    const screenshot = await host.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "rgb(255,255,255)", false);
    const canvas = host.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = screenshot.width; canvas.height = screenshot.height;
    canvas.getContext("2d").drawImage(screenshot, 0, 0); screenshot.close();
    const encoded = canvas.toDataURL("image/png").split(",")[1];
    const bytes = Uint8Array.from(host.atob(encoded), character => character.charCodeAt(0));
    await IOUtils.write(path, bytes, { tmpPath: path + ".tmp" });
    return path;
  }
  async function nativeReady(handle) {
    await waitFor(() => handle.editor?.getCurrentInstance(), "native editor instance");
    await Promise.race([handle.editor.getCurrentInstance()._initPromise, delay(30000).then(() => { throw new Error("Native editor initialization timeout"); })]);
    await waitFor(() => handle.toolsWindow?.ReadingFlowApp, "compact tools app");
    return handle;
  }
  function occurrences(content, value) { return content.split(value).length - 1; }
  async function verifyBranding(addon, handle, host) {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const preferred = AddonManager.getPreferredIconURL(addon, 32, host);
    const css = handle.button.style.getPropertyValue("--custom-sidenav-icon-light");
    const railURL = css.match(/url\(['"]?([^'")]+)['"]?\)/)?.[1];
    result.branding = { icons: addon.icons, preferred32: preferred, railURL };
    check("addon manager resolves declared pyramid icon", !!addon.icons?.[32] && preferred?.endsWith("content/icons/pyramid.svg"), result.branding);
    check("native rail and addon manager use the same SVG asset", railURL === "chrome://reading-flow/content/icons/pyramid.svg" && preferred?.endsWith("content/icons/pyramid.svg"), result.branding);
    const images = [];
    for (const url of [preferred, railURL]) {
      const image = new host.Image();
      await Promise.race([new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("Icon failed to decode: " + url)); image.src = url; }), delay(10000).then(() => { throw new Error("Icon decode timeout"); })]);
      images.push({ url, width: image.naturalWidth, height: image.naturalHeight });
    }
    check("addon manager and native rail SVG images decode", images.every(image => image.width > 0 && image.height > 0) && images[0].width === images[1].width && images[0].height === images[1].height, images);
    const [managerSVG, railSVG] = await Promise.all([preferred, railURL].map(url => Zotero.HTTP.request("GET", url, { successCodes: [0, 200], timeout: 10000 })));
    check("resolved icon resources contain identical SVG bytes", managerSVG.responseText === railSVG.responseText && managerSVG.responseText.includes("<svg"));
  }
  async function verifySingleRootMigration(handle, legacy, migratedHTML) {
    const document = handle.toolsWindow.document, Core = handle.toolsWindow.ReadingFlowCore;
    const root = document.querySelector('.node[data-node-id="root"]');
    const editors = root.querySelectorAll(".node-text");
    const state = handle.getState();
    check("root contains one native sidebar text box", editors.length === 1 && editors[0].getAttribute("aria-label") === "主题／核心观点" && editors[0].getAttribute("contenteditable") === "true");
    check("single root preserves legacy question and answer once", state.framing.question === "" && occurrences(state.pyramid.text, legacy.framing.question) === 1 && occurrences(state.pyramid.text, legacy.pyramid.text) === 1 && editors[0].textContent === state.pyramid.text, state.pyramid.text);
    check("migration retains inspection question independently", state.inspection.question === legacy.inspection.question);
    check("native starter includes merged root content once", occurrences(migratedHTML, legacy.framing.question) === 1 && occurrences(migratedHTML, legacy.pyramid.text) === 1);
    const layout = Core.layoutPyramid(state), rootLines = layout.nodes.find(node => node.id === "root").lines.join("");
    const svg = Core.renderPyramidSVG(state);
    const svgDocument = new handle.toolsWindow.DOMParser().parseFromString(svg, "image/svg+xml");
    const svgRootText = svgDocument.querySelector("svg > text")?.textContent || "";
    check("PNG source has one merged root without duplicate question", occurrences(rootLines, legacy.framing.question) === 1 && occurrences(rootLines, legacy.pyramid.text) === 1 && occurrences(svgRootText, legacy.framing.question) === 1 && occurrences(svgRootText, legacy.pyramid.text) === 1 && !svgRootText.startsWith("问题："));
    const value = editors[0].textContent + "\n单框实机编辑内容";
    editors[0].textContent = value;
    editors[0].dispatchEvent(new handle.toolsWindow.Event("input", { bubbles: true }));
    await handle.toolsWindow.ReadingFlowApp.flushPendingSave();
    check("single root edits update and persist one field", handle.getState().pyramid.text === value && handle.getState().framing.question === "");
    const boldText = "单框实机编辑内容", start = value.indexOf(boldText), end = start + boldText.length;
    const pyramidWasHidden = document.getElementById("pyramid-area").hidden;
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", true);
    editors[0].focus();
    const range = document.createRange(); range.setStart(editors[0].firstChild, start); range.setEnd(editors[0].firstChild, end);
    const selection = handle.toolsWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const boldButton = document.getElementById("node-bold");
    check("native pyramid exposes scoped bold action", !!boldButton && boldButton.getAttribute("aria-pressed") === "false");
    // Selection changes are queued in Gecko; wait before clicking the actual toolbar action.
    await waitFor(() => !boldButton.disabled, "native pyramid bold selection");
    boldButton.click();
    check("native selected substring gains bold without changing text", handle.getState().pyramid.text === value && JSON.stringify(handle.getState().pyramid.boldRanges) === JSON.stringify([{ start, end }]) && selection.toString() === boldText);
    editors[0].dispatchEvent(new handle.toolsWindow.KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    check("native Ctrl+B removes selected bold", !(handle.getState().pyramid.boldRanges || []).length && handle.getState().pyramid.text === value);
    boldButton.click();
    await handle.toolsWindow.ReadingFlowApp.flushPendingSave();
    check("native bold range saved after toolbar toggle", JSON.stringify(handle.getState().pyramid.boldRanges) === JSON.stringify([{ start, end }]));
    const formattedSVG = new handle.toolsWindow.DOMParser().parseFromString(Core.renderPyramidSVG(handle.getState()), "image/svg+xml");
    const boldSVGText = Array.from(formattedSVG.querySelectorAll('text tspan[font-weight="700"],text tspan[font-weight="bold"]')).map(span => span.textContent).join("");
    check("native PNG source retains bold substring", boldSVGText.includes(boldText), boldSVGText);
    if (pyramidWasHidden) setDisclosure(handle, "pyramid-area", "pyramid-toggle", false);
  }
  async function verifyFramingAnnotations(handle, legacy) {
    const document = handle.toolsWindow.document, Core = handle.toolsWindow.ReadingFlowCore;
    const wasHidden = document.getElementById("pyramid-area").hidden;
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", true);
    const annotation = document.querySelector(".framing-note");
    check("native pyramid has separate background annotation", !!annotation && document.querySelectorAll(".root-wrap > .node > .node-text").length === 1);
    if (annotation.hidden) document.getElementById("framing-toggle").click();
    const situation = document.getElementById("framing-situation"), complication = document.getElementById("framing-complication");
    check("native annotations restore legacy background and complication", situation.value === legacy.framing.situation && complication.value === legacy.framing.complication);
    const beforeRoot = handle.getState().pyramid.text;
    situation.value += "\n实机背景批注"; situation.dispatchEvent(new handle.toolsWindow.Event("input", { bubbles: true }));
    complication.value += "\n实机冲突批注"; complication.dispatchEvent(new handle.toolsWindow.Event("input", { bubbles: true }));
    await handle.toolsWindow.ReadingFlowApp.flushPendingSave();
    check("native annotation edits preserve the single core field", handle.getState().pyramid.text === beforeRoot && handle.getState().framing.situation === situation.value && handle.getState().framing.complication === complication.value);
    const rootBox = document.querySelector(".root-wrap > .node").getBoundingClientRect(), annotationBox = annotation.getBoundingClientRect();
    check("native annotation and core box do not overlap", rootBox.width > 0 && annotationBox.width > 0 && (annotationBox.right <= rootBox.left || rootBox.right <= annotationBox.left || annotationBox.bottom <= rootBox.top || rootBox.bottom <= annotationBox.top));
    const svg = new handle.toolsWindow.DOMParser().parseFromString(Core.renderPyramidSVG(handle.getState()), "image/svg+xml");
    const annotationText = svg.querySelector('[data-role="framing-annotation"]')?.textContent || "";
    check("native PNG source includes background and complication", annotationText.includes("实机背景批注") && annotationText.includes("实机冲突批注"), annotationText);
    const scroll = document.getElementById("diagram-scroll");
    scroll.scrollLeft = scroll.scrollWidth;
    document.getElementById("framing-toggle").click();
    scroll.scrollLeft = scroll.scrollWidth;
    document.getElementById("framing-toggle").click();
    await waitFor(() => {
      const note = document.querySelector(".framing-note").getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      return note.left >= viewport.left - 1 && note.right <= viewport.right + 1;
    }, "native background annotation revealed after horizontal scrolling");
    check("native background toggle brings annotations into view", document.querySelectorAll(".root-wrap > .node > .node-text").length === 1 && document.getElementById("framing-situation").value.includes("实机背景批注") && document.getElementById("framing-complication").value.includes("实机冲突批注"));
    if (capturePreviews) result.framingPreviewPath = await captureNativeWindow(handle.hostWindow, "native-framing-preview.png");
    if (wasHidden) setDisclosure(handle, "pyramid-area", "pyramid-toggle", false);
  }
  async function typeNative(handle, text) {
    const instance = handle.editor.getCurrentInstance();
    const nativeWindow = instance._iframeWindow;
    const nativeDocument = nativeWindow.document;
    const prose = await waitFor(() => nativeDocument.querySelector(".ProseMirror"), "native editable document");
    prose.focus();
    const range = nativeDocument.createRange();
    range.selectNodeContents(prose);
    range.collapse(false);
    const selection = nativeWindow.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    check("native typing accepted", nativeDocument.execCommand("insertText", false, text));
    // Normal editors may replace/reload their instance while saving and applying
    // notifier updates. Check the visible DOM transaction, then the actual note
    // database, without polling a captured iframe's getDataSync cache.
    check("native typing reaches editor DOM", prose.textContent.includes(text), { editorID: handle.editor.id, noteID: handle.note.id });
    handle.editor.saveSync();
    try {
      await waitFor(async () => (await savedNoteHTML(handle.note))?.includes(text), "native note database persistence");
    } catch (error) {
      const currentInstance = handle.editor.getCurrentInstance();
      result.nativeTypingFailure = { editorID: handle.editor.id, noteID: handle.note.id, editorNoteID: handle.editor.item?.id, sameInstance: currentInstance === instance, capturedProse: prose.textContent, currentProse: currentInstance?._iframeWindow?.document?.querySelector(".ProseMirror")?.textContent, savedHTML: await savedNoteHTML(handle.note) };
      throw error;
    }
  }
  async function standaloneNotesRegression(api, host, article, beforeWindows) {
    const countNotes = async () => (await proseNotes(article.libraryID)).length;
    const standalone = [];
    for (const [suffix, original] of [["A", "独立笔记 A：原有正文必须保留。"], ["B", "独立笔记 B：另一份原有正文。"]]) {
      const note = new Zotero.Item("note"); note.libraryID = article.libraryID;
      note.setNote('<div data-schema-version="9"><p>' + original + '</p></div>');
      await note.saveTx(); standalone.push({ note, suffix, original });
    }
    const beforeCount = await countNotes(), first = standalone[0], second = standalone[1];
    result.standaloneNotes = standalone.map(({ note, suffix, original }) => ({ id: note.id, libraryID: note.libraryID, key: note.key, suffix, original }));
    current.hide();
    await host.ZoteroPane.selectItems([first.note.id], { noWindowRestore: true });
    const builtin = host.document.getElementById("zotero-note-editor");
    await waitFor(() => builtin.item?.id === first.note.id && builtin.getCurrentInstance(), "standalone built-in editor");
    await builtin.getCurrentInstance()._initPromise;
    check("standalone original editor is visible before tools open", host.document.getElementById("zotero-item-pane-content").selectedPanel === builtin && builtin.getBoundingClientRect().width > 0 && builtin.getBoundingClientRect().height > 0);
    const builtinText = "独立笔记 A：打开阅读台之前的原生编辑。";
    await typeNative({ editor: builtin, note: first.note }, builtinText);
    current = await nativeReady(await openItem(api, first.note, host));
    check("standalone note opens in existing library sidebar", current.kind === "library" && current.deck.selectedPanel === current.panel && current.panel.ownerDocument === host.document);
    check("standalone note keeps original ID key and no parent", current.note.id === first.note.id && current.note.key === first.note.key && !current.note.parentID && current.parentID === null);
    check("standalone tools bind directly to the selected note", current.getState().item.key === first.note.key && current.getState().noteKey === first.note.key);
    const initialHTML = await savedNoteHTML(first.note);
    check("standalone opening preserves existing prose without template", initialHTML.includes(first.original) && initialHTML.includes(builtinText) && !initialHTML.includes("术语与命题") && !initialHTML.includes("批评性判断"));
    check("standalone opening creates no extra note", (await countNotes()) === beforeCount);
    check("standalone opening creates no popup", chromeWindows().every(window => beforeWindows.includes(window)), newWindowDetails(beforeWindows));
    const document = current.toolsWindow.document;
    setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
    const rootEditor = document.querySelector('.node[data-node-id="root"] .node-text');
    const rootText = "独立主题 A：已有笔记也能建立金字塔。", boldText = "已有笔记";
    rootEditor.textContent = rootText; rootEditor.dispatchEvent(new current.toolsWindow.Event("input", { bubbles: true }));
    rootEditor.focus();
    const start = rootText.indexOf(boldText), end = start + boldText.length, range = document.createRange();
    range.setStart(rootEditor.firstChild, start); range.setEnd(rootEditor.firstChild, end);
    const selection = current.toolsWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    await waitFor(() => !document.getElementById("node-bold").disabled, "standalone bold selection");
    document.getElementById("node-bold").click();
    check("standalone pyramid accepts partial bold", current.getState().pyramid.text === rootText && (current.getState().pyramid.boldRanges || []).some(span => span.start === start && span.end === end));
    if (!document.querySelector(".framing-note") || document.querySelector(".framing-note").hidden) document.getElementById("framing-toggle").click();
    for (const [id, value] of [["framing-situation", "独立背景 A：日常想法整理。"], ["framing-complication", "独立冲突 A：需要厘清论证。"]]) {
      const field = document.getElementById(id); field.value = value; field.dispatchEvent(new current.toolsWindow.Event("input", { bubbles: true }));
    }
    document.querySelector('.node[data-node-id="root"]').click(); document.getElementById("node-child").click();
    const child = document.querySelector('.top-children .node .node-text');
    child.textContent = "独立论点 A：支持核心观点。"; child.dispatchEvent(new current.toolsWindow.Event("input", { bubbles: true }));
    document.getElementById("start-inspection").click();
    await waitFor(() => current.getState().timers.inspection.status === "running", "standalone inspection timer");
    document.getElementById("start-analysis").click();
    await waitFor(() => current.getState().timers.analysis.status === "running", "standalone analysis timer");
    const analysisDeadline = current.getState().timers.analysis.deadline;
    check("standalone ten and twenty minute timers work", current.getState().timers.inspection.durationMs === 600000 && current.getState().timers.analysis.durationMs === 1200000 && current.getState().timers.inspection.status === "paused");
    const editorText = "独立笔记 A：阅读台中的原生编辑。";
    await typeNative(current, editorText);
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    document.getElementById("insert-pyramid").click();
    await waitFor(async () => /data-attachment-key=/.test(await savedNoteHTML(first.note)), "standalone image persistence", 45000);
    const insertedHTML = await savedNoteHTML(first.note), imageKey = insertedHTML.match(/data-attachment-key=["']([^"']+)["']/)?.[1];
    const image = imageKey && await Zotero.Items.getByLibraryAndKeyAsync(first.note.libraryID, imageKey);
    check("standalone PNG attaches to exact original note", image?.isAttachment() && image.parentID === first.note.id && image.attachmentContentType === "image/png", imageKey);
    check("standalone insertion preserves all prose", [first.original, builtinText, editorText].every(text => insertedHTML.includes(text)));
    const savedA = JSON.parse(JSON.stringify(current.getState()));
    result.standaloneNotes[0].editorText = editorText; result.standaloneNotes[0].builtinText = builtinText; result.standaloneNotes[0].imageKey = imageKey;
    result.standaloneNotes[0].rootText = rootText; result.standaloneNotes[0].boldText = boldText; result.standaloneNotes[0].analysisDeadline = analysisDeadline;
    async function openFromRail(note, label) {
      current.hide(); await host.ZoteroPane.selectItems([note.id], { noWindowRestore: true });
      const handle = api.inspect(host).find(handle => handle.kind === "library");
      await waitFor(() => {
        const button = handle.button, box = button?.getBoundingClientRect();
        return button && !button.hasAttribute("disabled") && box.width > 0 && box.height > 0 && !button.parentElement.hidden;
      }, "visible standalone rail " + label);
      check("standalone rail is visible and enabled " + label, !handle.button.parentElement.hidden && !handle.button.hasAttribute("disabled"));
      handle.button.click();
      await waitFor(() => handle.note?.id === note.id && handle.getState()?.item.key === note.key && handle.deck.selectedPanel === handle.panel, "standalone rail maps selected note " + label);
      current = await nativeReady(handle); return handle;
    }
    await openFromRail(second.note, "B");
    check("standalone second note has independent empty tools", current.note.id === second.note.id && !current.note.parentID && current.getState().noteKey === second.note.key && current.getState().pyramid.text === "" && current.getState().timers.analysis.status === "idle" && current.getState().framing.situation === "");
    const secondText = "独立笔记 B：自己的原生编辑记录。";
    await typeNative(current, secondText); result.standaloneNotes[1].editorText = secondText;
    await openFromRail(first.note, "A");
    check("standalone rail reopens original note rather than stale article", current.note.id === first.note.id && current.getState().item.key === first.note.key && current.note.id !== (await proseNotes(article.libraryID, article))[0]?.id);
    check("standalone switch restores timer pyramid and framing", current.getState().timers.analysis.deadline === analysisDeadline && current.getState().pyramid.text === rootText && JSON.stringify(current.getState().pyramid.boldRanges) === JSON.stringify(savedA.pyramid.boldRanges) && current.getState().framing.situation === savedA.framing.situation && current.getState().framing.complication === savedA.framing.complication && current.getState().pyramid.children[0]?.text === savedA.pyramid.children[0]?.text);
    check("standalone switch keeps prose and image on original note", [first.original, builtinText, editorText, "data-attachment-key="].every(text => first.note.getNote().includes(text)));
    check("standalone second note retains independent prose", (await savedNoteHTML(second.note)).includes(second.original) && (await savedNoteHTML(second.note)).includes(secondText) && !(await savedNoteHTML(second.note)).includes("data-attachment-key="));
    check("standalone workflow never creates replacement notes", (await countNotes()) === beforeCount && !first.note.parentID && !second.note.parentID);
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    if (capturePreviews) {
      setDisclosure(current, "pyramid-area", "pyramid-toggle", true); host.resizeTo(1300, 900); await delay(500);
      result.standalonePreviewPath = await captureNativeWindow(host, "native-standalone-preview.png");
    }
    await host.ZoteroPane.selectItems([article.id], { noWindowRestore: true });
    current = await nativeReady(await openItem(api, article, host));
    check("return from standalone notes retains article binding", current.note.parentID === article.id && current.getState().item.key === article.key && current.getState().pyramid.text.includes("单框实机编辑内容"));
  }
  async function readerStandaloneNoteRegression(api, host, article, beforeWindows) {
    const articleNoteID = current.note.id, articleHTML = await savedNoteHTML(current.note), readerTabID = host.Zotero_Tabs.selectedID;
    const countNotes = async () => (await proseNotes(article.libraryID)).length;
    const beforeCount = await countNotes();
    current.hide();
    const pane = host.document.getElementById("zotero-context-pane-inner");
    await pane._setupNotesContext(readerTabID);
    host.ZoteroContextPane.collapsed = false;
    pane.sidenav._contextNotesPaneVisible = true;
    const notesContext = pane._getCurrentNotesContext();
    check("PDF native notes context exposes standalone creation", notesContext && typeof notesContext._createNote === "function" && pane.mode === "notes");
    // This is the same native operation behind “所有笔记 → 添加独立笔记”.
    notesContext._createNote();
    const nativeEditor = await waitFor(() => notesContext.standaloneEditor?.getCurrentInstance() && notesContext.standaloneEditor, "new native standalone context editor");
    await nativeEditor.getCurrentInstance()._initPromise;
    const originalNote = nativeEditor.item;
    check("new PDF context standalone note starts without an ID", originalNote?.isNote() && !originalNote.parentID && !originalNote.id && !originalNote.key);
    check("native PDF context note is active before rail click", host.ZoteroContextPane.activeEditor === nativeEditor && pane.mode === "notes");
    const handle = api.inspect(host).find(handle => handle.kind === "reader");
    check("PDF standalone context keeps reading rail enabled", !!handle.button && !handle.button.hasAttribute("disabled") && !handle.button.parentElement.hidden);
    handle.button.click();
    await waitFor(() => originalNote.id && originalNote.key && handle.note?.id === originalNote.id && handle.getState()?.noteKey === originalNote.key && handle.deck.selectedPanel === handle.panel, "reading rail saves and opens original unsaved context note");
    current = await nativeReady(handle);
    check("PDF standalone rail opens exact original note object", current.note === originalNote && current.parentID === null && !current.note.parentID && current.kind === "reader" && current.getState().item.key === originalNote.key);
    check("PDF standalone rail saves exactly one native note", (await countNotes()) === beforeCount + 1);
    check("PDF remains selected during standalone reading", host.Zotero_Tabs.selectedID === readerTabID && host.Zotero_Tabs.selectedID !== "zotero-pane");
    check("PDF standalone reading creates no popup", chromeWindows().every(window => beforeWindows.includes(window)), newWindowDetails(beforeWindows));
    const document = current.toolsWindow.document, rootText = "PDF 独立笔记：在阅读中整理另一条思路。";
    setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
    const root = document.querySelector('.node[data-node-id="root"] .node-text');
    root.textContent = rootText; root.dispatchEvent(new current.toolsWindow.Event("input", { bubbles: true }));
    if (!document.querySelector(".framing-note") || document.querySelector(".framing-note").hidden) document.getElementById("framing-toggle").click();
    const background = document.getElementById("framing-situation");
    background.value = "PDF 旁的独立背景记录。"; background.dispatchEvent(new current.toolsWindow.Event("input", { bubbles: true }));
    document.getElementById("start-inspection").click();
    await waitFor(() => current.getState().timers.inspection.status === "running", "PDF standalone inspection timer");
    const inspectionDeadline = current.getState().timers.inspection.deadline;
    const editorText = "PDF 独立笔记的正文必须留在这份独立笔记。";
    await typeNative(current, editorText);
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    document.getElementById("insert-pyramid").click();
    await waitFor(async () => /data-attachment-key=/.test(await savedNoteHTML(originalNote)), "PDF context independent PNG", 45000);
    const noteHTML = await savedNoteHTML(originalNote), imageKey = noteHTML.match(/data-attachment-key=["']([^"']+)["']/)?.[1];
    const image = imageKey && await Zotero.Items.getByLibraryAndKeyAsync(originalNote.libraryID, imageKey);
    check("PDF context PNG attaches to original independent note", image?.parentID === originalNote.id && image.attachmentContentType === "image/png" && noteHTML.includes(editorText));
    current.button.click();
    await delay(250);
    await waitFor(() => !document.getElementById("insert-pyramid").disabled, "repeated rail click keeps the pending independent image insertion valid");
    check("repeated same-note rail click preserves image insertion success", document.getElementById("status").textContent.includes("金字塔已插入笔记"), document.getElementById("status").textContent);
    check("repeated PDF reading rail click stays on independent note", current.note.id === originalNote.id && current.getState().item.key === originalNote.key && current.getState().pyramid.text === rootText && host.Zotero_Tabs.selectedID === readerTabID);
    check("PDF standalone tools do not modify article note", (await Zotero.DB.valueQueryAsync("SELECT note FROM itemNotes WHERE itemID=?", [articleNoteID])) === articleHTML);
    check("PDF standalone workflow creates no extra replacement note", (await countNotes()) === beforeCount + 1);
    result.readerStandaloneNote = { id: originalNote.id, libraryID: originalNote.libraryID, key: originalNote.key, editorText, imageKey, rootText, inspectionDeadline, articleNoteID };
    if (capturePreviews) {
      await delay(500); result.readerStandalonePreviewPath = await captureNativeWindow(host, "native-reader-standalone-preview.png");
    }
    current = await nativeReady(await openItem(api, article, host));
    check("explicit PDF article reopen restores original note and tab", current.kind === "reader" && current.note.id === articleNoteID && current.note.parentID === article.id && host.Zotero_Tabs.selectedID === readerTabID);
    check("explicit article reopen preserves independent context note", (await savedNoteHTML(originalNote)).includes(editorText) && (await savedNoteHTML(originalNote)).includes(imageKey));
    // The still-pinned native standalone editor is the next rail click's target.
    // Test that desired behavior, then use Zotero's native back action so the
    // following article/PDF-annotation regressions start in their own context.
    current.hide();
    await waitFor(() => host.ZoteroContextPane.activeEditor === notesContext.standaloneEditor && pane.mode === "notes", "pinned independent editor visible after reading sidebar hides");
    handle.button.click();
    await waitFor(() => handle.note?.id === originalNote.id && handle.deck.selectedPanel === handle.panel, "PDF rail returns to pinned original independent note");
    current = await nativeReady(handle);
    check("hide and rail reopen preserve pinned independent target", current.note.id === originalNote.id && current.getState().pyramid.text === rootText && current.getState().timers.inspection.deadline === inspectionDeadline);
    current.editor.saveSync(); await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    current.hide();
    await waitFor(() => host.ZoteroContextPane.activeEditor === notesContext.standaloneEditor, "native independent editor before returning to all notes");
    notesContext._handleNoteEditorReturn();
    await waitFor(() => notesContext.mode === "notesList" && !notesContext.standaloneEditor, "native independent editor returns to all notes");
    await Zotero.DB.waitForTransaction(); await delay(200);
    check("native return to all notes preserves independent prose and image", (await savedNoteHTML(originalNote)).includes(editorText) && (await savedNoteHTML(originalNote)).includes(imageKey));
    current = await nativeReady(await openItem(api, article, host));
    check("article context restored after independent note unpinned", current.kind === "reader" && current.note.id === articleNoteID && current.note.parentID === article.id && host.Zotero_Tabs.selectedID === readerTabID && (await savedNoteHTML(current.note)) === articleHTML);
  }
  function toolGeometry(handle) {
    const toolWindow = handle.toolsWindow, document = toolWindow.document;
    const sizing = toolWindow.ReadingFlowApp.getSizing();
    const diagram = document.getElementById("diagram-scroll");
    const hostViewportHeight = handle.hostWindow.innerHeight;
    const panelRect = handle.panel.getBoundingClientRect(), frameRect = handle.frame.getBoundingClientRect(), editorRect = handle.editor.getBoundingClientRect();
    const visibleHeight = rect => Math.max(0, Math.min(hostViewportHeight, rect.bottom) - Math.max(0, rect.top));
    const diagramRect = diagram.getBoundingClientRect();
    const diagramVisibleHeight = Math.max(0, Math.min(hostViewportHeight, frameRect.bottom, frameRect.top + diagramRect.bottom) - Math.max(0, frameRect.top, frameRect.top + diagramRect.top));
    const nativeFrameRect = handle.editor._iframe.getBoundingClientRect();
    const nativeBodyRect = handle.editor.getCurrentInstance()._iframeWindow.document.querySelector(".editor-core").getBoundingClientRect();
    const nativeBodyVisibleHeight = Math.max(0, Math.min(hostViewportHeight, nativeFrameRect.bottom, nativeFrameRect.top + nativeBodyRect.bottom) - Math.max(0, nativeFrameRect.top, nativeFrameRect.top + nativeBodyRect.top));
    return {
      ...sizing,
      hostViewportHeight,
      panelHeight: panelRect.height,
      panelVisibleHeight: visibleHeight(panelRect),
      frameHeight: frameRect.height,
      frameVisibleHeight: visibleHeight(frameRect),
      innerHeight: toolWindow.innerHeight,
      diagramClientHeight: diagram.clientHeight,
      diagramScrollHeight: diagram.scrollHeight,
      diagramVisibleHeight,
      editorHeight: editorRect.height,
      editorVisibleHeight: visibleHeight(editorRect),
      nativeBodyVisibleHeight,
      nativeFrameTop: nativeFrameRect.top,
      nativeFrameHeight: nativeFrameRect.height,
      nativeBodyTop: nativeBodyRect.top,
      nativeBodyHeight: nativeBodyRect.height,
      nativeFooterHeight: handle.editor.querySelector("#links-container")?.getBoundingClientRect().height || 0,
      hostRequestedHeight: handle.requestedToolsHeight,
      hostAllocatedHeight: handle.allocatedToolsHeight,
      menusOpen: ["pyramid-area", "checklist-area", "more-area"].every(id => !document.getElementById(id).hidden)
    };
  }
  async function stableTools(handle, label) {
    const deadline = Date.now() + 5000;
    let samples = [];
    while (Date.now() < deadline) {
      await delay(120);
      samples.push(toolGeometry(handle));
      if (samples.length > 8) samples.shift();
      if (samples.length < 8) continue;
      const stable = ["requestedHeight", "frameHeight", "diagramClientHeight"].every(field => {
        const values = samples.map(sample => sample[field]);
        return values.every(Number.isFinite) && Math.max(...values) - Math.min(...values) <= 2;
      });
      if (stable) {
        (result.sizingRegression ??= []).push({ label, samples });
        return samples[samples.length - 1];
      }
    }
    throw new Error("Tools height failed to stabilize: " + label + " " + JSON.stringify(samples));
  }
  function setDisclosure(handle, areaID, buttonID, open) {
    const document = handle.toolsWindow.document;
    if (document.getElementById(areaID).hidden === open) document.getElementById(buttonID).click();
  }
  function dividerKey(handle, key, shiftKey = false) {
    const window = handle.toolsWindow, divider = window.document.getElementById("pyramid-resizer");
    divider.focus();
    divider.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  }
  function storedPyramidHeight() {
    try { return Zotero.Prefs.get("readingFlow.pyramidHeight"); }
    catch (_) { return null; }
  }
  function dividerDrag(handle, distance) {
    const window = handle.toolsWindow, divider = window.document.getElementById("pyramid-resizer");
    const rect = divider.getBoundingClientRect();
    const options = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, screenY: 500 };
    divider.dispatchEvent(new window.PointerEvent("pointerdown", options));
    window.dispatchEvent(new window.PointerEvent("pointermove", { ...options, screenY: 500 + distance }));
    window.dispatchEvent(new window.PointerEvent("pointerup", { ...options, screenY: 500 + distance, buttons: 0 }));
  }
  async function adjustablePyramidHeightRegression(api, article, host, nativeText) {
    host.resizeTo(1300, 900); await delay(350);
    const handle = current, window = handle.toolsWindow, document = window.document;
    for (const [area, button] of [["more-area", "more-toggle"], ["checklist-area", "checklist-toggle"]]) setDisclosure(handle, area, button, false);
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", true);
    const divider = document.getElementById("pyramid-resizer");
    check("native pyramid exposes accessible horizontal divider", !!divider && divider.getAttribute("role") === "separator" && divider.getAttribute("aria-orientation") === "horizontal" && divider.tabIndex === 0);
    dividerKey(handle, "Home");
    const automatic = await stableTools(handle, "native divider begins in automatic mode");
    const beforeState = JSON.stringify(handle.getState());
    dividerDrag(handle, 130);
    const enlarged = await stableTools(handle, "native divider drag enlarges pyramid");
    check("native pointer drag changes displayed pyramid height", Number.isInteger(enlarged.manualHeight) && enlarged.manualHeight >= automatic.diagramClientHeight + 125 && enlarged.diagramClientHeight >= automatic.diagramClientHeight + 90, { automatic, enlarged });
    await waitFor(() => storedPyramidHeight() === enlarged.manualHeight, "native drag preference saved");
    check("native drag does not alter pyramid or note record", JSON.stringify(handle.getState()) === beforeState && (await savedNoteHTML(handle.note)).includes(nativeText));
    dividerDrag(handle, 1600);
    const maximum = await stableTools(handle, "native divider exceeds previous percentage cap");
    check("manual native viewport grows beyond old sixty-five percent cap", maximum.manualHeight === 1600 && maximum.frameHeight > maximum.panelVisibleHeight * .65 + 10, maximum);
    check("manual native viewport reserves editable note space", maximum.editorHeight >= 80 && maximum.editorVisibleHeight >= 80 && Math.abs(maximum.frameHeight - maximum.hostAllocatedHeight) <= 2, maximum);
    dividerDrag(handle, -100);
    const shrunken = await stableTools(handle, "native divider shrinks from its visible height");
    check("native pointer shrink starts from visible allocated viewport", Math.abs(shrunken.manualHeight - Math.round(maximum.diagramClientHeight - 100)) <= 2 && shrunken.diagramClientHeight <= maximum.diagramClientHeight - 95, { maximum, shrunken });
    dividerKey(handle, "ArrowUp");
    const up = await stableTools(handle, "native divider keyboard up");
    check("native divider keyboard arrow decreases twenty pixels", up.manualHeight === shrunken.manualHeight - 20, { shrunken, up });
    dividerKey(handle, "ArrowDown", true);
    const down = await stableTools(handle, "native divider shifted keyboard down");
    check("native divider shifted keyboard increases eighty pixels", down.manualHeight === up.manualHeight + 80, { up, down });
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", false);
    const collapsed = await stableTools(handle, "manual native pyramid collapses");
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", true);
    const expanded = await stableTools(handle, "manual native pyramid re-expands");
    check("manual height survives pyramid collapse and expansion", expanded.manualHeight === down.manualHeight && Math.abs(expanded.diagramClientHeight - down.diagramClientHeight) <= 2 && collapsed.frameHeight < expanded.frameHeight, { collapsed, expanded, down });
    handle.hide(); await delay(200); handle.button.click();
    await waitFor(() => handle.deck.selectedPanel === handle.panel, "manual height rail panel reopens");
    const rail = await stableTools(handle, "manual height rail reopened");
    check("manual height survives native rail hide and reopen", rail.manualHeight === down.manualHeight && Math.abs(rail.diagramClientHeight - down.diagramClientHeight) <= 2, rail);
    current = await nativeReady(await openItem(api, article, host));
    setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
    const reloaded = await stableTools(current, "manual height survives native config reload");
    check("manual height restores on native config reload", reloaded.manualHeight === down.manualHeight && storedPyramidHeight() === down.manualHeight, reloaded);
    dividerKey(current, "Home");
    const home = await stableTools(current, "native divider home returns automatic mode");
    await waitFor(() => !storedPyramidHeight(), "native home clears height preference");
    check("native divider Home restores automatic sizing", home.manualHeight === null && Math.abs(home.diagramClientHeight - automatic.diagramClientHeight) <= 2, { home, automatic });
    dividerKey(current, "ArrowDown");
    await stableTools(current, "native divider keyboard sets a new manual height");
    current.toolsWindow.document.getElementById("pyramid-resizer").dispatchEvent(new current.toolsWindow.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const reset = await stableTools(current, "native divider double click restores automatic mode");
    await waitFor(() => !storedPyramidHeight(), "native double click clears height preference");
    check("native divider double click restores automatic sizing", reset.manualHeight === null && Math.abs(reset.diagramClientHeight - automatic.diagramClientHeight) <= 2, reset);
    setDisclosure(current, "pyramid-area", "pyramid-toggle", false);
  }
  async function pyramidViewportRegression(handle, host, nativeText) {
    check("tools expose intrinsic and allocated sizing", typeof handle.toolsWindow.ReadingFlowApp.getSizing === "function");
    // The reported bug occurs in a short native window with all disclosures open.
    host.resizeTo(1000, 600);
    await delay(350);
    for (const [area, button] of [["more-area", "more-toggle"], ["checklist-area", "checklist-toggle"], ["pyramid-area", "pyramid-toggle"]]) setDisclosure(handle, area, button, true);
    const expanded = await stableTools(handle, "all disclosures open in short window");
    check("all three disclosures expand in real sidebar", expanded.menusOpen, expanded);
    check("expanded pyramid has usable viewport", expanded.diagramClientHeight >= 100 && expanded.diagramVisibleHeight >= 100, expanded);
    check("frame allocation and content viewport agree", Math.abs(expanded.frameHeight - expanded.innerHeight) <= 2 && Math.abs(expanded.frameHeight - expanded.hostAllocatedHeight) <= 2, expanded);
    check("intrinsic request survives host height clamp", expanded.requestedHeight >= Math.min(500, expanded.intrinsicHeaderHeight + Math.min(expanded.naturalDiagramHeight, 380)) - 2 && Math.abs(expanded.hostRequestedHeight - expanded.requestedHeight) <= 2, expanded);
    check("native editor remains usable while tools expanded", expanded.editorHeight >= 100 && expanded.nativeBodyVisibleHeight >= 100, expanded);
    handle.hide(); await delay(300);
    check("hidden sidebar retains requested expansion height", handle.requestedToolsHeight >= expanded.requestedHeight - 2, { hiddenRequest: handle.requestedToolsHeight, previousRequest: expanded.requestedHeight });
    handle.button.click(); await waitFor(() => handle.deck.selectedPanel === handle.panel, "expanded rail panel reopens");
    const railReopened = await stableTools(handle, "rail panel reopened with all disclosures open");
    check("rail reopen preserves all disclosures and usable pyramid", railReopened.menusOpen && railReopened.diagramClientHeight >= 100 && Math.abs(railReopened.requestedHeight - expanded.requestedHeight) <= 2, railReopened);
    const document = handle.toolsWindow.document;
    document.querySelector('.node[data-node-id="root"]').click();
    const before = handle.getState().pyramid.children.length;
    document.getElementById("node-child").click();
    check("expanded tree accepts new child", handle.getState().pyramid.children.length === before + 1);
    const created = handle.getState().pyramid.children[before];
    const newCard = document.querySelector('[data-node-id="' + created.id + '"]');
    const text = newCard.querySelector('.node-text[aria-label="节点内容"]');
    text.textContent = "高度回归：新增论点仍可编辑"; text.dispatchEvent(new handle.toolsWindow.Event("input", { bubbles: true }));
    document.getElementById("node-sibling").click();
    check("expanded tree accepts editable child and sibling", handle.getState().pyramid.children[before].text === text.textContent && handle.getState().pyramid.children.length === before + 2);
    const edited = await stableTools(handle, "tree grows without shrinking height request");
    check("adding nodes keeps viewport usable", edited.diagramClientHeight >= 100 && edited.requestedHeight >= expanded.requestedHeight - 2, edited);
    const scroll = document.getElementById("diagram-scroll");
    scroll.scrollTop = scroll.scrollHeight;
    check("expanded diagram can scroll to lower content", scroll.scrollHeight <= scroll.clientHeight + 1 || scroll.scrollTop > 0, { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight });
    setDisclosure(handle, "more-area", "more-toggle", false); setDisclosure(handle, "checklist-area", "checklist-toggle", false);
    const pyramidOnly = await stableTools(handle, "closing auxiliary menus restores tree space");
    check("closing other disclosures restores diagram space", pyramidOnly.diagramClientHeight >= 150 && pyramidOnly.diagramClientHeight >= edited.diagramClientHeight, pyramidOnly);
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", false);
    const collapsed = await stableTools(handle, "pyramid collapsed");
    check("collapsing pyramid releases native editor height", collapsed.frameHeight < pyramidOnly.frameHeight && collapsed.editorHeight > pyramidOnly.editorHeight, collapsed);
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", true);
    const reopened = await stableTools(handle, "pyramid reopened");
    check("reopening pyramid restores usable height", reopened.diagramClientHeight >= 150 && Math.abs(reopened.requestedHeight - pyramidOnly.requestedHeight) <= 2, reopened);
    host.resizeTo(1300, 900);
    const enlarged = await stableTools(handle, "host enlarged with pyramid still open");
    check("host resize reallocates existing pyramid", enlarged.diagramClientHeight >= reopened.diagramClientHeight && enlarged.frameHeight >= reopened.frameHeight, enlarged);
    await handle.toolsWindow.ReadingFlowApp.flushPendingSave();
    check("viewport operations preserve native written note", (await savedNoteHTML(handle.note)).includes(nativeText));
    setDisclosure(handle, "pyramid-area", "pyramid-toggle", false);
    await stableTools(handle, "regression completed with tools compact");
  }
  async function completePluginEvent(id, event, action, label) {
    const owner = Zotero.Plugins._addonObserver, calls = [], wrapped = [];
    const methods = event === "shutdown" ? ["onDisabled"] : event === "uninstall" ? ["onUninstalling", "onUninstalled"] : ["onInstalled", "onEnabling"];
    for (const method of methods) {
      const original = owner[method];
      if (typeof original !== "function") throw new Error("Missing native plugin listener: " + method);
      const wrapper = function (addon, ...args) {
        const returned = original.call(this, addon, ...args);
        if (addon.id === id) {
          const call = { method, done: false, error: null }; calls.push(call);
          Promise.resolve(returned).then(() => { call.done = true; }, error => { call.error = error; call.done = true; });
        }
        return returned;
      };
      owner[method] = wrapper; wrapped.push({ method, original, wrapper });
    }
    try {
      // Await Zotero's own async listener promises, including absent-bootstrap
      // paths which return before emitting a plugin lifecycle observer event.
      await action();
      await waitFor(() => calls.length && (event !== "uninstall" || calls.some(call => call.method === "onUninstalled")) && calls.every(call => call.done), label + " complete native addon listener promises");
      const failed = calls.find(call => call.error); if (failed) throw failed.error;
      check(label + " native plugin lifecycle has fully completed", calls.length > 0 && calls.every(call => call.done), { callbacks: calls.map(call => call.method) });
    } finally { for (const { method, original, wrapper } of wrapped) if (owner[method] === wrapper) owner[method] = original; }
  }
  async function installXPI(path, expectedID) {
    if (!safeToQuit) throw new Error("Plugin installation requires the verified isolated profile and data paths");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const previous = await AddonManager.getAddonByID(expectedID);
    if (expectedID !== "reading-flow@local" && previous?.isActive) return previous;
    if (expectedID === "reading-flow@local" && previous) {
      if (previous.isActive) {
        // initializationPromise resolves before Plugins.init finishes loading
        // every active addon's bootstrap scope.
        await waitFor(() => Zotero.ReadingFlow?.openItem, "preinstalled Reading Flow bootstrap startup");
        await completePluginEvent(expectedID, "shutdown", () => previous.disable(), "isolated previous Reading Flow disable");
      }
      // Same-version installation of a disabled XPI can retain its old bytes.
      // Remove only the plugin in the verified disposable profile, not its data.
      await completePluginEvent(expectedID, "uninstall", () => previous.uninstall(), "isolated previous Reading Flow uninstall");
    }
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(path));
    check(expectedID + " package accepted", installation.error === 0, String(installation.error));
    await completePluginEvent(expectedID, "startup", async () => {
      await installation.install();
      const installed = await AddonManager.getAddonByID(expectedID);
      if (installed?.userDisabled) await installed.enable();
    }, expectedID + " install and startup");
    await waitFor(async () => (await AddonManager.getAddonByID(expectedID))?.isActive, expectedID + " activation");
    return AddonManager.getAddonByID(expectedID);
  }
  try {
    await Promise.race([Zotero.initializationPromise, delay(30000).then(() => { throw new Error("Initialization timeout"); })]);
    check("isolated profile", PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(expectedProfile), Zotero.Profile.dir);
    check("isolated data directory", PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(expectedData), Zotero.DataDirectory.dir);
    safeToQuit = true;
    const host = await waitFor(() => Zotero.getMainWindow(), "main window");
    await waitFor(() => host.ZoteroPane?.itemsView && host.ZoteroPane?.collectionsView, "library view");
    if (betterNotesPath) {
      // The isolated profile disables this autonomous Better Notes timer before
      // startup. Reinstalling Better Notes otherwise lets its old scope display
      // a “sync stopped” progress alert 30 seconds later, unrelated to our UI.
      const autonomousSyncPeriod = Zotero.Prefs.get("extensions.zotero.Knowledge4Zotero.syncPeriodSeconds", true);
      check("isolated Better Notes autonomous sync timer disabled", autonomousSyncPeriod === 0, autonomousSyncPeriod);
      const addon = await installXPI(betterNotesPath, "Knowledge4Zotero@windingwind.com");
      await waitFor(() => Zotero.BetterNotes?.hooks, "Better Notes startup");
      await delay(500);
      result.betterNotes = { version: addon.version, active: addon.isActive, autonomousSyncPeriod };
    }
    const addon = await installXPI(packagePath, "reading-flow@local");
    const api = await waitFor(() => Zotero.ReadingFlow?.openItem && Zotero.ReadingFlow, "Reading Flow API");
    result.pluginVersion = addon.version;
    const installedPackagePath = PathUtils.join(expectedProfile, "extensions", "reading-flow@local.xpi");
    const [expectedPackage, actualPackage] = await Promise.all([IOUtils.read(packagePath), IOUtils.read(installedPackagePath)]);
    result.installedPackagePath = installedPackagePath;
    result.installedPackageBytes = actualPackage.byteLength;
    check("installed package exactly matches final build", expectedPackage.byteLength === actualPackage.byteLength && expectedPackage.every((byte, index) => actualPackage[index] === byte));
    if (shutdownBaseline) {
      result.scenario = "shutdown-baseline-better-notes-without-reading-flow";
      await addon.disable();
      await Zotero.DB.waitForTransaction();
      await delay(1000);
      check("Reading Flow disabled before quit", !addon.isActive && !Zotero.ReadingFlow);
      result.status = "passed";
      return;
    }
    const first = new Zotero.Item("journalArticle");
    first.libraryID = Zotero.Libraries.userLibraryID;
    first.setField("title", "隔离侧栏测试 A <标题> & 原生笔记");
    await first.saveTx();
    const second = new Zotero.Item("journalArticle");
    second.libraryID = first.libraryID;
    second.setField("title", "隔离侧栏测试 B：独立会话");
    await second.saveTx();
    result.items = [first, second].map(item => ({ id: item.id, libraryID: item.libraryID, key: item.key }));
    const path = PathUtils.join(expectedData, "reading-flow", first.libraryID + "-" + first.key + ".json");
    await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
    const legacy = legacySession(first);
    await IOUtils.writeUTF8(path, JSON.stringify(legacy), { tmpPath: path + ".tmp" });
    await host.ZoteroPane.selectItems([first.id], { noWindowRestore: true });
    const beforeWindows = chromeWindows();
    result.initialChromeWindows = beforeWindows.map(window => ({ title: window.document?.title || "", location: String(window.location?.href || ""), windowtype: window.document?.documentElement?.getAttribute("windowtype") || "" }));
    current = await nativeReady(await openItem(api, first, host));
    check("library sidebar selected", current.kind === "library" && current.deck.selectedPanel === current.panel);
    check("sidebar belongs to main host", current.hostWindow === host && current.panel.ownerDocument === host.document);
    check("no popup window opened", chromeWindows().every(window => beforeWindows.includes(window)), newWindowDetails(beforeWindows));
    check("native note editor embedded", current.editor.localName === "note-editor" && current.editor.ownerDocument === host.document);
    check("compact tools above native editor", current.frame.ownerDocument === host.document && current.panel.contains(current.frame) && current.panel.contains(current.editor));
    check("paper mapped", current.getState().item.key === first.key);
    check("stable child note created", current.note.isNote() && current.note.parentID === first.id && (await proseNotes(first.libraryID, first)).length === 1);
    const firstNoteID = current.note.id;
    check("note key stored", current.getState().noteKey === current.note.key);
    check("native rail icon installed", !!current.button && current.button.ownerDocument === host.document);
    await verifyBranding(addon, current, host);
    current.hide();
    check("sidebar can be hidden", current.deck.selectedPanel !== current.panel);
    current.button.click();
    await waitFor(() => current.deck.selectedPanel === current.panel, "rail icon opens sidebar");
    check("rail icon opens same sidebar", current.panel.ownerDocument === host.document && chromeWindows().every(window => beforeWindows.includes(window)), newWindowDetails(beforeWindows));
    const migrated = await savedNoteHTML(current.note);
    check("legacy notes migrated", [legacy.inspection.structure, legacy.terms[0].term, legacy.reflection.nextStep, legacy.pyramid.children[0].children[0].source].every(value => migrated.includes(value)));
    check("three analytical aspects in native note", ["结构", "术语与命题", "批评性判断"].every(value => migrated.includes(value)));
    check("migration escapes input", migrated.includes("&lt;script&gt;") && !migrated.includes("<script>"));
    await verifySingleRootMigration(current, legacy, migrated);
    await verifyFramingAnnotations(current, legacy);
    const nativeText = "实机原生编辑：此段必须在切换及插图后保留。";
    await typeNative(current, nativeText);
    check("native note content persisted", (await savedNoteHTML(current.note)).includes(nativeText));
    const same = await openItem(api, first, host);
    check("same host reuses panel", same.panel === current.panel && same.note.id === firstNoteID);
    check("reopen preserves written note", (await savedNoteHTML(same.note)).includes(nativeText) && (await proseNotes(first.libraryID, first)).length === 1);
    await adjustablePyramidHeightRegression(api, first, host, nativeText);
    await pyramidViewportRegression(current, host, nativeText);

    setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
    dividerKey(current, "ArrowDown");
    const manualBeforeSwitch = await stableTools(current, "manual height before changing note context");
    const heightBeforeSwitch = manualBeforeSwitch.manualHeight;
    await waitFor(() => storedPyramidHeight() === heightBeforeSwitch, "manual height saved before note switch");
    setDisclosure(current, "pyramid-area", "pyramid-toggle", false);

    current.toolsWindow.document.getElementById("start-inspection").click();
    await waitFor(() => current.getState().timers.inspection.status === "running", "inspection timer start");
    check("ten minute native sidebar timer", current.getState().timers.inspection.durationMs === 600000 && Number.isFinite(current.getState().timers.inspection.deadline));
    current.toolsWindow.document.getElementById("start-analysis").click();
    await waitFor(() => current.getState().timers.analysis.status === "running", "analysis timer start");
    const analysisDeadline = current.getState().timers.analysis.deadline;
    check("twenty minute native sidebar timer", current.getState().timers.analysis.durationMs === 1200000 && current.getState().timers.inspection.status === "paused");

    // A real UI action creates a PNG snapshot and inserts it through the native editor.
    current.toolsWindow.document.getElementById("pyramid-toggle").click();
    const insertButton = current.toolsWindow.document.getElementById("insert-pyramid");
    check("explicit pyramid insertion action", !!insertButton);
    insertButton.click();
    await waitFor(async () => /data-attachment-key=/.test(await savedNoteHTML(current.note)), "native embedded PNG persistence", 45000);
    const insertedHTML = await savedNoteHTML(current.note);
    check("pyramid insertion preserves prose", insertedHTML.includes(nativeText));
    const imageKey = insertedHTML.match(/data-attachment-key=["']([^"']+)["']/)?.[1];
    const image = imageKey && await Zotero.Items.getByLibraryAndKeyAsync(first.libraryID, imageKey);
    check("pyramid stored as native image", image?.isAttachment() && image.parentID === firstNoteID && image.attachmentContentType === "image/png", imageKey);
    check("image file persisted in isolated data", !!image && (await image.getFilePathAsync()).startsWith(expectedData) && await IOUtils.exists(await image.getFilePathAsync()));

    await host.ZoteroPane.selectItems([second.id], { noWindowRestore: true });
    current = await nativeReady(await openItem(api, second, host));
    check("item switch maps new paper", current.getState().item.key === second.key && current.note.parentID === second.id);
    check("new item has independent timers", current.getState().timers.inspection.status === "idle" && current.getState().timers.analysis.status === "idle");
    check("second item has its own note", current.note.id !== firstNoteID && (await proseNotes(second.libraryID, second)).length === 1);
    setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
    const emptyTree = await stableTools(current, "empty pyramid retains chosen manual viewport");
    check("manual viewport height restores for another note with an empty pyramid", emptyTree.manualHeight === heightBeforeSwitch && emptyTree.naturalDiagramHeight < heightBeforeSwitch - 20 && Math.abs(emptyTree.diagramClientHeight - heightBeforeSwitch) <= 2 && current.getState().pyramid.text === "", emptyTree);
    setDisclosure(current, "pyramid-area", "pyramid-toggle", false);
    await typeNative(current, "第二篇文献的原生编辑记录");
    await host.ZoteroPane.selectItems([first.id], { noWindowRestore: true });
    current = await nativeReady(await openItem(api, first, host));
    check("return restores same child note", current.note.id === firstNoteID && current.getState().item.key === first.key);
    check("item switch preserves timer deadline", current.getState().timers.analysis.status === "running" && current.getState().timers.analysis.deadline === analysisDeadline);
    check("return preserves original text and image", (await savedNoteHTML(current.note)).includes(nativeText) && /data-attachment-key=/.test(await savedNoteHTML(current.note)));
    check("single root persists after item switch", current.getState().pyramid.text.includes("单框实机编辑内容") && current.toolsWindow.document.querySelectorAll('.node[data-node-id="root"] .node-text').length === 1 && current.getState().framing.question === "");
    check("pyramid bold survives item switch", (current.getState().pyramid.boldRanges || []).some(range => current.getState().pyramid.text.slice(range.start, range.end) === "单框实机编辑内容"));
    check("background annotations survive item switch", current.getState().framing.situation.includes("实机背景批注") && current.getState().framing.complication.includes("实机冲突批注"));
    check("manual viewport preference survives returning to first note", current.toolsWindow.ReadingFlowApp.getSizing().manualHeight === heightBeforeSwitch && storedPyramidHeight() === heightBeforeSwitch);

    await standaloneNotesRegression(api, host, first, beforeWindows);

    // Open a generated PDF in a normal tab; no user document is imported.
    const attachment = await Zotero.Attachments.importFromFile({ file: pdfFixturePath, parentItemID: first.id });
    const reader = await Zotero.Reader.open(attachment.id, null, { openInWindow: false });
    await Promise.race([reader._initPromise, delay(30000).then(() => { throw new Error("PDF reader initialization timeout"); })]);
    await waitFor(() => host.Zotero_Tabs.selectedID !== "zotero-pane", "PDF tab selected");
    current = await nativeReady(await openItem(api, attachment, host));
    check("reader sidebar selected while PDF stays open", current.kind === "reader" && current.deck.selectedPanel === current.panel && host.Zotero_Tabs.selectedID !== "zotero-pane");
    check("PDF reader maps parent paper", current.getState().item.key === first.key && current.note.id === firstNoteID);
    check("PDF sidebar remains in same host", current.hostWindow === host && current.editor.ownerDocument === host.document);
    check("PDF rail icon present", !!current.button);
    check("reader creates no popup", chromeWindows().every(window => beforeWindows.includes(window)), newWindowDetails(beforeWindows));
    check("PDF Add to Note resolves native sidebar editor", host.ZoteroContextPane.activeEditor === current.editor);
    setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
    const restoredReaderHeight = await stableTools(current, "PDF reader restores chosen manual height");
    check("chosen manual viewport height restores in PDF reader context", restoredReaderHeight.manualHeight === heightBeforeSwitch && Math.abs(restoredReaderHeight.diagramClientHeight - heightBeforeSwitch) <= 2, restoredReaderHeight);
    dividerKey(current, "Home");
    await stableTools(current, "PDF reader resets to automatic baseline");
    await waitFor(() => !storedPyramidHeight(), "PDF reader clears manual height before automatic regressions");
    setDisclosure(current, "pyramid-area", "pyramid-toggle", false);
    await readerStandaloneNoteRegression(api, host, first, beforeWindows);
    current.hide();
    check("hiding sidebar restores original Add to Note editor", host.ZoteroContextPane.activeEditor !== current.editor);
    current.button.click();
    await waitFor(() => current.deck.selectedPanel === current.panel, "PDF rail click reopens sidebar");
    check("PDF Add to Note returns to sidebar editor", host.ZoteroContextPane.activeEditor === current.editor);
    host.resizeTo(1000, 600); await delay(350);
    for (const [area, button] of [["more-area", "more-toggle"], ["checklist-area", "checklist-toggle"], ["pyramid-area", "pyramid-toggle"]]) setDisclosure(current, area, button, true);
    const readerExpanded = await stableTools(current, "PDF reader all disclosures open in short window");
    result.readerLayoutAncestors = [];
    for (let ancestor = current.panel; ancestor && result.readerLayoutAncestors.length < 8; ancestor = ancestor.parentElement) {
      const box = ancestor.getBoundingClientRect(), style = host.getComputedStyle(ancestor);
      result.readerLayoutAncestors.push({ tag: ancestor.localName, id: ancestor.id, top: box.top, bottom: box.bottom, height: box.height, display: style.display, minHeight: style.minHeight, maxHeight: style.maxHeight, overflow: style.overflow });
    }
    const diagramScroll = current.toolsWindow.document.getElementById("diagram-scroll");
    const rootCard = current.toolsWindow.document.querySelector('.node[data-node-id="root"]');
    // Center the root rather than capturing the empty quadrant at the end of both scroll axes.
    diagramScroll.scrollTop = 0; diagramScroll.scrollLeft = 0;
    const initialRootRect = rootCard.getBoundingClientRect(), initialScrollRect = diagramScroll.getBoundingClientRect();
    diagramScroll.scrollLeft = Math.max(0, initialRootRect.left - initialScrollRect.left - (diagramScroll.clientWidth - initialRootRect.width) / 2);
    await delay(250);
    const rootRect = rootCard.getBoundingClientRect(), scrollRect = diagramScroll.getBoundingClientRect();
    const rootVisible = rootRect.bottom > scrollRect.top && rootRect.top < scrollRect.bottom && rootRect.right > scrollRect.left && rootRect.left < scrollRect.right;
    result.expandedPreviewGeometry = { root: { x: rootRect.x, y: rootRect.y, width: rootRect.width, height: rootRect.height }, viewport: { x: scrollRect.x, y: scrollRect.y, width: scrollRect.width, height: scrollRect.height }, scrollTop: diagramScroll.scrollTop, scrollLeft: diagramScroll.scrollLeft, rootVisible };
    check("PDF reader expanded pyramid has usable viewport", current.kind === "reader" && readerExpanded.menusOpen && readerExpanded.diagramClientHeight >= 100 && readerExpanded.diagramVisibleHeight >= 100 && rootVisible, { ...readerExpanded, rootVisible });
    check("PDF reader tools preserve native editor space", readerExpanded.editorHeight >= 100 && readerExpanded.nativeBodyVisibleHeight >= 100 && Math.abs(readerExpanded.frameHeight - readerExpanded.hostAllocatedHeight) <= 2, readerExpanded);
    if (capturePreviews) result.expandedPreviewPath = await captureNativeWindow(host, "native-sidebar-expanded-preview.png");
    setDisclosure(current, "more-area", "more-toggle", false); setDisclosure(current, "checklist-area", "checklist-toggle", false);
    const readerPyramidOnly = await stableTools(current, "PDF reader auxiliary menus closed");
    check("PDF reader closing auxiliary menus restores tree space", readerPyramidOnly.diagramClientHeight >= 150 && readerPyramidOnly.diagramClientHeight >= readerExpanded.diagramClientHeight, readerPyramidOnly);
    setDisclosure(current, "pyramid-area", "pyramid-toggle", false); host.resizeTo(1300, 900);
    await stableTools(current, "PDF reader tools compact after regression");
    const annotation = new Zotero.Item("annotation");
    annotation.libraryID = first.libraryID; annotation.parentID = attachment.id;
    annotation.annotationType = "highlight"; annotation.annotationIsExternal = false;
    annotation.annotationText = "实机 PDF 批注加入当前阅读笔记";
    annotation.annotationComment = ""; annotation.annotationColor = "#ffd400";
    annotation.annotationPageLabel = "1"; annotation.annotationSortIndex = "00000|000050|00000";
    annotation.annotationPosition = JSON.stringify({ pageIndex: 0, rects: [[50, 735, 350, 758]] });
    await annotation.saveTx();
    const annotationJSON = await Zotero.Annotations.toJSON(annotation);
    annotationJSON.id = annotation.key;
    reader._addToNote([annotationJSON]);
    await waitFor(async () => (await savedNoteHTML(current.note)).includes(annotation.annotationText), "PDF Add to Note database persistence");
    check("actual PDF annotation inserted into stable note", (await savedNoteHTML(current.note)).includes(annotation.annotationText) && current.note.id === firstNoteID);
    check("PDF insertion preserves written prose", (await savedNoteHTML(current.note)).includes(nativeText));
    if (betterNotesPath) {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      check("Better Notes remains active", (await AddonManager.getAddonByID("Knowledge4Zotero@windingwind.com"))?.isActive && !!Zotero.BetterNotes);
      check("Better Notes native editor hook coexists", typeof current.editor.getCurrentInstance === "function" && !!current.editor.getCurrentInstance());
    }
    current.editor.saveSync();
    await current.toolsWindow.ReadingFlowApp.flushPendingSave();
    const saved = JSON.parse(await IOUtils.readUTF8(path));
    check("sidebar session persisted", saved.item.key === first.key && saved.noteKey === current.note.key);
    check("pyramid bold range persisted in isolated session", (saved.pyramid.boldRanges || []).some(range => saved.pyramid.text.slice(range.start, range.end) === "单框实机编辑内容"));
    check("background annotations persisted in isolated session", saved.framing.situation.includes("实机背景批注") && saved.framing.complication.includes("实机冲突批注"));
    check("atomic session temp removed", !(await IOUtils.exists(path + ".tmp")));
    if (capturePreviews) {
      current.toolsWindow.document.getElementById("pyramid-toggle").click();
      await delay(500);
      try {
        result.previewPath = await captureNativeWindow(host, "native-sidebar-preview.png");
      } catch (error) { result.previewError = error.message || String(error); }
      // A separate blank fixture shows the text template without altering A/B's tested notes.
      const previewItem = new Zotero.Item("journalArticle");
      previewItem.libraryID = first.libraryID; previewItem.setField("title", "文献阅读（示例）"); await previewItem.saveTx();
      const previewAttachment = await Zotero.Attachments.importFromFile({ file: pdfFixturePath, parentItemID: previewItem.id });
      const previewReader = await Zotero.Reader.open(previewAttachment.id, null, { openInWindow: false });
      await Promise.race([previewReader._initPromise, delay(30000).then(() => { throw new Error("Preview PDF initialization timeout"); })]);
      current = await nativeReady(await openItem(api, previewAttachment, host));
      const toolsDocument = current.toolsWindow.document;
      for (const [area, button] of [["pyramid-area", "pyramid-toggle"], ["checklist-area", "checklist-toggle"], ["more-area", "more-toggle"]]) {
        if (!toolsDocument.getElementById(area).hidden) toolsDocument.getElementById(button).click();
      }
      host.resizeTo(1300, 900);
      const contextPane = host.document.getElementById("zotero-context-pane");
      contextPane.setAttribute("width", "500"); contextPane.style.width = "500px";
      const nativeWindow = current.editor.getCurrentInstance()._iframeWindow;
      const prose = nativeWindow.document.querySelector(".ProseMirror");
      for (let node = prose; node; node = node.parentElement) node.scrollTop = 0;
      nativeWindow.scrollTo(0, 0); prose.firstElementChild?.scrollIntoView({ block: "start" });
      await delay(700);
      result.previewHost = { pid: Services.appinfo.processID, title: host.document.title, tabID: host.Zotero_Tabs.selectedID, kind: current.kind };
      result.previewItem = { id: previewItem.id, noteKey: current.note.key };
      try { result.textPreviewPath = await captureNativeWindow(host, "native-sidebar-text-preview.png"); }
      catch (error) { result.textPreviewError = error.message || String(error); }
      setDisclosure(current, "pyramid-area", "pyramid-toggle", true);
      dividerKey(current, "ArrowDown", true);
      const persistentHeight = await stableTools(current, "blank native pyramid with persisted manual viewport");
      await waitFor(() => storedPyramidHeight() === persistentHeight.manualHeight, "final manual height preference saved");
      check("blank native pyramid displays fixed manually enlarged viewport", persistentHeight.manualHeight > persistentHeight.naturalDiagramHeight && Math.abs(persistentHeight.diagramClientHeight - persistentHeight.manualHeight) <= 2, persistentHeight);
      result.heightPreference = { key: "extensions.zotero.readingFlow.pyramidHeight", value: persistentHeight.manualHeight };
      result.heightPreviewPath = await captureNativeWindow(host, "native-pyramid-height-preview.png");
    }
    if (previewHoldMs) {
      const ackPath = PathUtils.join(PathUtils.parent(resultPath), "preview-done-" + Date.now() + ".flag");
      result.previewAckPath = ackPath;
      result.status = "passed-awaiting-preview";
      await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + ".tmp" });
      const deadline = Date.now() + previewHoldMs;
      while (Date.now() < deadline && !(await IOUtils.exists(ackPath))) await delay(500);
    }
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = { message: error.message || String(error), stack: error.stack || null };
    Zotero.logError(error);
  } finally {
    try {
      result.pluginConsole = Services.console.getMessageArray().map(message => message.message || String(message))
        .filter(message => /reading-flow|BetterNotes|nativeSidebar|MenuAPI|ItemPaneAPI|Extension is invalid|bootstrap/i.test(message)).slice(-35);
    } catch (_) {}
    result.finishedAt = new Date().toISOString();
    await checkpoint.catch(() => {});
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2), { tmpPath: resultPath + ".tmp" });
    delete Zotero.__readingFlowSmokeSandbox;
    delete Zotero.__readingFlowSmokePromise;
    if (safeToQuit) {
      try { current?.editor?.saveSync(); await current?.toolsWindow?.ReadingFlowApp?.flushPendingSave(); } catch (error) { Zotero.logError(error); }
      // Quit only the process whose profile and data directory were verified above.
      Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
    }
  }
}
