(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReadingFlowCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = 1;
  const DURATIONS = { inspection: 10 * 60 * 1000, analysis: 20 * 60 * 1000 };
  const TYPES = ["thesis", "argument", "evidence"];
  const MAX_NODES = 300;
  const MAX_DEPTH = 8;
  const MAX_TEXT = 20000;
  const MAX_ROOT_TEXT = MAX_TEXT * 2 + 2;

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }
  function text(value, limit = MAX_TEXT) {
    if (typeof value !== "string") return "";
    let end = Math.min(value.length, limit);
    if (end < value.length && isSurrogateBoundary(value, end)) end--;
    return value.slice(0, end);
  }
  function isSurrogateBoundary(value, offset) {
    return offset > 0 && offset < value.length &&
      value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff &&
      value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
  }
  // UTF-16 offsets keep the text a plain string while formatting stays separate.
  // Imported spans cannot split a Unicode code point or grow without a bound.
  function normalizeBoldRanges(ranges, value) {
    const content = typeof value === "string" ? value : "";
    if (!Array.isArray(ranges) || !content.length) return [];
    const valid = [];
    const limit = Math.min(ranges.length, MAX_ROOT_TEXT);
    for (let i = 0; i < limit; i++) {
      const range = ranges[i];
      if (!range || typeof range !== "object" || Array.isArray(range) ||
          !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start >= range.end) continue;
      let start = Math.max(0, Math.min(content.length, range.start));
      let end = Math.max(0, Math.min(content.length, range.end));
      if (start >= end) continue;
      if (isSurrogateBoundary(content, start)) start--;
      if (isSurrogateBoundary(content, end)) end++;
      valid.push({ start, end });
    }
    valid.sort((a, b) => a.start - b.start || a.end - b.end);
    const result = [];
    for (const range of valid) {
      const previous = result[result.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else result.push(range);
    }
    return result;
  }
  function getTextRuns(value, ranges) {
    const content = typeof value === "string" ? value : "";
    if (!content) return [];
    const runs = [];
    let offset = 0;
    for (const range of normalizeBoldRanges(ranges, content)) {
      if (range.start > offset) runs.push({ text: content.slice(offset, range.start), bold: false });
      runs.push({ text: content.slice(range.start, range.end), bold: true });
      offset = range.end;
    }
    if (offset < content.length) runs.push({ text: content.slice(offset), bold: false });
    return runs;
  }
  function enumValue(value, values, fallback) { return values.includes(value) ? value : fallback; }
  function bools(raw, fields) {
    const result = {};
    for (const key of fields) result[key] = !!(raw && raw[key] === true);
    return result;
  }
  function itemIdentity(item) {
    if (!item || !Number.isInteger(item.libraryID) || item.libraryID < 0 ||
        typeof item.key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.key)) {
      throw new Error("文献标识无效，请从 Zotero 文献条目打开阅读台。");
    }
    return { libraryID: item.libraryID, key: item.key, title: text(item.title) || "未命名文献" };
  }
  function newTimer(durationMs) {
    return { durationMs, remainingMs: durationMs, status: "idle", deadline: null };
  }
  function newNode(type = "argument") {
    return { id: uid(), type, text: "", source: "", question: "", logic: "inductive", order: "structure", children: [] };
  }
  function createSession(item, now = Date.now()) {
    const pyramid = newNode("thesis");
    pyramid.id = "root";
    return {
      schemaVersion: VERSION, item: itemIdentity(item), phase: "inspection",
      timers: { inspection: newTimer(DURATIONS.inspection), analysis: newTimer(DURATIONS.analysis) },
      inspection: { question: "", structure: "", checklist: [false, false, false, false, false, false], completed: false, classified: false, legacyChecklist: [] },
      noteKey: null,
      terms: [], pyramid,
      framing: { situation: "", complication: "", question: "" },
      checks: { summary: false, sameKind: false, order: false, coverage: false },
      reflection: { unresolved: "", nextStep: "" },
      createdAt: now, updatedAt: now, completedAt: null
    };
  }

  function getTimerView(timer, now = Date.now()) {
    let remainingMs = timer.status === "running" ? Math.max(0, timer.deadline - now) : timer.remainingMs;
    remainingMs = Math.max(0, Math.min(timer.durationMs, remainingMs));
    const expired = timer.status === "expired" || (timer.status === "running" && remainingMs === 0);
    const status = expired ? "expired" : timer.status;
    const seconds = Math.ceil(remainingMs / 1000);
    return { remainingMs, status, expired, display: String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0") };
  }
  function normalizeTimer(raw, phase, now) {
    const durationMs = DURATIONS[phase];
    if (!raw || typeof raw !== "object") return newTimer(durationMs);
    const timer = {
      durationMs,
      remainingMs: Number.isFinite(raw.remainingMs) ? Math.max(0, Math.min(durationMs, raw.remainingMs)) : durationMs,
      status: enumValue(raw.status, ["idle", "running", "paused", "expired", "completed"], "idle"),
      deadline: null
    };
    if (timer.status === "running") {
      if (!Number.isFinite(raw.deadline) || raw.deadline < 0) throw new Error("倒计时数据损坏；请保留备份后重新开始。");
      timer.deadline = Math.min(raw.deadline, now + durationMs);
      if (timer.deadline <= now) { timer.remainingMs = 0; timer.status = "expired"; timer.deadline = null; }
    }
    if (timer.status === "expired") timer.remainingMs = 0;
    return timer;
  }

  function normalizeSession(raw, item, now = Date.now()) {
    if (!raw || raw.schemaVersion !== VERSION) throw new Error("备份格式不受支持，当前需要 Reading Flow v1 数据。");
    const identity = itemIdentity(item || raw.item);
    const incoming = itemIdentity(raw.item);
    if (identity.libraryID !== incoming.libraryID || identity.key !== incoming.key) {
      throw new Error("这份备份属于另一篇文献，请在对应文献的阅读台导入。");
    }
    let count = 0;
    const ids = new Set();
    const ancestors = new Set();
    function node(rawNode, depth) {
      if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) throw new Error("金字塔节点格式无效。");
      if (depth > MAX_DEPTH || ++count > MAX_NODES) throw new Error("金字塔过大：最多 300 个节点、9 层。");
      if (ancestors.has(rawNode)) throw new Error("金字塔存在循环引用。");
      ancestors.add(rawNode);
      let id = depth === 0 ? "root" : text(rawNode.id);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || ids.has(id)) id = uid();
      ids.add(id);
      if (rawNode.children !== undefined && !Array.isArray(rawNode.children)) throw new Error("子节点必须是列表。");
      const result = {
        id, type: depth === 0 ? "thesis" : enumValue(rawNode.type, TYPES, "argument"),
        text: text(rawNode.text, depth === 0 ? MAX_ROOT_TEXT : MAX_TEXT), source: text(rawNode.source), question: text(rawNode.question),
        logic: enumValue(rawNode.logic, ["inductive", "deductive"], "inductive"),
        order: enumValue(rawNode.order, ["structure", "time", "importance"], "structure"),
        children: (rawNode.children || []).map(child => node(child, depth + 1))
      };
      const boldRanges = normalizeBoldRanges(rawNode.boldRanges, result.text);
      if (boldRanges.length) result.boldRanges = boldRanges;
      ancestors.delete(rawNode);
      return result;
    }
    const base = createSession(identity, now);
    base.phase = enumValue(raw.phase, ["inspection", "analysis"], "inspection");
    base.timers.inspection = normalizeTimer(raw.timers && raw.timers.inspection, "inspection", now);
    base.timers.analysis = normalizeTimer(raw.timers && raw.timers.analysis, "analysis", now);
    const inactive = base.phase === "inspection" ? "analysis" : "inspection";
    if (base.timers[inactive].status === "running") {
      base.timers[inactive].remainingMs = getTimerView(base.timers[inactive], now).remainingMs;
      base.timers[inactive].status = "paused";
      base.timers[inactive].deadline = null;
    }
    const oldChecks = raw.inspection && raw.inspection.checklist || [];
    const legacyChecks = oldChecks.length === 5 ? oldChecks : raw.inspection && raw.inspection.legacyChecklist || [];
    const newChecks = oldChecks.length === 5 ? [oldChecks[0], oldChecks[1], oldChecks[0], false, oldChecks[2], false] : oldChecks;
    base.inspection = {
      question: text(raw.inspection && raw.inspection.question),
      structure: text(raw.inspection && raw.inspection.structure),
      checklist: Array.from({ length: 6 }, (_, i) => newChecks[i] === true),
      completed: !!(raw.inspection && raw.inspection.completed === true),
      classified: !!(raw.inspection && raw.inspection.classified === true),
      legacyChecklist: legacyChecks.length === 5 ? Array.from({ length: 5 }, (_, i) => legacyChecks[i] === true) : []
    };
    // This is only a reference. Integration checks the bound note's library,
    // parent and deleted state; tags are used only to find fallback candidates.
    base.noteKey = typeof raw.noteKey === "string" && /^[A-Z0-9]{8}$/.test(raw.noteKey) ? raw.noteKey : null;
    if (raw.terms !== undefined && !Array.isArray(raw.terms)) throw new Error("术语数据必须是列表。");
    if ((raw.terms || []).length > 300) throw new Error("术语数量超过 300 条。");
    base.terms = (raw.terms || []).map(t => ({
      id: uid(), term: text(t && t.term), meaning: text(t && t.meaning), source: text(t && t.source), uncertain: !!(t && t.uncertain === true)
    }));
    base.pyramid = node(raw.pyramid || base.pyramid, 0);
    base.pyramid.id = "root";
    base.framing = { situation: text(raw.framing && raw.framing.situation), complication: text(raw.framing && raw.framing.complication), question: text(raw.framing && raw.framing.question) };
    // The former question and answer fields now share one root text area. Clearing
    // the consumed field makes repeated normalization and reopening idempotent.
    if (base.framing.question) {
      const prefix = base.framing.question + (base.pyramid.text ? "\n\n" : "");
      const merged = prefix + base.pyramid.text;
      if (merged.length > MAX_ROOT_TEXT) throw new Error("旧版顶层内容合并后超过长度上限，请保留备份并缩短内容后重试。");
      base.pyramid.text = merged;
      if (base.pyramid.boldRanges) base.pyramid.boldRanges = base.pyramid.boldRanges.map(range => ({ start: range.start + prefix.length, end: range.end + prefix.length }));
      base.framing.question = "";
    }
    base.checks = bools(raw.checks, ["summary", "sameKind", "order", "coverage"]);
    base.reflection = { unresolved: text(raw.reflection && raw.reflection.unresolved), nextStep: text(raw.reflection && raw.reflection.nextStep) };
    base.createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now;
    base.updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now;
    base.completedAt = Number.isFinite(raw.completedAt) && raw.completedAt > 0 ? raw.completedAt : null;
    return base;
  }
  function touch(session, now) { session.updatedAt = now; return session; }
  function settleTimer(timer, now) {
    const view = getTimerView(timer, now);
    timer.remainingMs = view.remainingMs;
    if (view.expired) { timer.status = "expired"; timer.deadline = null; }
    return view;
  }
  function startTimer(session, phase = session.phase, now = Date.now()) {
    if (!(phase in DURATIONS)) throw new Error("阅读阶段无效。");
    const other = phase === "inspection" ? "analysis" : "inspection";
    if (session.timers[other].status === "running") {
      settleTimer(session.timers[other], now);
      if (session.timers[other].status === "running") session.timers[other].status = "paused";
      session.timers[other].deadline = null;
    }
    session.phase = phase;
    const timer = session.timers[phase];
    const view = settleTimer(timer, now);
    if (view.expired || timer.status === "completed") return touch(session, now);
    if (timer.status !== "running") {
      timer.status = "running";
      timer.deadline = now + timer.remainingMs;
    }
    session.completedAt = null;
    return touch(session, now);
  }
  function pauseTimer(session, now = Date.now()) {
    const timer = session.timers[session.phase];
    settleTimer(timer, now);
    if (timer.status === "running") timer.status = "paused";
    timer.deadline = null;
    return touch(session, now);
  }
  function resetTimer(session, phase = session.phase, now = Date.now()) {
    if (!(phase in DURATIONS)) throw new Error("阅读阶段无效。");
    session.timers[phase] = newTimer(DURATIONS[phase]);
    session.completedAt = null;
    return touch(session, now);
  }
  function completePhase(session, now = Date.now()) {
    const timer = session.timers[session.phase];
    settleTimer(timer, now);
    timer.status = "completed";
    timer.deadline = null;
    if (session.phase === "analysis") session.completedAt = now;
    return touch(session, now);
  }
  function findNode(tree, id) {
    if (tree.id === id) return tree;
    for (const child of tree.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
    return null;
  }
  function addTerm(session) {
    if (session.terms.length >= 300) throw new Error("术语最多 300 条。");
    const term = { id: uid(), term: "", meaning: "", source: "", uncertain: false };
    session.terms.push(term);
    return term;
  }
  function removeTerm(session, id) {
    session.terms = session.terms.filter(t => t.id !== id);
  }
  function addNode(session, parentID, type = "argument") {
    let count = 0, targetDepth = -1;
    function visit(n, depth) { count++; if (n.id === parentID) targetDepth = depth; n.children.forEach(c => visit(c, depth + 1)); }
    visit(session.pyramid, 0);
    if (count >= MAX_NODES || targetDepth >= MAX_DEPTH) throw new Error("金字塔最多 300 个节点、9 层。");
    const parent = findNode(session.pyramid, parentID);
    if (!parent) throw new Error("找不到父节点。");
    const result = newNode(enumValue(type, TYPES, "argument"));
    parent.children.push(result);
    return result;
  }
  function parentOf(tree, id) {
    if (tree.children.some(c => c.id === id)) return tree;
    for (const child of tree.children) { const p = parentOf(child, id); if (p) return p; }
    return null;
  }
  function removeNode(session, id) {
    const parent = parentOf(session.pyramid, id);
    if (parent) parent.children = parent.children.filter(c => c.id !== id);
  }
  function moveNode(session, id, direction) {
    const parent = parentOf(session.pyramid, id);
    if (!parent) return;
    const index = parent.children.findIndex(c => c.id === id);
    const target = index + (direction === "up" || direction === -1 ? -1 : 1);
    if (target >= 0 && target < parent.children.length) [parent.children[index], parent.children[target]] = [parent.children[target], parent.children[index]];
  }
  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function renderRichTextHTML(value, ranges) {
    let previousCR = false;
    return getTextRuns(value, ranges).map(run => {
      // A CRLF pair remains one paragraph break even when a span divides it.
      const content = previousCR && run.text.startsWith("\n") ? run.text.slice(1) : run.text;
      previousCR = run.text.endsWith("\r");
      const html = escapeHTML(content).replace(/\r\n?|\n/g, "<br />");
      return run.bold && html ? "<strong>" + html + "</strong>" : html;
    }).join("");
  }
  function paragraph(label, value) { return "<p><strong>" + label + "：</strong>" + (value ? escapeHTML(value).replace(/\n/g, "<br />") : "（待填写）") + "</p>"; }
  function renderNoteHTML(raw, now = Date.now()) {
    const s = normalizeSession(raw, raw.item, now);
    const labels = { thesis: "结论", argument: "论点", evidence: "支撑／证据" };
    const orders = { structure: "结构顺序", time: "时间顺序", importance: "重要性顺序" };
    function nodeHTML(n) {
      let html = "<li><p><strong>" + (n.id === "root" ? "主题／核心观点" : labels[n.type]) + "：</strong>" + (n.text ? renderRichTextHTML(n.text, n.boldRanges) : "（待填写）") + "</p>";
      if (n.source) html += paragraph("出处", n.source);
      if (n.children.length) {
        if (n.question) html += paragraph("下层回答的问题", n.question);
        html += "<p>下层关系：" + (n.logic === "deductive" ? "演绎推理；按推理链排序" : "归纳分组；" + orders[n.order]) + "</p><ol>" + n.children.map(nodeHTML).join("") + "</ol>";
      }
      return html + "</li>";
    }
    const statusLabels = { idle: "未开始", running: "进行中", paused: "已暂停", expired: "时间已到", completed: "手动完成" };
    let html = '<div data-schema-version="9"><h1>阅读金字塔｜' + escapeHTML(s.item.title) + "</h1>";
    html += "<p>Reading Flow · " + escapeHTML(new Date(now).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })) + "</p>";
    html += "<p>检视阅读（10 分钟）：" + statusLabels[getTimerView(s.timers.inspection, now).status] + "；术语与金字塔（20 分钟）：" + statusLabels[getTimerView(s.timers.analysis, now).status] + "。这是一次限时阅读的阶段成果。</p>";
    html += "<h2>检视阅读</h2>" + paragraph("研究问题", s.inspection.question) + paragraph("整体结构", s.inspection.structure);
    html += "<p>外部 reading_list.xlsx 分类：" + (s.inspection.classified ? "已由读者记录" : "尚未确认记录") + "</p>";
    html += "<h2>关键术语</h2>";
    if (s.terms.length) html += "<table><tbody><tr><th>术语</th><th>用自己的话解释</th><th>出处</th><th>疑问标记</th></tr>" + s.terms.map(t => "<tr><td>" + escapeHTML(t.term) + "</td><td>" + escapeHTML(t.meaning).replace(/\n/g, "<br />") + "</td><td>" + escapeHTML(t.source) + "</td><td>" + (t.uncertain ? "待核实" : "未标记疑问") + "</td></tr>").join("") + "</tbody></table>";
    else html += "<p>（暂无术语）</p>";
    if (s.framing.situation || s.framing.complication) html += "<h2>序言线索</h2>" + paragraph("情境 S", s.framing.situation) + paragraph("冲突 C", s.framing.complication);
    html += "<h2>金字塔</h2><ol>" + nodeHTML(s.pyramid) + "</ol>";
    html += "<h2>逻辑自检（读者判断）</h2><ul>" + [
      ["summary", "上层概括下层，下层回答上层引出的疑问"],
      ["sameKind", "归纳组内思想属于同一类别"],
      ["order", "归纳排列或演绎链的顺序清晰"],
      ["coverage", "归纳分组在当前范围内尽量不重叠、不遗漏"]
    ].map(([key, label]) => "<li>" + (s.checks[key] ? "已检查：" : "待检查：") + label + "</li>").join("") + "</ul>";
    html += "<h2>留给下一次</h2>" + paragraph("尚未理解／待验证", s.reflection.unresolved) + paragraph("下一步", s.reflection.nextStep);
    return html + "</div>";
  }

  function renderStarterNoteHTML(raw, now = Date.now()) {
    const s = normalizeSession(raw, raw.item, now);
    const value = v => escapeHTML(v || "").replace(/\n/g, "<br />");
    const line = (label, v, ranges) => "<p><strong>" + label + "：</strong>" + renderRichTextHTML(v, ranges) + "</p>";
    let html = '<div data-schema-version="9"><h1>' + value(s.item.title) + '</h1>';
    html += '<h2>主题与结构</h2>';
    html += line('主题／核心观点', s.pyramid.text, s.pyramid.boldRanges);
    if (s.inspection.question) html += line('检视时的研究问题', s.inspection.question);
    html += line('主要部分及其联系', s.inspection.structure);
    if (s.framing.situation) html += line('背景', s.framing.situation);
    if (s.framing.complication) html += line('冲突', s.framing.complication);
    if (s.inspection.classified) html += '<p>已在 reading_list.xlsx 中完成分类。</p>';
    html += '<h2>术语与命题</h2>';
    html += '<p><strong>主要术语：</strong>作者的含义 · 自己的解释</p>';
    for (const t of s.terms) {
      html += '<p>' + value(t.term) + '：' + value(t.meaning);
      if (t.source) html += '（' + value(t.source) + '）';
      if (t.uncertain) html += '〔待核实〕';
      html += '</p>';
    }
    html += '<p><strong>关键命题：</strong>关键句 · 自己的复述 · 具体例子</p>';
    html += '<p><strong>论证：</strong>前提 → 结论；归纳／演绎；证据与位置</p>';
    function outline(n) {
      let body = '<li><p>' + renderRichTextHTML(n.text, n.boldRanges) + '</p>';
      if (n.source) body += line('出处', n.source);
      if (n.question) body += line('下层回答的疑问', n.question);
      if (n.children.length) {
        const orderNames = { structure: '结构', time: '时间', importance: '重要性' };
        body += '<p>' + (n.logic === 'deductive' ? '演绎推理' : '归纳分组 · ' + orderNames[n.order] + '顺序') + '</p>';
        body += '<ol>' + n.children.map(outline).join('') + '</ol>';
      }
      return body + '</li>';
    }
    if (s.pyramid.children.length || s.pyramid.source || s.pyramid.question) {
      html += '<h3>已有金字塔</h3>';
      if (s.pyramid.source) html += line('出处', s.pyramid.source);
      if (s.pyramid.question) html += line('下层回答的疑问', s.pyramid.question);
      if (s.pyramid.children.length) {
        const orderNames = { structure: '结构', time: '时间', importance: '重要性' };
        html += '<p>' + (s.pyramid.logic === 'deductive' ? '演绎推理' : '归纳分组 · ' + orderNames[s.pyramid.order] + '顺序') + '</p>';
        html += '<ol>' + s.pyramid.children.map(outline).join('') + '</ol>';
      }
    }
    html += '<p><strong>作者的解答：</strong>已解决 · 未解决 · 作者是否察觉</p>';
    html += '<h2>批评性判断</h2>';
    html += '<p><em>先理解，再判断；区分知识与意见。</em></p>';
    html += '<p><strong>我的判断：</strong>同意／不同意／暂不判断</p>';
    html += '<p><strong>理由与证据：</strong>信息不足 · 事实错误 · 推理问题 · 分析未尽</p>';
    html += '<p><strong>对我有何意义：</strong></p>';
    if (s.reflection.unresolved) html += line('尚未理解／待验证', s.reflection.unresolved);
    if (s.reflection.nextStep) html += line('下一步', s.reflection.nextStep);
    const checked = [
      ['summary', '上层概括下层，下层回答上层引出的疑问'], ['sameKind', '归纳组内思想属于同一类别'],
      ['order', '归纳排列或演绎链的顺序清晰'], ['coverage', '当前范围内尽量不重叠、不遗漏']
    ].filter(([key]) => s.checks[key]).map(([, label]) => '<li>' + label + '</li>');
    if (checked.length) html += '<h3>已有逻辑自检</h3><ul>' + checked.join('') + '</ul>';
    return html + '</div>';
  }

  function diagramCharacterUnits(ch, bold) {
    // Conservative Arial advance estimates, in ems, with full-width fallback.
    // Bold Latin glyphs need extra room; CJK and emoji retain their full advance.
    if (ch === '\t') return 1.2;
    if (!/[\u0020-\u007e]/.test(ch)) return 1;
    if (" !'.,:;Iijl|".includes(ch)) return bold ? 0.34 : 0.3;
    if ('()[]{}frt/\\'.includes(ch)) return bold ? 0.43 : 0.37;
    if (ch === 'W' || ch === '@') return 1.02;
    if (ch === 'M' || ch === 'm' || ch === '%') return bold ? 0.93 : 0.89;
    if (ch === 'w') return bold ? 0.81 : 0.75;
    if (/[A-Z]/.test(ch)) return bold ? 0.84 : 0.79;
    return bold ? 0.65 : 0.59;
  }
  function wrapDiagramText(input, ranges, maxUnits = 15) {
    const content = typeof input === 'string' ? input : '';
    const normalized = normalizeBoldRanges(ranges, content);
    const lines = [], lineRuns = [], lineUnits = [];
    let current = '', runs = [], units = 0, offset = 0, rangeIndex = 0, previousCR = false;
    function endLine() {
      lines.push(current); lineRuns.push(runs); lineUnits.push(units);
      current = ''; runs = []; units = 0;
    }
    for (const ch of content) {
      const start = offset;
      offset += ch.length;
      while (normalized[rangeIndex] && normalized[rangeIndex].end <= start) rangeIndex++;
      const bold = !!(normalized[rangeIndex] && normalized[rangeIndex].start <= start);
      if (ch === '\n' && previousCR) { previousCR = false; continue; }
      previousCR = ch === '\r';
      if (ch === '\n' || ch === '\r') { endLine(); continue; }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(ch)) continue;
      const weight = diagramCharacterUnits(ch, bold);
      if (current && units + weight > maxUnits) endLine();
      current += ch; units += weight;
      const previous = runs[runs.length - 1];
      if (previous && previous.bold === bold) previous.text += ch;
      else runs.push({ text: ch, bold });
    }
    endLine();
    return { lines, lineRuns, lineUnits };
  }

  function layoutPyramid(raw, now = Date.now()) {
    const s = normalizeSession(raw, raw.item, now);
    const width = 240, gap = 26, padding = 20, rowGap = 48, lineHeight = 20;
    const nodes = [], levels = [];
    function measure(n, depth, parentID) {
      const { lines, lineRuns, lineUnits } = wrapDiagramText(n.text || (depth === 0 ? '主题／核心观点' : '论点／理由'), n.boldRanges);
      function append(value) {
        const wrapped = wrapDiagramText(value);
        lines.push(...wrapped.lines); lineRuns.push(...wrapped.lineRuns); lineUnits.push(...wrapped.lineUnits);
      }
      if (n.source) append('出处：' + n.source);
      if (n.question) append('疑问：' + n.question);
      const entry = { id: n.id, parentID, depth, lines, lineRuns, lineUnits, width, height: Math.max(64, lines.length * lineHeight + 28), x: 0, y: 0, children: [] };
      nodes.push(entry); levels[depth] = Math.max(levels[depth] || 0, entry.height);
      entry.children = n.children.map(c => measure(c, depth + 1, n.id));
      entry.span = Math.max(width, entry.children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, entry.children.length - 1) * gap);
      return entry;
    }
    const tree = measure(s.pyramid, 0, null);
    let annotation = null;
    if (s.framing.situation || s.framing.complication) {
      const lines = [], lineRuns = [], lineUnits = [];
      for (const [label, content] of [['背景：', s.framing.situation], ['冲突：', s.framing.complication]]) {
        if (!content) continue;
        if (lines.length) { lines.push(''); lineRuns.push([]); lineUnits.push(0); }
        const wrapped = wrapDiagramText(label + content);
        lines.push(...wrapped.lines); lineRuns.push(...wrapped.lineRuns); lineUnits.push(...wrapped.lineUnits);
      }
      annotation = { lines, lineRuns, lineUnits, width, height: Math.max(64, lines.length * lineHeight + 28), x: 0, y: padding };
      levels[0] = Math.max(levels[0], annotation.height);
    }
    const yPositions = [padding];
    for (let i = 1; i < levels.length; i++) yPositions[i] = yPositions[i - 1] + levels[i - 1] + rowGap;
    function position(n, left) {
      n.x = left + (n.span - width) / 2; n.y = yPositions[n.depth];
      let childLeft = left + (n.span - n.children.reduce((sum, c) => sum + c.span, 0) - Math.max(0, n.children.length - 1) * gap) / 2;
      for (const child of n.children) { position(child, childLeft); childLeft += child.span + gap; }
    }
    const leftMargin = annotation ? Math.max(padding, padding + annotation.width + gap - (tree.span - width) / 2) : padding;
    position(tree, leftMargin);
    if (annotation) annotation.x = tree.x - annotation.width - gap;
    return { width: tree.span + leftMargin + padding, height: yPositions[levels.length - 1] + levels[levels.length - 1] + padding, nodes, annotation, lineHeight };
  }

  function renderPyramidSVG(raw, now = Date.now()) {
    const layout = layoutPyramid(raw, now);
    const byID = new Map(layout.nodes.map(n => [n.id, n]));
    let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '"><rect width="100%" height="100%" fill="white"/>';
    for (const n of layout.nodes) {
      if (!n.parentID) continue;
      const p = byID.get(n.parentID);
      svg += '<path d="M' + (p.x + p.width / 2) + ',' + (p.y + p.height) + ' L' + (n.x + n.width / 2) + ',' + n.y + '" stroke="black" fill="none" stroke-width="1.3"/>';
    }
    function boxSVG(n, isAnnotation) {
      let result = '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" fill="white" stroke="black" stroke-width="1.3"' + (isAnnotation ? ' stroke-dasharray="4 3"' : '') + '/>';
      result += '<text fill="black" font-size="14" font-family="Arial, Microsoft YaHei, sans-serif" xml:space="preserve">';
      n.lineRuns.forEach((runs, i) => {
        result += '<tspan x="' + (n.x + 14) + '" y="' + (n.y + 23 + i * layout.lineHeight) + '">' +
          runs.map(run => run.bold ? '<tspan font-weight="700">' + escapeHTML(run.text) + '</tspan>' : escapeHTML(run.text)).join('') + '</tspan>';
      });
      return result + '</text>';
    }
    // Keep the root as the first text element for existing SVG consumers.
    for (const n of layout.nodes) svg += boxSVG(n, false);
    if (layout.annotation) {
      const a = layout.annotation, top = layout.nodes[0];
      svg += '<g data-role="framing-annotation"><line x1="' + (a.x + a.width) + '" y1="' + (a.y + a.height / 2) + '" x2="' + top.x + '" y2="' + (top.y + top.height / 2) + '" stroke="black" stroke-dasharray="4 3"/>' + boxSVG(a, true) + '</g>';
    }
    return svg + '</svg>';
  }
  return { VERSION, DURATIONS, MAX_NODES, MAX_DEPTH, MAX_ROOT_TEXT, uid, createSession, normalizeSession, normalizeBoldRanges, getTextRuns, getTimerView, startTimer, pauseTimer, resetTimer, completePhase, findNode, addTerm, removeTerm, addNode, removeNode, moveNode, escapeHTML, renderRichTextHTML, renderNoteHTML, renderStarterNoteHTML, layoutPyramid, renderPyramidSVG };
});
