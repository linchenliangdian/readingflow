(function () {
  "use strict";
  const NS = "http://www.w3.org/1999/xhtml";
  const checkLabels = ["标题", "目录／章节", "摘要", "关键句", "结论", "参考文献"];
  let Core, state = null, bridge = null, item = null, readOnly = false, demo = false, syncVersions = [], syncBlocked = false;
  let selectedID = "root", revision = 0, savedRevision = 0, saving = null, saveTimeout = null;
  let actionBusy = false, configQueue = Promise.resolve(), lastHeight = 0, generation = 0;
  let boldSelection = null, framingVisible = false;
  let manualHeight = null, lastManualMode = null, heightDrag = null;
  let sizing = { requestedHeight: 54, allocatedHeight: 0, intrinsicHeaderHeight: 54, naturalDiagramHeight: 0, diagramViewportHeight: 0 };
  const expired = new Set();
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  function el(tag, className, text) {
    const node = document.createElementNS(NS, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function status(message, error) {
    $("status").textContent = message;
    $("status").className = error ? "error" : "";
    resize();
  }
  function intrinsicSizing() {
    const toolsBox = $("tools").getBoundingClientRect();
    if (toolsBox.width <= 0 || toolsBox.height <= 0) return null;
    try { const frame = window.frameElement; if (frame) { const box = frame.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) return null; } } catch (_) {}
    const toolsHeight = toolsBox.height;
    if ($("pyramid-area").hidden) return { intrinsicHeaderHeight: toolsHeight, naturalDiagramHeight: 0 };
    const scroll = $("diagram-scroll"), style = getComputedStyle(scroll);
    const px = property => parseFloat(style[property]) || 0;
    const border = px("borderTopWidth") + px("borderBottomWidth");
    const horizontalScrollbar = Math.max(0, scroll.offsetHeight - scroll.clientHeight - border);
    // #diagram retains its full content height even when its parent's viewport is clipped.
    const naturalDiagramHeight = $("diagram").getBoundingClientRect().height + px("paddingTop") + px("paddingBottom") + border + horizontalScrollbar;
    return { intrinsicHeaderHeight: toolsHeight - scroll.getBoundingClientRect().height, naturalDiagramHeight };
  }
  function fitViewport(acceptedHeight) {
    const intrinsic = intrinsicSizing();
    if (!intrinsic) return;
    const allocatedHeight = Number.isFinite(acceptedHeight) && acceptedHeight > 0 ? acceptedHeight : window.innerHeight;
    sizing = Object.assign({}, sizing, intrinsic, { allocatedHeight });
    if ($("pyramid-area").hidden) { sizing.diagramViewportHeight = 0; return; }
    const scroll = $("diagram-scroll");
    // Fit the allocated frame without changing the intrinsic height requested from its host.
    const available = Math.max(40, allocatedHeight - intrinsic.intrinsicHeaderHeight);
    const height = Math.min(manualHeight === null ? 380 : manualHeight, available);
    scroll.style.maxHeight = height + "px";
    scroll.style.height = manualHeight === null ? "" : height + "px";
    sizing.diagramViewportHeight = scroll.getBoundingClientRect().height;
    $("pyramid-resizer").setAttribute("aria-valuenow", String(manualHeight === null ? Math.max(64, Math.round(sizing.diagramViewportHeight)) : manualHeight));
    $("pyramid-resizer").setAttribute("aria-valuetext", Math.round(sizing.diagramViewportHeight) + " 像素" + (manualHeight === null ? "，自动高度" : ""));
  }
  function resize() {
    const intrinsic = intrinsicSizing();
    if (!intrinsic) return;
    const manual = manualHeight !== null && !$("pyramid-area").hidden;
    const height = manual ? Math.ceil(intrinsic.intrinsicHeaderHeight + manualHeight) : Math.min(500, Math.max(54, Math.ceil(intrinsic.intrinsicHeaderHeight + Math.min(intrinsic.naturalDiagramHeight, 380))));
    sizing = Object.assign({}, sizing, intrinsic, { requestedHeight: height, manualHeight });
    if (!bridge || !bridge.resizeTools || height === lastHeight && manual === lastManualMode) { fitViewport(); return; }
    lastHeight = height; lastManualMode = manual;
    try {
      const result = bridge.resizeTools(height, { manual });
      if (result && result.then) result.then(accepted => fitViewport(accepted)).catch(() => {});
      else fitViewport(result);
    } catch (_) { fitViewport(); }
  }
  function normalizeHeight(value) { return Number.isInteger(value) && value >= 64 && value <= 1600 ? value : null; }
  function setManualHeight(value) { manualHeight = value === null ? null : Math.max(64, Math.min(1600, Math.round(value))); resize(); }
  function persistHeight() {
    if (!bridge || !bridge.savePyramidHeight) return;
    try {
      const result = bridge.savePyramidHeight(manualHeight);
      if (result && result.catch) result.catch(() => status("显示高度未能保存，请重新调整。", true));
    } catch (_) { status("显示高度未能保存，请重新调整。", true); }
  }
  function endHeightDrag(save, restore) {
    if (!heightDrag) return;
    const drag = heightDrag; heightDrag = null;
    document.documentElement.classList.remove("resizing-pyramid");
    try { $("pyramid-resizer").releasePointerCapture(drag.pointerID); } catch (_) {}
    if (restore) setManualHeight(drag.originalHeight);
    else if (save && drag.moved && drag.generation === generation) persistHeight();
  }
  function initializeHeightControl() {
    const separator = $("pyramid-resizer");
    separator.addEventListener("pointerdown", event => {
      if (!state || event.button !== 0 || heightDrag) return;
      event.preventDefault(); separator.focus();
      heightDrag = { pointerID: event.pointerId, y: event.screenY, height: $("diagram-scroll").getBoundingClientRect().height, originalHeight: manualHeight, generation, moved: false };
      document.documentElement.classList.add("resizing-pyramid");
      try { separator.setPointerCapture(event.pointerId); } catch (_) {}
    });
    window.addEventListener("pointermove", event => {
      if (!heightDrag || event.pointerId !== heightDrag.pointerID) return;
      const delta = event.screenY - heightDrag.y;
      if (!heightDrag.moved && Math.abs(delta) < 2) return;
      heightDrag.moved = true; event.preventDefault(); setManualHeight(heightDrag.height + delta);
    });
    window.addEventListener("pointerup", event => { if (heightDrag && event.pointerId === heightDrag.pointerID) endHeightDrag(true, false); });
    window.addEventListener("pointercancel", event => { if (heightDrag && event.pointerId === heightDrag.pointerID) endHeightDrag(true, false); });
    window.addEventListener("blur", () => endHeightDrag(true, false));
    separator.addEventListener("dblclick", () => { endHeightDrag(false, false); setManualHeight(null); persistHeight(); });
    separator.addEventListener("keydown", event => {
      if (event.key === "Escape" && heightDrag) { event.preventDefault(); endHeightDrag(false, true); return; }
      if (event.key === "Home") { event.preventDefault(); setManualHeight(null); persistHeight(); return; }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const height = manualHeight === null ? $("diagram-scroll").getBoundingClientRect().height : manualHeight;
      setManualHeight(height + (event.key === "ArrowUp" ? -1 : 1) * (event.shiftKey ? 80 : 20)); persistHeight();
    });
  }
  function changed() {
    state.updatedAt = Date.now(); revision++;
    status("待保存");
    if (saveTimeout !== null) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { saveTimeout = null; flushPendingSave().catch(() => {}); }, 300);
  }
  async function flushPendingSave() {
    if (!state || !bridge) return;
    if (saveTimeout !== null) { clearTimeout(saveTimeout); saveTimeout = null; }
    if (saving) { await saving; return flushPendingSave(); }
    if (savedRevision >= revision) return;
    const capturedRevision = revision, captured = clone(state), currentBridge = bridge, capturedGeneration = generation;
    status("保存中…");
    const operation = Promise.resolve().then(() => (currentBridge.saveDraft || currentBridge.saveState).call(currentBridge, captured));
    saving = operation;
    try {
      const result = await operation;
      if (capturedGeneration === generation) {
        savedRevision = capturedRevision;
        const done = savedRevision >= revision ? result?.message || "已保存" : "待保存";
        status(Core.getTimerView(state.timers[state.phase]).expired ? (state.phase === "inspection" ? "10" : "20") + " 分钟到了 · " + done : done);
      }
    }
    catch (error) { if (capturedGeneration === generation) status("保存失败，点击重试；可通过 … 导出备份。", true); throw error; }
    finally { if (saving === operation) saving = null; }
    if (capturedGeneration === generation && savedRevision < revision) return flushPendingSave();
  }
  function toggle(id, buttonID) {
    const target = $(id); target.hidden = !target.hidden;
    if (id === "pyramid-area" && !target.hidden) $("diagram-scroll").style.maxHeight = "380px";
    $(buttonID).setAttribute("aria-expanded", String(!target.hidden)); resize();
  }
  function start(phase) {
    if (!state || syncBlocked) return;
    const view = Core.getTimerView(state.timers[phase]);
    if (view.status === "expired" || view.status === "completed") Core.resetTimer(state, phase);
    Core.startTimer(state, phase); expired.delete(phase); changed(); updateTimer();
  }
  function updateTimer() {
    if (!state) return;
    for (const phase of ["inspection", "analysis"]) {
      const timer = state.timers[phase], view = Core.getTimerView(timer);
      if (timer.status === "running" && view.expired) {
        timer.status = "expired"; timer.remainingMs = 0; timer.deadline = null; if (!syncBlocked) changed();
      }
      if (view.expired && !expired.has(phase)) { expired.add(phase); status((phase === "inspection" ? "10" : "20") + " 分钟到了"); }
    }
    const view = Core.getTimerView(state.timers[state.phase]);
    $("timer-time").textContent = view.display;
    $("timer-time").className = "time" + (view.expired ? " expired" : "");
    $("timer-time").title = (state.phase === "inspection" ? "检视阅读" : "分析阅读") + " · " + ({ idle: "未开始", running: "进行中", paused: "已暂停", expired: "时间到了", completed: "已完成" }[view.status] || "");
    $("timer-pause").disabled = syncBlocked || view.status !== "running" && view.status !== "paused";
    $("start-inspection").disabled = syncBlocked; $("start-analysis").disabled = syncBlocked; $("timer-reset").disabled = syncBlocked;
    $("timer-pause").textContent = view.status === "paused" ? "继续" : "暂停";
    $("start-inspection").className = "start" + (state.phase === "inspection" && view.status === "running" ? " active" : "");
    $("start-analysis").className = "start" + (state.phase === "analysis" && view.status === "running" ? " active" : "");
  }
  function findParent(id, node = state.pyramid) {
    if (node.children.some(child => child.id === id)) return node;
    for (const child of node.children) { const parent = findParent(id, child); if (parent) return parent; }
    return null;
  }
  function nodeDepth(id, node = state.pyramid, depth = 0) {
    if (node.id === id) return depth;
    for (const child of node.children) { const found = nodeDepth(id, child, depth + 1); if (found !== -1) return found; }
    return -1;
  }
  function selectedNode() { return state && Core.findNode(state.pyramid, selectedID) || state && state.pyramid; }
  function selectNode(id) {
    if (selectedID !== id) boldSelection = null;
    selectedID = id;
    document.querySelectorAll("[data-node-id]").forEach(card => card.classList.toggle("selected", card.getAttribute("data-node-id") === id));
    updateNodeControls();
  }
  function updateNodeControls() {
    updateFontSizeControl();
    if (!state) return;
    const node = selectedNode(), parent = findParent(node.id), index = parent ? parent.children.indexOf(node) : -1;
    $("selected-label").textContent = parent ? ({ thesis: "主题", argument: "论点", evidence: "理由" }[node.type]) : "顶层";
    $("node-child").disabled = readOnly || nodeDepth(node.id) >= Core.MAX_DEPTH;
    $("node-sibling").disabled = readOnly || !parent;
    $("node-delete").disabled = readOnly || !parent;
    $("node-up").disabled = readOnly || !parent || index <= 0;
    $("node-down").disabled = readOnly || !parent || index >= parent.children.length - 1;
    $("insert-pyramid").disabled = readOnly || actionBusy || !bridge || typeof bridge.insertPyramid !== "function";
    updateBoldControl();
  }
  function updateFontSizeControl() {
    const size = Core.normalizePyramidFontSize(state && state.pyramidFontSize);
    $("pyramid-font-size").value = String(size);
    $("pyramid-font-size").disabled = !state || readOnly || syncBlocked || actionBusy;
    $("diagram").style.setProperty("--pyramid-font-size", size + "px");
  }
  function selectionInEditor() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const editor = element && element.closest(".node-text");
    if (!editor || !editor.isConnected || editor.getAttribute("contenteditable") !== "true" || !editor.contains(range.endContainer)) return null;
    return { editor, range: range.cloneRange() };
  }
  function updateBoldControl() {
    const valid = boldSelection && boldSelection.editor.isConnected && boldSelection.editor.getAttribute("contenteditable") === "true";
    $("node-bold").disabled = readOnly || !valid;
    let pressed = false;
    if (valid) { try { pressed = document.queryCommandState("bold"); } catch (_) {} }
    $("node-bold").setAttribute("aria-pressed", String(pressed));
  }
  function rememberSelection() { boldSelection = selectionInEditor(); updateBoldControl(); }
  function editorContents(editor) {
    let text = "";
    const ranges = [];
    function append(value, bold) {
      if (!value) return;
      const start = text.length; text += value;
      if (bold) ranges.push({ start, end: text.length });
    }
    function walk(parent, inherited) {
      const children = Array.from(parent.childNodes);
      children.forEach((child, index) => {
        if (child.nodeType === 3) { append(child.nodeValue, inherited); return; }
        if (child.nodeType !== 1) return;
        const name = child.localName.toLowerCase();
        if (name === "br") {
          // Browsers use a lone final BR as an empty editing-line placeholder.
          if (children.length === 1 && !text || index === children.length - 1 && text.endsWith("\n")) return;
          append("\n", inherited); return;
        }
        let bold = inherited;
        if (name === "b" || name === "strong") bold = true;
        const weight = child.style && child.style.fontWeight;
        if (weight) bold = weight === "bold" || weight === "bolder" || Number(weight) >= 600;
        const block = name === "div" || name === "p";
        if (block && text && !text.endsWith("\n")) append("\n", inherited);
        walk(child, bold);
        const emptyLine = block && child.childNodes.length === 1 && child.firstChild.nodeType === 1 && child.firstChild.localName.toLowerCase() === "br";
        if (block && index < children.length - 1 && (emptyLine || !text.endsWith("\n"))) append("\n", inherited);
      });
    }
    walk(editor, false);
    return { text, boldRanges: Core.normalizeBoldRanges(ranges, text) };
  }
  function paintEditor(editor, node) {
    editor.replaceChildren();
    Core.getTextRuns(node.text, node.boldRanges).forEach(run => {
      const text = document.createTextNode(run.text);
      if (run.bold) { const strong = el("strong"); strong.appendChild(text); editor.appendChild(strong); }
      else editor.appendChild(text);
    });
  }
  function syncEditor(editor, node, composing) {
    const value = editorContents(editor), limit = node === state.pyramid ? Core.MAX_ROOT_TEXT : 20000;
    if (!composing && value.text.length > limit) {
      value.text = value.text.slice(0, limit);
      if (/[\uD800-\uDBFF]$/.test(value.text)) value.text = value.text.slice(0, -1);
      value.boldRanges = Core.normalizeBoldRanges(value.boldRanges, value.text);
      const selection = window.getSelection();
      paintEditor(editor, value);
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      selection.removeAllRanges(); selection.addRange(range);
    }
    if (node.text !== value.text || JSON.stringify(node.boldRanges || []) !== JSON.stringify(value.boldRanges)) {
      node.text = value.text;
      if (value.boldRanges.length) node.boldRanges = value.boldRanges; else delete node.boldRanges;
      changed();
    }
    rememberSelection(); resize();
  }
  function applyBold() {
    const current = selectionInEditor();
    if (!current) { boldSelection = null; updateBoldControl(); return; }
    boldSelection = current;
    if (readOnly || !state || !boldSelection || !boldSelection.editor.isConnected) return;
    const { editor, range } = boldSelection, card = editor.closest("[data-node-id]");
    const node = Core.findNode(state.pyramid, card.getAttribute("data-node-id"));
    if (!node || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
    editor.focus();
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.execCommand("bold", false, null);
    syncEditor(editor, node, false);
  }
  function richArea(parent, node, root) {
    const input = el("div", "node-text");
    input.setAttribute("contenteditable", String(!readOnly)); input.setAttribute("role", "textbox");
    input.setAttribute("aria-multiline", "true"); input.setAttribute("aria-disabled", String(readOnly));
    input.setAttribute("aria-label", root ? "疑问／回答" : "节点内容");
    input.setAttribute("data-placeholder", root ? "疑问与回答，可分行填写。" : "论点或理由，写成一句完整的话。");
    paintEditor(input, node);
    input.addEventListener("input", event => syncEditor(input, node, event.isComposing));
    input.addEventListener("compositionend", () => syncEditor(input, node, false));
    input.addEventListener("keydown", event => {
      if (readOnly || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") { event.preventDefault(); rememberSelection(); applyBold(); }
      else if ((event.ctrlKey || event.metaKey) && ["i", "u"].includes(event.key.toLowerCase())) event.preventDefault();
      else if (event.key === "Enter") { event.preventDefault(); document.execCommand("insertText", false, "\n"); syncEditor(input, node, false); }
    });
    input.addEventListener("paste", event => {
      event.preventDefault(); if (readOnly || !event.clipboardData) return;
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); syncEditor(input, node, false);
    });
    input.addEventListener("drop", event => event.preventDefault());
    input.addEventListener("mouseup", rememberSelection);
    input.addEventListener("keyup", rememberSelection);
    parent.appendChild(input); return input;
  }
  function editArea(parent, value, placeholder, label, setter, className) {
    const input = el("textarea", className || ""); input.value = value || ""; input.placeholder = placeholder; input.rows = 2; input.maxLength = 20000;
    input.disabled = readOnly; input.setAttribute("aria-label", label);
    input.addEventListener("input", () => { setter(input.value); changed(); });
    parent.appendChild(input); return input;
  }
  function nodeCard(node, root) {
    const card = el("div", "node" + (node.id === selectedID ? " selected" : "")); card.setAttribute("data-node-id", node.id); card.tabIndex = 0;
    card.setAttribute("aria-label", root ? "疑问／回答" : "金字塔节点");
    card.addEventListener("click", () => selectNode(node.id));
    card.addEventListener("focusin", () => selectNode(node.id));
    const heading = el("div", "node-heading");
    if (root) heading.textContent = "疑问／回答";
    else {
      const kind = el("select"); kind.disabled = readOnly; kind.setAttribute("aria-label", "节点类别");
      [["argument", "论点"], ["evidence", "理由"], ["thesis", "主题"]].forEach(([value, name]) => { const option = el("option", "", name); option.value = value; kind.appendChild(option); });
      kind.value = node.type; kind.addEventListener("change", () => { node.type = kind.value; changed(); updateNodeControls(); }); heading.appendChild(kind);
    }
    card.appendChild(heading);
    richArea(card, node, root);
    return card;
  }
  function branch(node) {
    const wrap = el("div", "branch"); wrap.appendChild(nodeCard(node, false));
    if (node.children.length) { const children = el("div", "nested-children"); node.children.forEach(child => children.appendChild(branch(child))); wrap.appendChild(children); }
    return wrap;
  }
  function renderDiagram(focusID) {
    boldSelection = null;
    const target = $("diagram"); target.replaceChildren();
    const root = el("div", "root-wrap" + (framingVisible ? " has-framing" : ""));
    if (framingVisible) {
      const framing = el("aside", "framing-note"); framing.id = "framing-note"; framing.setAttribute("aria-label", "主题注释");
      [["situation", "背景"], ["complication", "冲突"]].forEach(([key, label]) => {
        const field = el("label", "framing-field"); field.appendChild(el("span", "", label));
        const input = editArea(field, state.framing[key], "", label, value => { state.framing[key] = value; });
        input.id = "framing-" + key; input.addEventListener("focus", () => { boldSelection = null; updateBoldControl(); });
        framing.appendChild(field);
      });
      root.appendChild(framing);
    }
    root.appendChild(nodeCard(state.pyramid, true));
    if (framingVisible) root.appendChild(el("div", "framing-spacer"));
    $("framing-toggle").setAttribute("aria-expanded", String(framingVisible)); target.appendChild(root);
    if (state.pyramid.children.length) { const children = el("div", "top-children"); state.pyramid.children.forEach(child => children.appendChild(branch(child))); target.appendChild(children); }
    updateNodeControls(); resize();
    if (focusID) {
      const card = Array.from(document.querySelectorAll("[data-node-id]")).find(value => value.getAttribute("data-node-id") === focusID);
      if (card) { const input = card.querySelector(".node-text"); input.focus(); input.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    }
  }
  function renderChecks() {
    $("inspection-checks").replaceChildren();
    checkLabels.forEach((label, index) => {
      const wrapper = el("label"), input = el("input"); input.type = "checkbox"; input.checked = !!state.inspection.checklist[index]; input.disabled = readOnly;
      input.addEventListener("change", () => { state.inspection.checklist[index] = input.checked; changed(); });
      wrapper.appendChild(input); wrapper.appendChild(el("span", "", label)); $("inspection-checks").appendChild(wrapper);
    });
    $("inspection-completed").checked = !!state.inspection.completed;
    $("inspection-completed").disabled = readOnly;
  }
  async function pngImage(capturedState) {
    if (!Core.renderPyramidSVG) throw new Error("金字塔图片模块不可用，请重新启用插件。");
    const svg = Core.renderPyramidSVG(capturedState);
    const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = el("img");
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("无法生成金字塔图片。")); img.src = source; });
      const originalWidth = img.naturalWidth || 600, originalHeight = img.naturalHeight || 300;
      const scale = Math.min(1, 4096 / originalWidth, 4096 / originalHeight, Math.sqrt(8000000 / (originalWidth * originalHeight)));
      // Round down so a size-limited image cannot exceed the bridge's pixel cap.
      const width = Math.max(1, Math.floor(originalWidth * scale)), height = Math.max(1, Math.floor(originalHeight * scale));
      const canvas = el("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); ctx.drawImage(img, 0, 0, width, height);
      return { pngDataURL: canvas.toDataURL("image/png"), width, height };
    } finally { URL.revokeObjectURL(source); }
  }
  async function perform(action) {
    if (actionBusy) return; actionBusy = true; updateNodeControls();
    const currentGeneration = generation;
    try { await action(); } catch (error) { if (currentGeneration === generation) status(error.message || String(error), true); }
    finally { actionBusy = false; updateNodeControls(); resize(); }
  }
  function download(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
    const anchor = el("a"); anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function demoConfig() {
    const demoItem = { libraryID: 1, key: "DEMO0001", title: "工具预览" }, key = "reading-flow-tools-v2-demo";
    let stored = null; try { stored = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) {}
    let pyramidHeight = null; try { pyramidHeight = normalizeHeight(JSON.parse(localStorage.getItem("reading-flow-pyramid-height") || "null")); } catch (_) {}
    return { item: demoItem, initialState: stored, demo: true, pyramidHeight, bridge: {
      savePyramidHeight(value) { localStorage.setItem("reading-flow-pyramid-height", JSON.stringify(value)); return value; },
      saveDraft: async value => localStorage.setItem(key, JSON.stringify(value)),
      flushState: value => localStorage.setItem(key, JSON.stringify(value)),
      exportJSON: async value => { download("reading-tools.json", JSON.stringify(value, null, 2)); return { message: "已导出备份" }; },
      importJSON: async () => new Promise((resolve, reject) => {
        const input = el("input"); input.type = "file"; input.accept = ".json,application/json"; input.hidden = true; document.body.appendChild(input);
        input.addEventListener("change", async () => { try { resolve(input.files[0] ? JSON.parse(await input.files[0].text()) : null); } catch (error) { reject(error); } finally { input.remove(); } }, { once: true });
        input.addEventListener("cancel", () => { input.remove(); resolve(null); }, { once: true }); input.click();
      })
    } };
  }
  async function applyConfig(config) {
    if (!config || !config.item || !config.bridge) return;
    const incoming = config.initialState ? Core.normalizeSession(config.initialState, config.item) : Core.createSession(config.item);
    if (saveTimeout !== null) { clearTimeout(saveTimeout); saveTimeout = null; }
    endHeightDrag(false, false); generation++;
    manualHeight = normalizeHeight(config.pyramidHeight); lastManualMode = null;
    item = config.item; bridge = config.bridge; readOnly = !!config.readOnly || bridge.canEdit === false; demo = !!config.demo;
    syncBlocked = !!config.syncConflict || !!config.syncPending;
    syncVersions = (config.syncVersions || []).map(version => ({ ...version, state: Core.normalizeSession(version.state, item) }));
    state = incoming;
    framingVisible = !!(state.framing.situation || state.framing.complication);
    revision = 0; savedRevision = 0; saving = null; selectedID = state.pyramid.id; expired.clear(); lastHeight = 0;
    $("mode-label").textContent = config.syncConflict ? "选择同步版本" : config.syncPending ? "等待同步" : readOnly ? "只读" : demo ? "工具预览" : "";
    $("sync-area").hidden = !config.syncConflict || !syncVersions.length;
    $("sync-version").replaceChildren(...syncVersions.map(version => { const option = el("option"); option.value = version.id; option.textContent = version.label; return option; }));
    if (config.selectedSyncVersion) $("sync-version").value = config.selectedSyncVersion;
    $("sync-use").disabled = config.syncCanResolve === false || !!config.syncPending || typeof bridge.resolveSyncVersion !== "function";
    $("more-toggle").hidden = typeof bridge.exportJSON !== "function" && typeof bridge.importJSON !== "function";
    $("backup-export").hidden = typeof bridge.exportJSON !== "function";
    $("backup-import").hidden = typeof bridge.importJSON !== "function";
    $("backup-import").disabled = readOnly;
    renderChecks(); renderDiagram(); status(config.syncConflict ? "检测到不同版本，请预览后选择；双方内容均已保留。" : config.syncPending ? "金字塔尚未同步完整，当前内容已保留。" : readOnly ? "当前文献库只读" : ""); updateTimer(); resize();
  }
  function loadConfig(config) {
    configQueue = configQueue.catch(() => {}).then(() => applyConfig(config));
    configQueue.catch(error => status(error.message || String(error), true));
    return configQueue;
  }
  function initialize() {
    Core = window.ReadingFlowCore;
    if (!Core) { status("阅读工具未能载入", true); return; }
    window.ReadingFlowApp = { flushPendingSave, hasPendingChanges: () => !!saving || savedRevision < revision, getState: () => state ? clone(state) : null, getSizing: () => clone(sizing), loadConfig, showNotice: message => status(message, true) };
    $("sync-version").addEventListener("change", () => {
      const version = syncVersions.find(version => version.id === $("sync-version").value); if (!version || !syncBlocked) return;
      state = clone(version.state); selectedID = state.pyramid.id; framingVisible = !!(state.framing.situation || state.framing.complication);
      renderChecks(); renderDiagram(); updateTimer(); resize(); status("正在预览所选版本；点击“采用此版本”后继续编辑。");
    });
    $("sync-use").addEventListener("click", () => perform(async () => {
      if (!bridge?.resolveSyncVersion) return;
      const result = await bridge.resolveSyncVersion($("sync-version").value); status(result?.message || "已采用所选版本");
    }));
    initializeHeightControl();
    $("start-inspection").addEventListener("click", () => start("inspection"));
    $("start-analysis").addEventListener("click", () => start("analysis"));
    $("timer-pause").addEventListener("click", () => { if (!state || syncBlocked) return; if (Core.getTimerView(state.timers[state.phase]).status === "running") { Core.pauseTimer(state); changed(); updateTimer(); } else start(state.phase); });
    $("timer-reset").addEventListener("click", () => { if (!state || syncBlocked) return; Core.resetTimer(state, state.phase); expired.delete(state.phase); changed(); updateTimer(); });
    $("checklist-toggle").addEventListener("click", () => toggle("checklist-area", "checklist-toggle"));
    $("pyramid-toggle").addEventListener("click", () => toggle("pyramid-area", "pyramid-toggle"));
    $("more-toggle").addEventListener("click", () => toggle("more-area", "more-toggle"));
    $("framing-toggle").addEventListener("click", () => {
      if (!state) return;
      framingVisible = !framingVisible; renderDiagram();
      if (framingVisible) $("framing-note").scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    $("node-bold").addEventListener("mousedown", event => event.preventDefault());
    $("node-bold").addEventListener("click", applyBold);
    Core.PYRAMID_FONT_SIZES.forEach(size => {
      const option = el("option", "", String(size)); option.value = String(size); $("pyramid-font-size").appendChild(option);
    });
    updateFontSizeControl();
    $("pyramid-font-size").addEventListener("change", () => {
      if (!state || readOnly || syncBlocked || actionBusy) { updateFontSizeControl(); return; }
      const size = Core.normalizePyramidFontSize(Number($("pyramid-font-size").value));
      if (size === state.pyramidFontSize) return;
      state.pyramidFontSize = size;
      // Keep the existing editing DOM, text selection and partial bold ranges intact.
      updateFontSizeControl(); changed(); resize();
    });
    document.addEventListener("selectionchange", rememberSelection);
    $("inspection-completed").addEventListener("change", () => { if (!state || readOnly) return; state.inspection.completed = $("inspection-completed").checked; if (state.inspection.completed && state.phase === "inspection") Core.completePhase(state); changed(); updateTimer(); });
    $("node-child").addEventListener("click", () => { if (!state || readOnly) return; try { const node = selectedNode(), child = Core.addNode(state, node.id, node.type === "thesis" ? "argument" : "evidence"); selectedID = child.id; changed(); renderDiagram(child.id); } catch (error) { status(error.message, true); } });
    $("node-sibling").addEventListener("click", () => { if (!state || readOnly) return; const node = selectedNode(), parent = findParent(node.id); if (!parent) return; try { const sibling = Core.addNode(state, parent.id, node.type), index = parent.children.indexOf(node); parent.children.splice(parent.children.indexOf(sibling), 1); parent.children.splice(index + 1, 0, sibling); selectedID = sibling.id; changed(); renderDiagram(sibling.id); } catch (error) { status(error.message, true); } });
    $("node-delete").addEventListener("click", () => { if (!state || readOnly) return; const node = selectedNode(), parent = findParent(node.id); if (!parent) return; if ((node.text || node.children.length) && !window.confirm(node.children.length ? "删除这个节点及其下层？" : "删除这个节点？")) return; Core.removeNode(state, node.id); selectedID = parent.id; changed(); renderDiagram(parent.id); });
    ["up", "down"].forEach(direction => $("node-" + direction).addEventListener("click", () => { if (!state || readOnly) return; Core.moveNode(state, selectedID, direction); changed(); renderDiagram(selectedID); }));
    $("insert-pyramid").addEventListener("click", () => perform(async () => {
      if (!state || readOnly || !bridge.insertPyramid) return;
      const currentBridge = bridge, currentGeneration = generation, capturedState = clone(state);
      await flushPendingSave();
      if (currentGeneration !== generation) return;
      const image = await pngImage(capturedState);
      if (currentGeneration !== generation) return;
      const result = await currentBridge.insertPyramid(image);
      if (currentGeneration === generation) status(result && result.message || "金字塔已插入笔记");
    }));
    $("backup-export").addEventListener("click", () => perform(async () => {
      if (!state || !bridge.exportJSON) return;
      const currentBridge = bridge, currentGeneration = generation, capturedState = clone(state);
      let failed = false; try { await flushPendingSave(); } catch (_) { failed = true; }
      if (currentGeneration !== generation) return;
      const result = await currentBridge.exportJSON(capturedState);
      if (currentGeneration !== generation) return;
      if (result === null || result && result.cancelled) { status(failed ? "已取消导出；本机记录仍未保存" : "已取消导出", failed); return; }
      status(failed ? "已导出备份；本机记录仍未保存" : result && result.message || "已导出备份", failed);
    }));
    $("backup-import").addEventListener("click", () => perform(async () => {
      if (!state || readOnly || !bridge.importJSON) return;
      const currentBridge = bridge, currentGeneration = generation, capturedItem = clone(item);
      await flushPendingSave();
      if (currentGeneration !== generation) return;
      const imported = await currentBridge.importJSON();
      if (!imported || currentGeneration !== generation) return;
      const incoming = Core.normalizeSession(imported, capturedItem);
      if (!window.confirm("用备份替换当前文献的工具记录？")) return;
      if (state.noteKey) incoming.noteKey = state.noteKey;
      state = incoming; framingVisible = !!(state.framing.situation || state.framing.complication); selectedID = state.pyramid.id; expired.clear(); changed(); renderChecks(); renderDiagram(); updateTimer(); await flushPendingSave();
      if (currentGeneration === generation) status("已导入备份");
    }));
    $("status").tabIndex = 0; $("status").title = "点击立即保存或重试";
    $("status").addEventListener("click", () => flushPendingSave().catch(() => {}));
    $("status").addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); flushPendingSave().catch(() => {}); } });
    window.addEventListener("reading-flow-config", event => loadConfig(event.detail || window.ReadingFlowConfig));
    window.addEventListener("resize", () => fitViewport());
    window.addEventListener("beforeunload", () => { if (!state || !bridge || syncBlocked || savedRevision >= revision) return; try { const result = (bridge.flushState || bridge.saveDraft || bridge.saveState).call(bridge, clone(state)); if (result && result.catch) result.catch(() => {}); } catch (_) {} });
    if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(resize); observer.observe($("tools")); observer.observe($("diagram")); }
    setInterval(updateTimer, 400);
    const config = window.ReadingFlowConfig || window.arguments && window.arguments[0];
    if (config) loadConfig(config.wrappedJSObject || config);
    else if (location.protocol !== "chrome:" && location.protocol !== "resource:") loadConfig(demoConfig());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true }); else initialize();
})();
