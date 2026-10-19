const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../content/core.js');
const item = { libraryID: 1, key: 'ABCD1234', title: '一次阅读测试' };
const now = 1_800_000_000_000;

test('ten-minute timer uses deadline, survives background drift and expires on reopening', () => {
  const s = core.createSession(item, now);
  core.startTimer(s, 'inspection', now);
  assert.equal(core.getTimerView(s.timers.inspection, now + 75_123).display, '08:45');
  const restored = core.normalizeSession(JSON.parse(JSON.stringify(s)), item, now + 700_000);
  assert.equal(restored.timers.inspection.status, 'expired');
  assert.equal(restored.timers.analysis.status, 'idle');
  assert.equal(restored.phase, 'inspection');
});

test('pause resumes remaining time and repeated start does not extend the deadline', () => {
  const s = core.createSession(item, now);
  core.startTimer(s, 'inspection', now);
  core.startTimer(s, 'inspection', now + 10_000);
  assert.equal(s.timers.inspection.deadline, now + 600_000);
  core.pauseTimer(s, now + 30_000);
  assert.equal(s.timers.inspection.remainingMs, 570_000);
  assert.equal(core.getTimerView(s.timers.inspection, now + 300_000).remainingMs, 570_000);
  core.startTimer(s, 'inspection', now + 300_000);
  assert.equal(s.timers.inspection.deadline, now + 870_000);
});

test('explicit phase switch pauses old timer and completed timer never restarts by accident', () => {
  const s = core.createSession(item, now);
  core.startTimer(s, 'inspection', now);
  core.startTimer(s, 'analysis', now + 60_000);
  assert.equal(s.timers.inspection.status, 'paused');
  assert.equal(s.timers.analysis.remainingMs, 1_200_000);
  core.completePhase(s, now + 90_000);
  assert.equal(s.timers.analysis.status, 'completed');
  core.startTimer(s, 'analysis', now + 100_000);
  assert.equal(s.timers.analysis.status, 'completed');
  assert.equal(s.completedAt, now + 90_000);
  core.resetTimer(s, 'analysis', now + 110_000);
  assert.equal(s.timers.analysis.status, 'idle');
  assert.equal(s.completedAt, null);
});

test('rejects wrong-paper, future format, damaged timer and unbounded import data', () => {
  const s = core.createSession(item, now);
  assert.throws(() => core.normalizeSession(s, { ...item, key: 'OTHER' }, now), /另一篇/);
  assert.throws(() => core.normalizeSession({ ...s, schemaVersion: 2 }, item, now), /格式/);
  s.timers.inspection.status = 'running';
  assert.throws(() => core.normalizeSession(s, item, now), /损坏/);
  s.timers.inspection.status = 'idle';
  s.pyramid.children = Array.from({ length: 301 }, () => ({ children: [] }));
  assert.throws(() => core.normalizeSession(s, item, now), /过大/);
});

test('tree utilities retain sibling ordering and remove a subtree as a unit', () => {
  const s = core.createSession(item, now);
  const a = core.addNode(s, 'root');
  const b = core.addNode(s, 'root');
  core.addNode(s, a.id, 'evidence');
  core.moveNode(s, b.id, 'up');
  assert.equal(s.pyramid.children[0].id, b.id);
  core.removeNode(s, a.id);
  assert.equal(s.pyramid.children.length, 1);
  assert.equal(core.findNode(s.pyramid, a.id), null);
});

test('note export escapes untrusted text and reports unfinished reading honestly', () => {
  const s = core.createSession({ ...item, title: '<img src=x onerror=alert(1)>' }, now);
  s.pyramid.text = '<script>attack()</script> & 结论';
  const term = core.addTerm(s);
  term.term = '<iframe>';
  term.uncertain = true;
  const html = core.renderNoteHTML(s, now);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('待核实'));
  assert.ok(html.includes('未开始'));
});

test('snapshot restores only owned fields and repairs duplicate node IDs', () => {
  const s = core.createSession(item, now);
  s.pyramid.children = [{ id: 'root', text: 'child', children: [] }];
  s.noteKey = 'DO_NOT_REUSE_EXTERNAL_NOTE';
  s.unrelated = { polluted: true };
  const normalized = core.normalizeSession(s, item, now);
  assert.notEqual(normalized.pyramid.children[0].id, normalized.pyramid.id);
  assert.equal(normalized.noteKey, null);
  assert.equal(normalized.unrelated, undefined);
});

test('v1 checklist migrates conservatively and stable note key round-trips', () => {
  const s = core.createSession(item, now);
  s.inspection.checklist = [true, false, true, true, true];
  s.noteKey = 'NOTE1234';
  const migrated = core.normalizeSession(s, item, now);
  assert.deepEqual(migrated.inspection.checklist, [true, false, true, false, true, false]);
  assert.deepEqual(migrated.inspection.legacyChecklist, s.inspection.checklist);
  assert.equal(migrated.inspection.completed, false);
  assert.equal(migrated.noteKey, 'NOTE1234');
  assert.deepEqual(core.normalizeSession(migrated, item, now).inspection, migrated.inspection);
});

test('legacy question and answer merge into one root without losing independent inspection data', () => {
  for (const [question, answer, expected] of [
    ['研究问题\n补充说明', '核心观点\n另一行', '研究问题\n补充说明\n\n核心观点\n另一行'],
    ['只有问题', '', '只有问题'], ['', '只有观点', '只有观点'], ['', '', '']
  ]) {
    const legacy = core.createSession(item, now);
    legacy.framing.question = question; legacy.pyramid.text = answer;
    legacy.inspection.question = '独立的检视问题'; legacy.framing.situation = '情境'; legacy.framing.complication = '冲突';
    const migrated = core.normalizeSession(legacy, item, now);
    assert.equal(migrated.pyramid.text, expected); assert.equal(migrated.framing.question, '');
    assert.equal(migrated.inspection.question, '独立的检视问题');
    assert.equal(migrated.framing.situation, '情境'); assert.equal(migrated.framing.complication, '冲突');
    assert.equal(legacy.framing.question, question, 'normalization does not mutate the supplied backup');
    assert.deepEqual(core.normalizeSession(migrated, item, now), migrated);
    migrated.pyramid.text = '重新编辑后的主题\n下一行';
    const reopened = core.normalizeSession(JSON.parse(JSON.stringify(migrated)), item, now);
    assert.equal(reopened.pyramid.text, '重新编辑后的主题\n下一行'); assert.equal(reopened.framing.question, '');
  }
  const legacy = core.createSession(item, now);
  legacy.framing.question = '问'.repeat(20000); legacy.pyramid.text = '答'.repeat(20000);
  const migrated = core.normalizeSession(legacy, item, now);
  assert.equal(migrated.pyramid.text.length, core.MAX_ROOT_TEXT);
  assert.equal(core.normalizeSession(migrated, item, now).pyramid.text, migrated.pyramid.text);
});

test('merged root appears once in diagrams and starter notes while root metadata and descendants remain', () => {
  const legacy = core.createSession(item, now);
  legacy.framing.question = '旧科学问题'; legacy.pyramid.text = '旧核心观点';
  legacy.inspection.question = '独立检视信息'; legacy.framing.situation = '旧背景'; legacy.framing.complication = '旧冲突';
  legacy.pyramid.source = '根出处 p.1'; legacy.pyramid.question = '下层回答什么'; legacy.pyramid.logic = 'deductive';
  const child = core.addNode(legacy, 'root'); child.text = '完整下层论点'; child.source = '下层出处 p.2';
  for (const rendered of [core.renderPyramidSVG(legacy, now), core.renderStarterNoteHTML(legacy, now), core.renderNoteHTML(legacy, now)]) {
    assert.equal(rendered.split('旧科学问题').length - 1, 1); assert.equal(rendered.split('旧核心观点').length - 1, 1);
    for (const value of ['根出处 p.1', '下层回答什么', '完整下层论点', '下层出处 p.2']) assert.ok(rendered.includes(value), value);
  }
  const starter = core.renderStarterNoteHTML(legacy, now);
  for (const value of ['主题与结构', '术语与命题', '批评性判断', '独立检视信息', '旧背景', '旧冲突', '演绎推理']) assert.ok(starter.includes(value), value);
  const root = core.layoutPyramid(legacy, now).nodes.find(node => node.id === 'root');
  assert.deepEqual(root.lines.slice(0, 3), ['旧科学问题', '', '旧核心观点']);
});

test('native starter covers all three analytical aspects and preserves v1 written content', () => {
  const s = core.createSession(item, now);
  s.inspection.question = '科学问题 <unsafe>';
  s.inspection.structure = '结构';
  s.framing.situation = '背景';
  const term = core.addTerm(s); term.term = '术语'; term.meaning = '我的解释'; term.source = 'p.3';
  s.pyramid.text = '作者的回答';
  const child = core.addNode(s, 'root'); child.text = '支持回答的理由'; child.source = 'p.4';
  s.reflection.unresolved = '尚未理解';
  const html = core.renderStarterNoteHTML(s, now);
  for (const label of ['主题与结构', '术语与命题', '批评性判断', '关键命题', '自己的复述', '具体例子', '前提 → 结论', '作者的解答', '作者是否察觉', '区分知识与意见', '理由与证据', '对我有何意义', '我的解释', '支持回答的理由', '尚未理解']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('&lt;unsafe&gt;'));
  assert.ok(!html.includes('<unsafe>'));
});

test('pyramid layout handles uneven trees without overlapping boxes and SVG escapes text', () => {
  const s = core.createSession(item, now);
  s.framing.question = '为什么？'; s.pyramid.text = '<script> & 核心回答';
  const a = core.addNode(s, 'root'); a.text = '第一组理由';
  core.addNode(s, a.id).text = '证据一'; core.addNode(s, a.id).text = '证据二';
  core.addNode(s, 'root').text = '另一组理由';
  const layout = core.layoutPyramid(s, now);
  for (const n of layout.nodes) {
    assert.ok(n.x >= 0 && n.x + n.width <= layout.width);
    assert.ok(n.y >= 0 && n.y + n.height <= layout.height);
    for (const other of layout.nodes.filter(o => o.id !== n.id && o.depth === n.depth)) assert.ok(n.x + n.width <= other.x || other.x + other.width <= n.x);
  }
  const svg = core.renderPyramidSVG(s, now);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(!svg.includes('<script>'));
  assert.equal((svg.match(/<path /g) || []).length, layout.nodes.length - 1);
});

test('import identifiers cannot break UI selectors and cycles are rejected', () => {
  const s = core.createSession(item, now);
  s.pyramid.children.push({ id: '\"] textarea', children: [] });
  const normalized = core.normalizeSession(s, item, now);
  assert.match(normalized.pyramid.children[0].id, /^[A-Za-z0-9_-]+$/);
  s.pyramid.children = [s.pyramid];
  assert.throws(() => core.normalizeSession(s, item, now), /循环/);
});

test('bold ranges merge, bound malformed imports, and include complete Unicode code points', () => {
  const content = 'A😀 B中C <tail>';
  assert.deepEqual(core.normalizeBoldRanges([
    { start: 5, end: 100 }, { start: 2, end: 3 }, { start: 3, end: 4 }, { start: 2, end: 3 },
    null, [0, 1], { start: '0', end: 1 }, { start: 0.5, end: 1 },
    { start: 0, end: Infinity }, { start: 4, end: 3 }, { start: 1, end: 1 }
  ], content), [{ start: 1, end: 4 }, { start: 5, end: content.length }]);
  assert.deepEqual(core.normalizeBoldRanges([{ start: 1, end: 2 }], 'A😀B'), [{ start: 1, end: 3 }]);
  assert.deepEqual(core.normalizeBoldRanges([{ start: -8, end: 1 }, { start: 9, end: 12 }], 'A😀'), [{ start: 0, end: 1 }]);
  assert.deepEqual(core.normalizeBoldRanges([...Array(30).fill(null), { start: 0, end: 1 }], 'A'), [{ start: 0, end: 1 }]);
  for (const malformed of [null, {}, 'bold', 1]) assert.deepEqual(core.normalizeBoldRanges(malformed, content), []);
  assert.deepEqual(core.normalizeBoldRanges([{ start: 0, end: 1 }], ''), []);
});

test('formatted root and descendants survive JSON saving and reloading without changing plain text', () => {
  const s = core.createSession(item, now);
  s.pyramid.text = '主题😀 <unsafe>\n另一段';
  s.pyramid.boldRanges = [{ start: 3, end: 4, html: '<script>' }, { start: 0, end: 1 }];
  const child = core.addNode(s, 'root');
  child.text = '支持的理由'; child.boldRanges = [{ start: 3, end: 5 }];
  const plain = core.addNode(s, 'root'); plain.text = '旧版纯文本';
  const normalized = core.normalizeSession(JSON.parse(JSON.stringify(s)), item, now);
  assert.equal(normalized.pyramid.text, s.pyramid.text);
  assert.deepEqual(normalized.pyramid.boldRanges, [{ start: 0, end: 1 }, { start: 2, end: 4 }]);
  assert.deepEqual(normalized.pyramid.children[0].boldRanges, [{ start: 3, end: 5 }]);
  assert.equal(Object.hasOwn(normalized.pyramid.children[1], 'boldRanges'), false);
  assert.equal(Object.hasOwn(core.createSession(item, now).pyramid, 'boldRanges'), false);
  assert.deepEqual(core.normalizeSession(JSON.parse(JSON.stringify(normalized)), item, now), normalized);
  const runs = core.getTextRuns(normalized.pyramid.text, normalized.pyramid.boldRanges);
  assert.deepEqual(runs, [
    { text: '主', bold: true }, { text: '题', bold: false }, { text: '😀', bold: true },
    { text: ' <unsafe>\n另一段', bold: false }
  ]);
  assert.equal(runs.map(run => run.text).join(''), s.pyramid.text);
  assert.deepEqual(core.getTextRuns('', [{ start: 0, end: 1 }]), []);
});

test('text length limits clip formatting safely and do not retain half of an emoji', () => {
  const s = core.createSession(item, now);
  const child = core.addNode(s, 'root');
  child.text = 'x'.repeat(19999) + '😀tail';
  child.boldRanges = [{ start: 19998, end: 20005 }, { start: 20005, end: 30000 }];
  s.pyramid.text = 'x'.repeat(core.MAX_ROOT_TEXT - 1) + '😀';
  s.pyramid.boldRanges = [{ start: core.MAX_ROOT_TEXT - 1, end: core.MAX_ROOT_TEXT + 1 }];
  const normalized = core.normalizeSession(s, item, now);
  assert.equal(normalized.pyramid.text, 'x'.repeat(core.MAX_ROOT_TEXT - 1));
  assert.equal(Object.hasOwn(normalized.pyramid, 'boldRanges'), false);
  assert.equal(normalized.pyramid.children[0].text, 'x'.repeat(19999));
  assert.deepEqual(normalized.pyramid.children[0].boldRanges, [{ start: 19998, end: 19999 }]);
  child.boldRanges = '<strong>everything</strong>';
  assert.equal(Object.hasOwn(core.normalizeSession(s, item, now).pyramid.children[0], 'boldRanges'), false);
});

test('legacy question merge shifts root formatting once and leaves the question prefix plain', () => {
  const legacy = core.createSession(item, now);
  legacy.framing.question = '旧问题😀'; legacy.pyramid.text = '新😀观点';
  legacy.pyramid.boldRanges = [{ start: 1, end: 3 }, { start: 4, end: 5 }];
  const migrated = core.normalizeSession(legacy, item, now);
  assert.equal(migrated.pyramid.text, '旧问题😀\n\n新😀观点');
  assert.deepEqual(migrated.pyramid.boldRanges, [{ start: 8, end: 10 }, { start: 11, end: 12 }]);
  assert.deepEqual(core.normalizeSession(JSON.parse(JSON.stringify(migrated)), item, now), migrated);
  assert.deepEqual(legacy.pyramid.boldRanges, [{ start: 1, end: 3 }, { start: 4, end: 5 }]);
  const expected = '旧问题😀<br /><br />新<strong>😀</strong>观<strong>点</strong>';
  assert.ok(core.renderStarterNoteHTML(legacy, now).includes(expected));
  assert.ok(core.renderNoteHTML(legacy, now).includes(expected));
});

test('rich HTML escapes every text run and preserves paragraph breaks across spans', () => {
  assert.equal(core.renderRichTextHTML('<img> & 😀\nnext', [{ start: 0, end: 5 }, { start: 8, end: 10 }]),
    '<strong>&lt;img&gt;</strong> &amp; <strong>😀</strong><br />next');
  assert.equal(core.renderRichTextHTML('"quote" \'word\'', [{ start: 0, end: 7 }]), '<strong>&quot;quote&quot;</strong> &#39;word&#39;');
  assert.equal(core.renderRichTextHTML('a\r\nb\rc\nd', [{ start: 2, end: 4 }]), 'a<br /><strong>b</strong><br />c<br />d');
  assert.equal(core.renderRichTextHTML('x\r\ny', [{ start: 2, end: 3 }]), 'x<br />y');
  assert.equal(core.renderRichTextHTML('', []), '');
  const s = core.createSession(item, now);
  s.pyramid.text = '原有<标签>\n主题'; s.pyramid.boldRanges = [{ start: 2, end: 6 }];
  const child = core.addNode(s, 'root'); child.text = '支持😀结论'; child.boldRanges = [{ start: 2, end: 4 }];
  for (const html of [core.renderStarterNoteHTML(s, now), core.renderNoteHTML(s, now)]) {
    assert.ok(html.includes('<strong>疑问／回答：</strong>原有<strong>&lt;标签&gt;</strong><br />主题'));
    assert.ok(html.includes('支持<strong>😀</strong>结论'));
    assert.ok(!html.includes('<标签>'));
  }
});

test('SVG retains selected bold text through wrapping, blank paragraphs, and emoji', () => {
  const s = core.createSession(item, now);
  s.pyramid.text = '开头😀' + '长'.repeat(35) + '\n\n末尾<标>';
  const paragraphEnd = s.pyramid.text.indexOf('\n');
  s.pyramid.boldRanges = [{ start: 1, end: 18 }, { start: 28, end: paragraphEnd + 1 }];
  const layout = core.layoutPyramid(s, now), root = layout.nodes[0];
  const runs = root.lineRuns.flat();
  assert.equal(runs.map(run => run.text).join(''), s.pyramid.text.replace(/\n/g, ''));
  assert.equal(runs.filter(run => run.bold).map(run => run.text).join(''),
    s.pyramid.text.slice(1, 18) + s.pyramid.text.slice(28, paragraphEnd));
  assert.ok(root.lineRuns.filter(line => line.some(run => run.bold)).length >= 3);
  assert.ok(root.lines.includes(''));
  assert.equal(root.lines.at(-1), '末尾<标>');
  assert.equal(root.height, root.lines.length * layout.lineHeight + 28);
  root.lineUnits.forEach(units => assert.ok(units * 14 <= root.width - 28));
  for (const run of runs) {
    for (const ch of run.text) assert.ok(ch.length === 2 || ch.charCodeAt(0) < 0xd800 || ch.charCodeAt(0) > 0xdfff);
  }
  const svg = core.renderPyramidSVG(s, now);
  const boldText = Array.from(svg.matchAll(/<tspan font-weight="700">([^<]*)<\/tspan>/g), match => match[1]).join('');
  assert.equal(boldText, runs.filter(run => run.bold).map(run => run.text).join(''));
  assert.ok(svg.includes('&lt;标&gt;'));
  assert.ok(!svg.includes('<标>'));
  assert.ok(svg.includes('xml:space="preserve"'));
  s.pyramid.text = 'a'.repeat(100); delete s.pyramid.boldRanges;
  const regular = core.layoutPyramid(s, now).nodes[0];
  s.pyramid.boldRanges = [{ start: 0, end: 100 }];
  const bold = core.layoutPyramid(s, now).nodes[0];
  assert.ok(bold.lines.length > regular.lines.length, 'bold glyph widths affect wrapping and height');
});

test('background and complication render beside the root without changing the tree hierarchy', () => {
  const s = core.createSession(item, now);
  s.pyramid.text = '主题'; const child = core.addNode(s, 'root'); child.text = '理由';
  const original = core.layoutPyramid(s, now);
  assert.equal(original.annotation, null);
  for (const [situation, complication, expected] of [
    ['背景文字', '', ['背景：背景文字']], ['', '冲突文字', ['冲突：冲突文字']],
    ['<unsafe>\n' + '长背景'.repeat(30), '冲突文字\n仍有疑问', null]
  ]) {
    s.framing.situation = situation; s.framing.complication = complication;
    const layout = core.layoutPyramid(s, now), annotation = layout.annotation, root = layout.nodes[0];
    assert.equal(layout.nodes.length, original.nodes.length);
    assert.equal(root.x, layout.nodes[1].x, 'root stays on the vertical stem above its child');
    assert.ok(annotation.x >= 0 && annotation.y >= 0);
    assert.ok(annotation.x + annotation.width + 26 <= root.x);
    assert.ok(annotation.x + annotation.width <= layout.width && annotation.y + annotation.height <= layout.height);
    assert.ok(layout.nodes[1].y >= annotation.y + annotation.height + 48);
    annotation.lineUnits.forEach(units => assert.ok(units * 14 <= annotation.width - 28));
    if (expected) assert.deepEqual(annotation.lines, expected);
    else {
      assert.ok(annotation.lines[0].startsWith('背景：'));
      assert.ok(annotation.lines.indexOf('冲突：冲突文字') > annotation.lines.indexOf('背景：<unsafe>'));
      assert.ok(annotation.lines.includes('仍有疑问'));
    }
    const svg = core.renderPyramidSVG(s, now);
    assert.equal((svg.match(/<path /g) || []).length, layout.nodes.length - 1);
    assert.equal((svg.match(/data-role="framing-annotation"/g) || []).length, 1);
    assert.ok(!svg.includes('<unsafe>'));
    if (situation) assert.ok(svg.includes('背景：'));
    if (complication) assert.ok(svg.includes('冲突：'));
    for (const html of [core.renderStarterNoteHTML(s, now), core.renderNoteHTML(s, now)]) {
      if (situation) assert.ok(html.includes(core.escapeHTML(situation).replace(/\n/g, '<br />')));
      if (complication) assert.ok(html.includes('冲突文字'));
    }
  }
  s.framing.situation = '背景'; s.framing.complication = '冲突';
  core.addNode(s, child.id).text = '证据'; core.addNode(s, 'root').text = '第二组理由';
  const annotated = core.layoutPyramid(s, now);
  s.framing.situation = ''; s.framing.complication = '';
  const plain = core.layoutPyramid(s, now);
  for (let i = 0; i < plain.nodes.length; i++) {
    assert.equal(annotated.nodes[i].x - annotated.nodes[0].x, plain.nodes[i].x - plain.nodes[0].x);
  }
});

test('old backups retain the original pyramid size and only supported numeric sizes survive normalization', () => {
  const original = core.createSession(item, now);
  assert.equal(original.pyramidFontSize, 14);
  delete original.pyramidFontSize;
  original.pyramid.text = '旧笔记不会因增加字号而改变内容';
  assert.equal(core.normalizeSession(original, item, now).pyramidFontSize, 14);
  assert.equal(Object.hasOwn(original, 'pyramidFontSize'), false, 'migrating a backup does not mutate it');
  for (const value of [10, 12, 14, 16, 18, 20, 24, 28, 32]) {
    const restored = core.normalizeSession({ ...original, pyramidFontSize: value }, item, now);
    assert.equal(restored.pyramidFontSize, value);
    assert.equal(core.normalizeSession(JSON.parse(JSON.stringify(restored)), item, now).pyramidFontSize, value);
  }
  for (const value of [undefined, null, false, true, '24', '32px', [], {}, 0, -14, 13, 14.5, 33, 1000000, NaN, Infinity]) {
    assert.equal(core.normalizeSession({ ...original, pyramidFontSize: value }, item, now).pyramidFontSize, 14, String(value));
  }
});

test('large pyramid text reflows inside fixed-width boxes without losing bold Unicode or colliding with the next level', () => {
  const s = core.createSession(item, now);
  s.pyramid.text = 'WW😀中 <unsafe> ' + 'long bold English 中文理由😀 '.repeat(8);
  s.pyramid.boldRanges = [{ start: 2, end: 22 }];
  s.pyramid.source = 'p.123 — ' + '原文出处'.repeat(8);
  s.framing.situation = '背景 ' + '长期研究观察到了森林变化。'.repeat(8);
  s.framing.complication = '冲突 <not-html> ' + '原因仍不明确😀'.repeat(8);
  const first = core.addNode(s, 'root'); first.text = '第一组 ' + 'WW中文😀reason '.repeat(20);
  core.addNode(s, first.id).text = '下层证据 '.repeat(24);
  core.addNode(s, 'root').text = '另一组 '.repeat(18);
  const regular = core.layoutPyramid(s, now);
  s.pyramidFontSize = 32;
  const large = core.layoutPyramid(s, now);
  assert.equal(large.width, regular.width, 'larger type must not widen the diagram and cancel its benefit when fitted into a note');
  assert.ok(large.height > regular.height);
  assert.equal(large.fontSize, 32);
  const boxes = [...large.nodes, large.annotation];
  for (const box of boxes) {
    assert.equal(box.width, 240);
    assert.ok(box.x >= 0 && box.x + box.width <= large.width);
    assert.ok(box.y >= 0 && box.y + box.height <= large.height);
    box.lineUnits.forEach(units => assert.ok(units * 32 <= box.width - 28 + 1e-9, 'wrapped line remains inside its box'));
    assert.ok(large.baselineOffset + (box.lines.length - 1) * large.lineHeight + 32 * 0.3 < box.height);
    for (const other of boxes.filter(value => value !== box)) {
      assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y, 'boxes do not overlap');
    }
    for (const line of box.lines) for (const ch of line) assert.ok(ch.length === 2 || ch.charCodeAt(0) < 0xd800 || ch.charCodeAt(0) > 0xdfff);
  }
  for (const node of large.nodes.filter(value => value.parentID)) {
    const parent = large.nodes.find(value => value.id === node.parentID);
    assert.ok(node.y >= parent.y + parent.height + 48);
  }
  const root = large.nodes[0], sourceOffset = root.lines.join('').indexOf('出处：');
  assert.equal(root.lines.join('').slice(0, sourceOffset), s.pyramid.text);
  assert.equal(root.lineRuns.flat().filter(run => run.bold).map(run => run.text).join(''), s.pyramid.text.slice(2, 22));
  const svg = core.renderPyramidSVG(s, now);
  assert.equal((svg.match(/font-size="32"/g) || []).length, boxes.length);
  assert.match(svg, /font-weight="700"/);
  assert.ok(svg.includes('&lt;') && svg.includes('&gt;'), 'untrusted text remains escaped even after wrapping');
  assert.doesNotMatch(svg, /<unsafe>|<not-html>/);
});
