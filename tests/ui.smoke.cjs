/* Run: node tests/ui.smoke.cjs. Tests only the compact tools; the native editor is tested in Zotero. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'output');
const version = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8')).version;
const screenshotName = name => name + '-' + version + '.png';
const errors = [], checks = [];
function pass(name) { checks.push(name); console.log('PASS ' + name); }

async function selectNodeText(page, nodeID, start, end = start) {
  await selectEditorText(page.locator('[data-node-id="' + nodeID + '"] .node-text'), start, end);
}
async function selectEditorText(editorLocator, start, end = start) {
  await editorLocator.evaluate((editor, offsets) => {
    editor.focus();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT), leaves = [];
    let leaf;
    while ((leaf = walker.nextNode())) leaves.push(leaf);
    const point = offset => {
      for (const node of leaves) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      if (offset || !leaves.length) throw new Error('Selection offset is outside the node text');
      return [leaves[leaves.length - 1], leaves[leaves.length - 1].length];
    };
    const range = document.createRange();
    range.setStart(...point(offsets.start)); range.setEnd(...point(offsets.end));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, { start, end });
}

async function framingBoldRegression(context) {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const state = () => page.evaluate(() => window.ReadingFlowApp.getState());
  const situation = page.getByRole('textbox', { name: '背景', exact: true }), complication = page.getByRole('textbox', { name: '冲突', exact: true });
  const root = page.locator('[data-node-id="root"] .node-text');
  const load = async (data, mode) => page.evaluate(async ({ data, mode }) => {
    const item = { libraryID: 1, key: 'FRAMEB01', title: 'Independent annotation formatting' }, config = window.mockConfig(item, data, mode === 'readOnly');
    if (mode === 'pending') Object.assign(config, { syncPending: true });
    if (mode === 'conflict') Object.assign(config, { syncConflict: true });
    await window.ReadingFlowApp.loadConfig(config);
  }, { data, mode });
  try {
    await page.goto(pathToFileURL(path.join(project, 'content', 'app.xhtml')).href);
    await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    await load(null);
    await page.locator('#pyramid-toggle').click(); await root.fill('独立主题保持普通文字');
    await page.locator('#framing-toggle').click();
    await situation.fill('前言 alpha beta 结尾😀'); await complication.fill('原因 gamma delta 未知');
    await selectEditorText(situation, 3, 8); await page.locator('#node-bold').click();
    assert.deepEqual((await state()).framing.situationBoldRanges, [{ start: 3, end: 8 }]);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'alpha');
    assert.equal(await page.locator('#node-bold').getAttribute('aria-pressed'), 'true');
    assert.equal(await situation.locator('b,strong').textContent(), 'alpha');
    await page.locator('#node-bold').click();
    assert.deepEqual((await state()).framing.situationBoldRanges || [], []);
    await page.keyboard.press('Control+b');
    assert.deepEqual((await state()).framing.situationBoldRanges, [{ start: 3, end: 8 }]);
    await selectEditorText(complication, 3, 8); await page.keyboard.press('Control+b');
    assert.deepEqual((await state()).framing.complicationBoldRanges, [{ start: 3, end: 8 }]);
    await page.keyboard.press('Control+b');
    assert.deepEqual((await state()).framing.complicationBoldRanges || [], []);
    await page.keyboard.press('Control+b');
    assert.deepEqual((await state()).framing.situationBoldRanges, [{ start: 3, end: 8 }]);
    assert.deepEqual((await state()).pyramid.boldRanges || [], []);
    pass('background and conflict support selected-text B and Ctrl+B independently without formatting the root');

    await selectEditorText(situation, 5); await page.keyboard.insertText('X');
    assert.equal((await state()).framing.situation, '前言 alXpha beta 结尾😀');
    assert.deepEqual((await state()).framing.situationBoldRanges, [{ start: 3, end: 9 }]);
    await selectEditorText(situation, 5, 6); await page.keyboard.press('Backspace');
    assert.deepEqual((await state()).framing.situationBoldRanges, [{ start: 3, end: 8 }]);
    await selectEditorText(situation, 5); await page.keyboard.press('Enter');
    assert.equal((await state()).framing.situation, '前言 al\npha beta 结尾😀');
    assert.equal(await page.evaluate(() => { const f = window.ReadingFlowApp.getState().framing; return window.ReadingFlowCore.getTextRuns(f.situation, f.situationBoldRanges).filter(run => run.bold).map(run => run.text).join('').replace(/\n/g, ''); }), 'alpha');
    assert.equal((await state()).framing.complication, '原因 gamma delta 未知');
    assert.deepEqual((await state()).framing.complicationBoldRanges, [{ start: 3, end: 8 }]);
    pass('editing and line breaks inside bold background text preserve UTF-16 ranges without leaking into conflict');

    const beforeCross = await state();
    for (const target of ['#framing-complication', '[data-node-id="root"] .node-text']) {
      await situation.evaluate((editor, target) => {
        editor.focus(); const other = document.querySelector(target);
        const text = element => document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange(); range.setStart(text(editor), 0); range.setEnd(text(other), 2);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }, target);
      await page.locator('#node-bold').evaluate(button => button.click());
      await page.keyboard.press('Control+b');
      assert.deepEqual((await state()).framing, beforeCross.framing);
      assert.deepEqual((await state()).pyramid, beforeCross.pyramid);
    }
    pass('selections spanning background, conflict or a pyramid node cannot format multiple editors');

    const formatted = (await state()).framing;
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.deepEqual(await page.evaluate(() => window.__savedState.framing), formatted);
    await page.locator('#more-toggle').click(); await page.locator('#backup-export').click();
    await page.waitForFunction(() => window.__backup && window.__backup.item.key === 'FRAMEB01');
    assert.deepEqual(await page.evaluate(() => window.__backup.framing), formatted);
    await situation.fill('临时替换文字');
    await page.evaluate(() => { window.__import = JSON.parse(JSON.stringify(window.__backup)); });
    await page.locator('#backup-import').click();
    await page.waitForFunction(text => window.ReadingFlowApp.getState().framing.situation === text && !document.getElementById('backup-import').disabled, formatted.situation);
    assert.deepEqual((await state()).framing, formatted);
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.reload(); await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    await page.evaluate(async () => { const item = { libraryID: 1, key: 'FRAMEB01', title: 'Independent annotation formatting' }; await window.ReadingFlowApp.loadConfig(window.mockConfig(item, JSON.parse(localStorage.getItem('rf-tools-test-' + item.key)))); });
    await page.locator('#pyramid-toggle').click();
    assert.deepEqual((await state()).framing, formatted);
    assert.equal(await situation.textContent(), formatted.situation);
    assert.equal(await complication.locator('b,strong').textContent(), 'gamma');
    const svg = await page.evaluate(() => {
      const document = new DOMParser().parseFromString(window.ReadingFlowCore.renderPyramidSVG(window.ReadingFlowApp.getState()), 'image/svg+xml');
      return { annotationBold: [...document.querySelectorAll('[data-role="framing-annotation"] tspan[font-weight="700"]')].map(span => span.textContent).join(''), rootBold: [...document.querySelectorAll('svg > text tspan[font-weight="700"]')].map(span => span.textContent).join('') };
    });
    assert.equal(svg.annotationBold, 'alphagamma'); assert.equal(svg.rootBold, '');
    await page.locator('#insert-pyramid').click(); await page.waitForFunction(() => window.__inserted.length === 1);
    assert.match(await page.evaluate(() => window.__inserted[0].pngDataURL), /^data:image\/png;base64,/);
    await page.screenshot({ path: path.join(output, screenshotName('v2-framing-bold')) });
    pass('annotation formatting survives autosave, JSON import/export, reload and SVG/PNG export');

    const saved = await state();
    for (const mode of ['readOnly', 'pending', 'conflict']) {
      await load(saved, mode);
      assert.equal(await situation.getAttribute('contenteditable'), 'false');
      assert.equal(await complication.getAttribute('aria-disabled'), 'true');
      const before = await state();
      await selectEditorText(situation, 3, 5); await page.keyboard.press('Control+b');
      await page.locator('#node-bold').evaluate(button => button.click());
      await situation.evaluate(editor => { editor.textContent = '不得保存的输入'; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '不得保存的输入' })); });
      assert.deepEqual((await state()).framing, before.framing);
      assert.deepEqual((await state()).pyramid, before.pyramid);
    }
    await load(saved);
    await root.fill('独立主题保持普通文字。');
    await selectEditorText(complication, 3, 8);
    await page.evaluate(() => { window.__holdSave = true; });
    await page.locator('#insert-pyramid').click(); await page.waitForFunction(() => window.__saveBlocked);
    assert.equal(await page.locator('#node-bold').isDisabled(), true);
    await selectEditorText(complication, 3, 8); await page.keyboard.press('Control+b');
    await page.locator('#node-bold').evaluate(button => button.click());
    assert.deepEqual((await state()).framing, saved.framing);
    await page.evaluate(() => { window.__holdSave = false; window.__releaseSave(); });
    await page.waitForFunction(() => !document.getElementById('insert-pyramid').disabled);
    pass('read-only and synchronization guards reject annotation writes and busy actions cannot toggle bold');
  } finally { await page.close(); }
}

async function boldEditingRegression(context) {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const root = page.locator('[data-node-id="root"] .node-text');
  const state = () => page.evaluate(() => window.ReadingFlowApp.getState());
  const ranges = async () => (await state()).pyramid.boldRanges || [];
  try {
    await page.goto(pathToFileURL(path.join(project, 'content', 'app.xhtml')).href);
    await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'BOLD001', title: 'Pyramid bold selection regression' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, null));
    });
    await page.locator('#pyramid-toggle').click();
    await root.fill('前言 alpha beta 结尾');
    await page.locator('#framing-toggle').click();
    await page.locator('#framing-situation').fill('此前研究给出多个分散的解释。');
    await page.locator('#framing-complication').fill('核心观点与支持证据的联系仍待明确。');
    await page.locator('#node-child').click();
    const siblingID = (await state()).pyramid.children[0].id;
    const sibling = page.locator('[data-node-id="' + siblingID + '"] .node-text');
    await sibling.fill('独立节点保持普通文字');
    await selectNodeText(page, 'root', 3, 8);
    await page.locator('#node-bold').click();
    assert.deepEqual(await ranges(), [{ start: 3, end: 8 }]);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'alpha');
    assert.equal(await page.locator('#node-bold').getAttribute('aria-pressed'), 'true');
    assert.deepEqual((await state()).pyramid.children[0].boldRanges || [], []);
    await page.locator('#node-bold').click();
    assert.deepEqual(await ranges(), []);
    await selectNodeText(page, 'root', 3, 8);
    await page.keyboard.press('Control+b');
    assert.deepEqual(await ranges(), [{ start: 3, end: 8 }]);
    await page.keyboard.press('Control+b');
    assert.deepEqual(await ranges(), []);
    await page.keyboard.press('Control+b');
    assert.deepEqual(await ranges(), [{ start: 3, end: 8 }]);
    pass('B and Ctrl+B toggle only selected node text and preserve its selection');

    await selectNodeText(page, 'root', 5);
    await page.keyboard.insertText('X');
    assert.equal((await state()).pyramid.text, '前言 alXpha beta 结尾');
    assert.deepEqual(await ranges(), [{ start: 3, end: 9 }]);
    await selectNodeText(page, 'root', 5, 6);
    await page.keyboard.press('Backspace');
    assert.equal((await state()).pyramid.text, '前言 alpha beta 结尾');
    assert.deepEqual(await ranges(), [{ start: 3, end: 8 }]);
    await selectNodeText(page, 'root', 5);
    await page.keyboard.press('Enter');
    assert.equal((await state()).pyramid.text, '前言 al\npha beta 结尾');
    const afterLineBreak = await ranges();
    assert.equal(await page.evaluate(() => { const node = window.ReadingFlowApp.getState().pyramid; return window.ReadingFlowCore.getTextRuns(node.text, node.boldRanges).filter(run => run.bold).map(run => run.text).join('').replace(/\n/g, ''); }), 'alpha');
    assert.deepEqual((await state()).pyramid.children[0].boldRanges || [], []);
    pass('typing, deleting and Enter within bold update plain text and UTF-16 ranges together');

    const beforeCrossSelection = (await state()).pyramid;
    await root.evaluate((editor, siblingID) => {
      editor.focus();
      const other = document.querySelector('[data-node-id="' + siblingID + '"] .node-text');
      const firstText = element => document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange(); range.setStart(firstText(editor), 0); range.setEnd(firstText(other), 2);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, siblingID);
    await page.locator('#node-bold').evaluate(button => button.click());
    assert.deepEqual((await state()).pyramid, beforeCrossSelection);
    await root.evaluate(editor => {
      editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    const pasteText = '<b>paste</b>\n普通文本';
    await root.evaluate((editor, plainText) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', plainText);
      clipboardData.setData('text/html', '<img src="invalid" onerror="window.__pasteInjected=true"><b>HTML</b>');
      const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
      if (editor.dispatchEvent(paste)) throw new Error('Plain paste was not intercepted');
    }, pasteText);
    assert.equal((await state()).pyramid.text, '前言 al\npha beta 结尾' + pasteText);
    assert.deepEqual(await ranges(), afterLineBreak);
    assert.equal(await root.locator('img,script,i').count(), 0);
    assert.equal(await page.evaluate(() => !!window.__pasteInjected), false);
    assert.equal(await sibling.textContent(), '独立节点保持普通文字');
    pass('cross-node selections cannot format siblings and paste stores only plain clipboard text');

    const formatted = (await state()).pyramid;
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.locator('#more-toggle').click(); await page.locator('#backup-export').click();
    await page.waitForFunction(() => window.__backup && window.__backup.item.key === 'BOLD001');
    assert.deepEqual(await page.evaluate(() => window.__backup.pyramid), formatted);
    await root.fill('临时替换文字');
    await page.evaluate(() => { window.__import = JSON.parse(JSON.stringify(window.__backup)); });
    await page.locator('#backup-import').click();
    await page.waitForFunction(text => window.ReadingFlowApp.getState().pyramid.text === text, formatted.text);
    assert.deepEqual((await state()).pyramid, formatted);
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.reload(); await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'BOLD001', title: 'Pyramid bold selection regression' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, JSON.parse(localStorage.getItem('rf-tools-test-' + item.key))));
    });
    await page.locator('#pyramid-toggle').click();
    assert.deepEqual((await state()).pyramid, formatted);
    assert.equal(await root.textContent(), formatted.text);
    const svg = await page.evaluate(() => {
      const document = new DOMParser().parseFromString(window.ReadingFlowCore.renderPyramidSVG(window.ReadingFlowApp.getState()), 'image/svg+xml');
      return { text: document.querySelector('svg > text').textContent, bold: [...document.querySelectorAll('text tspan[font-weight="700"],text tspan[font-weight="bold"]')].map(span => span.textContent).join('') };
    });
    assert.match(svg.text, /al/); assert.match(svg.text, /pha/);
    assert.equal(svg.bold, 'alpha');
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'BOLDVIEW', title: 'Pyramid formatting preview' }, preview = window.ReadingFlowApp.getState();
      preview.item = item;
      preview.pyramid.text = '核心结论：证据支持这一观点。\n\n关键理由：不同研究得到一致结果。'; delete preview.pyramid.boldRanges;
      preview.pyramid.children[0].text = '多个独立研究得到相近结果。';
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, preview));
    });
    await selectNodeText(page, 'root', 5, 13); await page.locator('#node-bold').click();
    assert.deepEqual(await ranges(), [{ start: 5, end: 13 }]);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.locator('#diagram-scroll').evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
    await page.screenshot({ path: path.join(output, screenshotName('v2-pyramid-bold-framing-650')) });
    pass('JSON export/import, reload and SVG retain selected bold across a newline');
  } finally { await page.close(); }
}

async function fontSizingRegression(context) {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const state = () => page.evaluate(() => window.ReadingFlowApp.getState());
  const chooseSize = size => page.getByRole('combobox', { name: '金字塔字号', exact: true }).selectOption(String(size));
  try {
    await page.goto(pathToFileURL(path.join(project, 'content', 'app.xhtml')).href);
    await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'FONT0001', title: 'Pyramid font size regression' }, initial = window.ReadingFlowCore.createSession(item);
      initial.pyramid.text = 'HgH\nA clear conclusion supported by the evidence. 中文主题😀';
      initial.pyramid.boldRanges = [{ start: 0, end: 3 }];
      initial.framing.situation = 'Prior research gives conflicting explanations.';
      initial.framing.complication = 'The relation between observations and causes remains uncertain.';
      for (const [group, count] of [4, 3, 3].entries()) {
        const branch = window.ReadingFlowCore.addNode(initial, 'root');
        branch.text = 'Argument ' + group + ': evidence from repeated measurements supports this conclusion. '.repeat(3);
        for (let leaf = 0; leaf < count; leaf++) window.ReadingFlowCore.addNode(initial, branch.id).text = 'Evidence ' + leaf + ': independent field observations reveal consistent changes over time. '.repeat(6);
      }
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, initial));
    });
    await page.locator('#pyramid-toggle').click();
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '14');
    assert.deepEqual(await page.locator('#pyramid-font-size option').evaluateAll(options => options.map(option => Number(option.value))), [10, 12, 14, 16, 18, 20, 24, 28, 32]);
    assert.equal(await page.evaluate(() => document.getElementById('node-bold').nextElementSibling.contains(document.getElementById('pyramid-font-size'))), true);
    await selectNodeText(page, 'root', 4, 5);
    const boldBefore = (await state()).pyramid.boldRanges;
    await page.evaluate(() => { window.__fontRoot = document.querySelector('[data-node-id="root"] .node-text'); });
    await chooseSize(24);
    assert.equal((await state()).pyramidFontSize, 24);
    assert.deepEqual((await state()).pyramid.boldRanges, boldBefore);
    assert.equal(await page.evaluate(() => window.__fontRoot === document.querySelector('[data-node-id="root"] .node-text')), true, 'changing size preserves the live editor and selection anchors');
    const editorSizes = await page.locator('.node-text,.framing-field textarea').evaluateAll(editors => [...new Set(editors.map(editor => getComputedStyle(editor).fontSize))]);
    assert.deepEqual(editorSizes, ['24px']);
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.equal(await page.evaluate(() => window.__savedState.pyramidFontSize), 24);
    pass('size control beside bold changes every node and background annotation while retaining live text and bold ranges');

    const exportPixels = async size => {
      await chooseSize(size);
      const layout = await page.evaluate(() => window.ReadingFlowCore.layoutPyramid(window.ReadingFlowApp.getState()));
      const previous = await page.evaluate(() => window.__inserted.length);
      await page.locator('#insert-pyramid').click();
      await page.waitForFunction(count => window.__inserted.length > count && !document.getElementById('insert-pyramid').disabled, previous);
      const image = await page.evaluate(() => window.__inserted.at(-1));
      const inkHeight = await page.evaluate(async ({ layout, image }) => {
        const img = document.createElement('img'); img.src = image.pngDataURL; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(img, 0, 0);
        const root = layout.nodes[0], sx = image.width / layout.width, sy = image.height / layout.height;
        // Inspect only the first text line, away from the black card border and connecting lines.
        const x = Math.ceil((root.x + 12) * sx), y = Math.ceil((root.y + 3) * sy);
        const width = Math.floor((root.width - 24) * sx), height = Math.floor((layout.baselineOffset + layout.fontSize * 0.25 - 3) * sy);
        const pixels = context.getImageData(x, y, width, height).data, rows = [];
        for (let row = 0; row < height; row++) {
          for (let col = 0; col < width; col++) {
            const offset = (row * width + col) * 4;
            if (pixels[offset] < 128 && pixels[offset + 1] < 128 && pixels[offset + 2] < 128 && pixels[offset + 3] > 200) { rows.push(row); break; }
          }
        }
        if (!rows.length) throw new Error('Exported first-line glyphs were absent from the PNG');
        return rows.at(-1) - rows[0] + 1;
      }, { layout, image });
      assert.ok(image.width <= 4096 && image.height <= 4096 && image.width * image.height <= 8000000, 'PNG remains within its documented bounds: ' + image.width + '×' + image.height + '=' + image.width * image.height);
      fs.writeFileSync(path.join(output, screenshotName('pyramid-font-' + size)), Buffer.from(image.pngDataURL.split(',')[1], 'base64'));
      return { ...image, layout, inkHeight, fittedInkHeight: inkHeight * Math.min(1, 1200 / image.width) };
    };
    const normal = await exportPixels(14), large = await exportPixels(32);
    assert.equal(large.layout.width, normal.layout.width);
    assert.ok(large.inkHeight > normal.inkHeight * 1.5, 'actual rasterized glyphs grow on a broad ten-leaf diagram');
    assert.ok(large.fittedInkHeight > normal.fittedInkHeight * 1.5, 'PNG caps and fitting the full diagram into a 1200px note do not cancel the chosen size');
    fs.writeFileSync(path.join(output, 'pyramid-font-render-metrics-' + version + '.json'), JSON.stringify([normal, large].map(value => ({ fontSize: value.layout.fontSize, diagramWidth: value.layout.width, diagramHeight: value.layout.height, pngWidth: value.width, pngHeight: value.height, inkHeight: value.inkHeight, fittedInkHeight: value.fittedInkHeight })), null, 2));
    pass('exported ten-leaf PNG contains visibly larger glyph pixels after rasterization and note-width fitting');

    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.locator('#more-toggle').click(); await page.locator('#backup-export').click();
    assert.equal(await page.evaluate(() => window.__backup.pyramidFontSize), 32);
    await chooseSize(10);
    await page.evaluate(() => { window.__import = JSON.parse(JSON.stringify(window.__backup)); });
    await page.locator('#backup-import').click();
    await page.waitForFunction(() => window.ReadingFlowApp.getState().pyramidFontSize === 32 && !document.getElementById('pyramid-font-size').disabled);
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '32');
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.reload(); await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'FONT0001', title: 'Pyramid font size regression' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, JSON.parse(localStorage.getItem('rf-tools-test-' + item.key))));
    });
    await page.locator('#pyramid-toggle').click();
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '32');
    assert.equal((await state()).pyramidFontSize, 32);
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'FONT0002', title: 'Another note keeps its own size' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, null));
    });
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '14');
    await chooseSize(20);
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'FONT0001', title: 'Pyramid font size regression' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, JSON.parse(localStorage.getItem('rf-tools-test-' + item.key))));
    });
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '32');
    assert.deepEqual((await state()).pyramid.boldRanges, boldBefore);
    pass('each note restores its own size through autosave, JSON import/export, reload and note switching');
  } finally { await page.close(); }
}

async function resizingIframeRegression(browser) {
  const fixtureSource = pathToFileURL(path.join(process.env.READING_FLOW_TEST_RESIZE_CONTENT || path.join(project, 'content'), 'app.xhtml')).href;
  const hostHTML = '<!doctype html><meta charset="utf-8"><style>body{margin:0}#panel{display:flex;flex-direction:column;width:730px;height:600px}iframe{border:0;width:100%;height:58px;flex:none}#native{flex:1;min-height:80px;background:#eee}</style><div id="panel"><iframe id="toolsFrame" src="' + fixtureSource + '"></iframe><div id="native"></div></div><script>' +
    'window.fixtureSource=' + JSON.stringify(fixtureSource) + ';' +
    'window.requests=[];window.ready=false;window.latestState=null;const panel=document.getElementById("panel"),frame=document.getElementById("toolsFrame");' +
    'window.allocate=()=>{const h=panel.getBoundingClientRect().height;const reserve=Math.min(160,Math.max(80,Math.round(h*.3)));const cap=Math.max(58,Math.min(Math.floor(h*.65),Math.floor(h-reserve)));window.allocated=Math.max(58,Math.min(window.requested||58,cap));frame.style.height=window.allocated+"px";return window.allocated;};' +
    'new ResizeObserver(window.allocate).observe(panel);window.addEventListener("resize",window.allocate);' +
    'frame.onload=async()=>{window.ready=false;const win=frame.contentWindow,item={libraryID:1,key:"FRAME001",title:"Dynamic iframe regression"};const initial=window.latestState||win.ReadingFlowCore.createSession(item);if(!window.latestState){initial.framing.question="为什么金字塔应保持可用的展开高度？";initial.pyramid.text="工具所需高度应与宿主分配高度分别计算。";}' +
    'const config={item,initialState:initial,bridge:{canEdit:true,saveDraft:async state=>{window.latestState=JSON.parse(JSON.stringify(state));},flushState:state=>{window.latestState=JSON.parse(JSON.stringify(state));},resizeTools:height=>{window.requested=Math.max(58,Math.ceil(height));window.requests.push(window.requested);return window.allocate();},exportJSON:async()=>({message:"已导出"}),importJSON:async()=>null}};' +
    'await win.ReadingFlowApp.loadConfig(config);if(!win.ReadingFlowApp.getSizing){win.ReadingFlowApp.getSizing=()=>{const t=win.document.getElementById("tools"),s=win.document.getElementById("diagram-scroll"),d=win.document.getElementById("diagram"),cs=win.getComputedStyle(s);return {requestedHeight:window.requested,allocatedHeight:window.allocated,intrinsicHeaderHeight:t.getBoundingClientRect().height-s.getBoundingClientRect().height,naturalDiagramHeight:d.getBoundingClientRect().height+parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom)+1,diagramViewportHeight:s.getBoundingClientRect().height};};}window.ready=true;};<\/script>';
  const fixturePath = path.join(output, 'tools-resize-test-fixture.html');
  fs.writeFileSync(fixturePath, hostHTML);
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(pathToFileURL(fixturePath).href);
    await page.waitForFunction(() => window.ready);
    const toolsFrame = async () => (await page.locator('#toolsFrame').elementHandle()).contentFrame();
    let frame = await toolsFrame();
    await frame.locator('#more-toggle').click(); await frame.locator('#checklist-toggle').click(); await frame.locator('#pyramid-toggle').click();
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight >= 100);
    const initial = await page.evaluate(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing());
    assert.ok(initial.requestedHeight >= Math.min(500, initial.intrinsicHeaderHeight + Math.min(initial.naturalDiagramHeight, 380)) - 1);
    await page.evaluate(() => { document.getElementById('panel').style.height = '468px'; });
    await page.waitForFunction(() => window.allocated === 304);
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight >= 100);
    const afterShort = await page.evaluate(() => ({ requests: window.requests.slice(), desired: window.requested, actual: window.allocated, sizing: document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing() }));
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => window.requested), afterShort.desired);
    assert.equal(await page.evaluate(() => window.allocated), 304);
    assert.equal(await frame.locator('#diagram-scroll').evaluate(node => node.clientHeight >= 100), true);
    assert.ok(await page.locator('#native').evaluate(node => node.getBoundingClientRect().height >= 100));
    pass('real 730px iframe allocation stays stable with all menus open in a 468px panel');

    const beforeManual = await page.evaluate(() => window.requested);
    await frame.getByRole('textbox', { name: '疑问／回答', exact: true }).evaluate(node => { node.style.height = '150px'; });
    await page.waitForFunction(before => window.requested > before, beforeManual);
    assert.equal(await page.evaluate(() => window.allocated), 304);
    await page.evaluate(() => { document.getElementById('panel').style.width = '430px'; });
    await frame.locator('#node-child').click(); await frame.getByRole('textbox', { name: '节点内容', exact: true }).fill('即使工具的视口被宿主限制，固有高度也不会跟着缩小。');
    await frame.locator('#node-sibling').click();
    await frame.getByRole('textbox', { name: '节点内容', exact: true }).nth(1).fill('扩展节点后仍能在图内滚动。');
    await frame.locator('#node-child').click();
    await page.waitForFunction(() => window.requested === 500);
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => window.requested), 500);
    assert.equal(await frame.locator('#diagram-scroll').evaluate(node => node.clientHeight >= 100), true);
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await frame.locator('#diagram-scroll').evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
    await page.locator('#toolsFrame').screenshot({ path: path.join(output, screenshotName('v2-iframe-all-menus-430')) });
    pass('intrinsic tree observer tracks node editor resizing and child additions without shrinking the allocated frame');
    await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.showNotice('隐藏侧栏的尺寸检查'); });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.requested), 500);
    await page.evaluate(() => { document.getElementById('panel').style.display = 'flex'; });
    await page.waitForFunction(() => window.allocated === 304);
    assert.equal(await frame.locator('#diagram-scroll').evaluate(node => node.clientHeight >= 100), true);
    pass('hiding a sidebar preserves its intrinsic request and reopening retains usable pyramid space');

    await frame.locator('#more-toggle').click(); await frame.locator('#checklist-toggle').click();
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight >= 180);
    await frame.locator('#pyramid-toggle').click();
    await page.waitForFunction(() => window.allocated === 58);
    await frame.locator('#pyramid-toggle').click();
    await page.waitForFunction(() => window.allocated === 304);
    assert.equal(await frame.locator('#diagram-scroll').evaluate(node => node.clientHeight >= 180), true);
    await page.evaluate(() => { document.getElementById('panel').style.height = '800px'; document.getElementById('panel').style.width = '730px'; });
    await page.waitForFunction(() => window.allocated >= 430);
    assert.equal(await frame.locator('#diagram-scroll').evaluate(node => node.clientHeight >= 350), true);
    pass('closing auxiliary menus, reopening the pyramid and growing the native panel restore usable diagram space');

    await frame.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.evaluate(() => { window.ready = false; document.getElementById('toolsFrame').src = window.fixtureSource + '?reopen=1'; });
    await page.waitForFunction(() => window.ready);
    frame = await toolsFrame();
    await frame.locator('#pyramid-toggle').click();
    assert.equal(await frame.evaluate(() => window.ReadingFlowApp.getState().pyramid.children.length), 2);
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight >= 350);
    pass('a newly loaded tools frame restores its saved hierarchy and expands without resize feedback');
  } catch (error) {
    if (process.env.READING_FLOW_TEST_RESIZE_CONTENT) {
      const evidence = await page.evaluate(() => ({ requested: window.requested, allocated: window.allocated, requests: window.requests, sizing: document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing() }));
      fs.writeFileSync(path.join(output, 'resize-legacy-repro.json'), JSON.stringify(evidence, null, 2));
      console.log('LEGACY RESIZE REPRO ' + JSON.stringify(evidence));
    }
    throw error;
  } finally { await context.close(); fs.unlinkSync(fixturePath); }
}

async function manualHeightRegression(browser) {
  const fixtureSource = pathToFileURL(path.join(project, 'content', 'app.xhtml')).href;
  const fixturePath = path.join(output, 'tools-manual-height-test-fixture.html');
  const hostHTML = '<!doctype html><meta charset="utf-8"><style>body{margin:0}#panel{display:flex;flex-direction:column;width:730px;height:600px}iframe{border:0;width:100%;height:58px;flex:none}#native{flex:1;min-height:80px;background:#eee;padding:12px;box-sizing:border-box;font:14px sans-serif}</style><div id="panel"><iframe id="toolsFrame" src="' + fixtureSource + '"></iframe><div id="native">原生笔记编辑器</div></div><script>' +
    'window.fixtureSource=' + JSON.stringify(fixtureSource) + ';window.ready=false;window.latestState=null;window.heightPreference=null;window.heightSaves=[];window.requests=[];' +
    'const panel=document.getElementById("panel"),frame=document.getElementById("toolsFrame");' +
    'window.allocate=()=>{const h=panel.getBoundingClientRect().height;if(h===0)return window.allocated;const reserve=Math.min(160,Math.max(80,Math.round(h*.3)));const cap=Math.max(58,Math.min(window.manual?Infinity:Math.floor(h*.65),Math.floor(h-reserve)));window.allocated=Math.max(58,Math.min(window.requested||58,cap));frame.style.height=window.allocated+"px";return window.allocated;};' +
    'new ResizeObserver(window.allocate).observe(panel);window.addEventListener("resize",window.allocate);' +
    'window.configure=async(readOnly=false,key="HEIGHT001")=>{const win=frame.contentWindow,item={libraryID:1,key,title:"Manual pyramid display height"},initial=window.latestState&&window.latestState.item.key===key?window.latestState:win.ReadingFlowCore.createSession(item);' +
    'await win.ReadingFlowApp.loadConfig({item,initialState:initial,readOnly,pyramidHeight:window.heightPreference,bridge:{canEdit:!readOnly,saveDraft:async state=>{window.latestState=JSON.parse(JSON.stringify(state));},flushState:state=>{window.latestState=JSON.parse(JSON.stringify(state));},savePyramidHeight:value=>{window.heightPreference=value;window.heightSaves.push(value);return value;},resizeTools:(height,options={})=>{window.requested=Math.max(58,Math.ceil(height));if(Object.hasOwn(options,"manual"))window.manual=options.manual;window.requests.push({height:window.requested,manual:window.manual});return window.allocate();}}});};' +
    'frame.onload=async()=>{window.ready=false;await window.configure();window.ready=true;};<\/script>';
  fs.writeFileSync(fixturePath, hostHTML);
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const sizing = () => page.evaluate(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing());
  const frameNow = async () => (await page.locator('#toolsFrame').elementHandle()).contentFrame();
  const waitManual = value => page.waitForFunction(expected => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().manualHeight === expected, value);
  const dragDivider = async (frame, pixels) => {
    const box = await frame.locator('#pyramid-resizer').boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'The divider must be visible and draggable');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + pixels, { steps: 8 }); await page.mouse.up();
  };
  try {
    await page.goto(pathToFileURL(fixturePath).href); await page.waitForFunction(() => window.ready);
    let frame = await frameNow(); await frame.locator('#pyramid-toggle').click();
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight > 100);
    assert.equal((await sizing()).manualHeight, null);
    assert.equal(await frame.locator('#pyramid-resizer').getAttribute('role'), 'separator');
    assert.equal(await frame.locator('#pyramid-resizer').getAttribute('aria-orientation'), 'horizontal');
    const auto = await sizing();
    await dragDivider(frame, 140);
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().manualHeight !== null);
    const grown = await sizing();
    assert.ok(grown.manualHeight >= auto.diagramViewportHeight + 130);
    assert.ok(grown.diagramViewportHeight >= auto.diagramViewportHeight + 125);
    await page.waitForTimeout(250);
    assert.equal((await sizing()).manualHeight, grown.manualHeight);
    assert.ok((await sizing()).diagramViewportHeight > auto.naturalDiagramHeight + 100);
    await dragDivider(frame, -80); const shrunk = await sizing();
    assert.ok(shrunk.manualHeight <= grown.manualHeight - 70);
    assert.ok(shrunk.diagramViewportHeight <= grown.diagramViewportHeight - 70);
    assert.ok(await page.locator('#native').evaluate(node => node.getBoundingClientRect().height >= 160));
    pass('dragging the divider grows and shrinks an empty pyramid viewport without resizing its text boxes');

    await frame.locator('#pyramid-resizer').focus(); await page.keyboard.press('ArrowDown');
    await waitManual(shrunk.manualHeight + 20);
    await page.keyboard.press('Shift+ArrowUp'); await waitManual(Math.max(64, shrunk.manualHeight - 60));
    const keyboardHeight = (await sizing()).manualHeight;
    await frame.getByRole('textbox', { name: '疑问／回答', exact: true }).fill('保持独立的窗口高度');
    await frame.locator('#node-child').click();
    await frame.getByRole('textbox', { name: '节点内容', exact: true }).fill('新增节点时，滚动区域高度保持用户设置。');
    assert.equal((await sizing()).manualHeight, keyboardHeight);
    await frame.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.equal(await page.evaluate(() => window.heightPreference), keyboardHeight);
    await page.evaluate(() => { window.ready=false; document.getElementById('toolsFrame').src=window.fixtureSource+'?height-reload=1'; });
    await page.waitForFunction(() => window.ready); frame = await frameNow();
    await frame.locator('#pyramid-toggle').click(); await waitManual(keyboardHeight);
    assert.equal(await frame.evaluate(() => window.ReadingFlowApp.getState().pyramid.children[0].text), '新增节点时，滚动区域高度保持用户设置。');
    await page.evaluate(() => window.configure(true, 'HEIGHTREADONLY'));
    assert.equal(await frame.getByRole('textbox', { name: '疑问／回答', exact: true }).getAttribute('contenteditable'), 'false');
    await frame.locator('#pyramid-resizer').focus(); await page.keyboard.press('ArrowDown'); await waitManual(keyboardHeight + 20);
    assert.equal(await page.evaluate(() => window.heightPreference), keyboardHeight + 20);
    pass('keyboard adjustment and display preference survive reloads and remain usable for read-only notes');

    await page.evaluate(() => window.configure(false, 'HEIGHT002'));
    assert.equal((await sizing()).manualHeight, keyboardHeight + 20);
    await frame.locator('#pyramid-resizer').focus();
    for (let i=0; i<8; i++) await page.keyboard.press('Shift+ArrowDown');
    const large = await sizing(); assert.ok(large.manualHeight > 600);
    await page.waitForFunction(() => window.allocated === 440);
    assert.ok(await page.locator('#native').evaluate(node => node.getBoundingClientRect().height >= 160));
    assert.ok((await sizing()).diagramViewportHeight < large.manualHeight);
    await page.evaluate(() => { document.getElementById('panel').style.height='300px'; });
    await page.waitForFunction(() => window.allocated === 210);
    assert.equal((await sizing()).manualHeight, large.manualHeight);
    assert.equal(await page.evaluate(() => window.requested), large.requestedHeight);
    assert.ok(await page.locator('#native').evaluate(node => node.getBoundingClientRect().height >= 80));
    assert.equal(await frame.evaluate(() => document.documentElement.scrollHeight > innerHeight), false);
    await page.evaluate(() => { document.getElementById('panel').style.display='none'; }); await page.waitForTimeout(150);
    assert.equal((await sizing()).manualHeight, large.manualHeight);
    await page.evaluate(() => { const panel=document.getElementById('panel');panel.style.height='1200px';panel.style.display='flex'; });
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight >= window.heightPreference - 2);
    assert.equal((await sizing()).manualHeight, large.manualHeight);
    await frame.locator('#pyramid-toggle').click(); await page.waitForFunction(() => window.allocated === 58);
    assert.equal((await sizing()).manualHeight, large.manualHeight);
    await frame.locator('#pyramid-toggle').click();
    await page.waitForFunction(() => document.getElementById('toolsFrame').contentWindow.ReadingFlowApp.getSizing().diagramViewportHeight >= window.heightPreference - 2);
    await page.locator('#toolsFrame').screenshot({ path:path.join(output, screenshotName('v2-pyramid-manual-height-730')) });
    pass('manual height respects the visible panel cap, preserves note space and restores after hiding or collapsing');

    await frame.locator('#pyramid-resizer').focus(); await page.keyboard.press('Home'); await waitManual(null);
    assert.equal(await page.evaluate(() => window.heightPreference), null);
    await page.waitForFunction(() => window.requested < 250);
    await dragDivider(frame, 100); assert.notEqual((await sizing()).manualHeight, null);
    await frame.locator('#pyramid-resizer').dblclick(); await waitManual(null);
    assert.equal(await page.evaluate(() => window.heightPreference), null);
    pass('Home and double-click restore automatic content sizing and clear the saved display preference');
  } finally { await context.close(); fs.unlinkSync(fixturePath); }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browserOptions = { headless: true, args: ['--allow-file-access-from-files'] };
  if (process.env.CHROME_BINARY) browserOptions.executablePath = path.resolve(process.env.CHROME_BINARY);
  // Playwright locates installed Chrome on each supported OS when its bundled browser is absent.
  else if (!fs.existsSync(chromium.executablePath())) browserOptions.channel = 'chrome';
  const browser = await chromium.launch(browserOptions);
  try {
    const context = await browser.newContext({ viewport: { width: 650, height: 500 }, acceptDownloads: true });
    await context.addInitScript(() => {
      const actualNow = Date.now.bind(Date); window.__timeOffset = 0; Date.now = () => actualNow() + window.__timeOffset;
      window.__saves = []; window.__heightCalls = []; window.__inserted = [];
      window.mockConfig = (item, initialState, readOnly = false) => ({ item, initialState, readOnly, bridge: {
        canEdit: !readOnly,
        async saveDraft(state) { await new Promise(resolve => setTimeout(resolve, 25)); if (window.__holdSave) { window.__saveBlocked = true; await new Promise(resolve => { window.__releaseSave = resolve; }); } if (window.__failSave) throw new Error('模拟保存失败'); window.__saves.push(state); window.__savedState = state; localStorage.setItem('rf-tools-test-' + item.key, JSON.stringify(state)); },
        flushState(state) { localStorage.setItem('rf-tools-test-' + item.key, JSON.stringify(state)); },
        resizeTools(height) { window.__heightCalls.push(height); },
        async insertPyramid(image) { window.__inserted.push(image); return { message: '金字塔已插入原生笔记' }; },
        async exportJSON(state) { if (window.__cancelBackup) return { cancelled: true }; window.__backup = state; return { message: '已导出备份' }; },
        async importJSON() { if (window.__holdImport) { window.__importBlocked = true; await new Promise(resolve => { window.__releaseImport = resolve; }); } return window.__import || null; }
      } });
      const item = { libraryID: 1, key: 'PAPER001', title: 'Native reader tools test' };
      window.ReadingFlowConfig = window.mockConfig(item, JSON.parse(localStorage.getItem('rf-tools-test-' + item.key) || 'null'));
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto(pathToFileURL(path.join(project, 'content', 'app.xhtml')).href);
    await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    assert.equal(await page.evaluate(() => document.contentType), 'application/xhtml+xml');
    assert.equal(await page.locator('#diagram .node-text').first().evaluate(input => input.namespaceURI), 'http://www.w3.org/1999/xhtml');
    assert.equal(await page.locator('h1,h2,.sidebar,.tabs,.card').count(), 0);
    assert.equal(await page.locator('[contenteditable]:not(.node-text)').count(), 0);
    assert.equal(await page.locator('#pyramid-area').isVisible(), false);
    assert.equal(await page.locator('#checklist-area').isVisible(), false);
    assert.ok(await page.evaluate(() => window.__heightCalls[window.__heightCalls.length - 1] <= 62));
    pass('XHTML compact tools default to one grayscale row without a webpage note editor');
    await page.setViewportSize({ width: 430, height: 62 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(output, screenshotName('v2-tools-collapsed-430')) });
    pass('collapsed tools fit a realistic 430px native sidebar');
    await page.setViewportSize({ width: 650, height: 500 });

    await page.locator('#start-inspection').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.inspection.status), 'running');
    await page.locator('#timer-pause').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.inspection.status), 'paused');
    await page.locator('#timer-pause').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.inspection.status), 'running');
    await page.evaluate(() => { window.__timeOffset = 601000; });
    await page.waitForFunction(() => window.ReadingFlowApp.getState().timers.inspection.status === 'expired');
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.analysis.status), 'idle');
    assert.equal(await page.locator('#timer-time').textContent(), '00:00');
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.match(await page.locator('#status').textContent(), /10 分钟到了/);
    await page.locator('#start-analysis').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.analysis.status), 'running');
    await page.locator('#timer-reset').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.analysis.status), 'idle');
    await page.evaluate(() => { window.__timeOffset = 0; });
    pass('timers pause, resume, reset and expire without automatically starting the next timer');

    await page.locator('#checklist-toggle').click();
    assert.equal(await page.locator('#inspection-checks input').count(), 6);
    await page.locator('#inspection-checks input').nth(2).check();
    await page.locator('#inspection-completed').check();
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.equal(await page.evaluate(() => window.__savedState.inspection.checklist[2]), true);
    assert.equal(await page.evaluate(() => window.__savedState.inspection.completed), true);
    assert.equal(await page.evaluate(() => window.__savedState.inspection.classified), false);
    await page.screenshot({ path: path.join(output, screenshotName('v2-checklist-650')), clip: { x: 0, y: 0, width: 650, height: 140 } });
    await page.locator('#checklist-toggle').click();
    pass('six inspection checks and completion save independently from external classification');

    await page.evaluate(async () => {
      const legacy = window.ReadingFlowApp.getState();
      legacy.framing.question = '怎样把文章的论证结构组织得清楚？';
      legacy.pyramid.text = '用一个核心回答统领论点，并用具体理由支撑论点。';
      legacy.inspection.question = '独立保留的检视问题';
      await window.ReadingFlowApp.loadConfig(window.mockConfig(legacy.item, legacy));
    });
    const mergedRoot = '怎样把文章的论证结构组织得清楚？\n\n用一个核心回答统领论点，并用具体理由支撑论点。';
    await page.locator('#pyramid-toggle').click();
    assert.equal(await page.locator('[data-node-id="root"] .node-text').count(), 1);
    assert.equal(await page.locator('[data-node-id="root"] .node-heading').textContent(), '疑问／回答');
    assert.equal(await page.getByRole('textbox', { name: '科学问题', exact: true }).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).textContent(), mergedRoot);
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().framing.question), '');
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().inspection.question), '独立保留的检视问题');
    await page.getByRole('textbox', { name: '疑问／回答', exact: true }).fill(mergedRoot);
    pass('legacy root fields merge into one multiline textbox without losing the independent inspection question');
    const situation = '现有研究把论证分散在多个段落。', complication = '核心观点与证据之间的关系仍不清楚。';
    await page.locator('#framing-toggle').click();
    await page.locator('#framing-situation').fill(situation);
    await page.locator('#framing-complication').fill(complication);
    assert.equal(await page.locator('.root-wrap > .node > .node-text').count(), 1);
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).textContent(), mergedRoot);
    const framingGeometry = await page.evaluate(() => {
      const root = document.querySelector('.root-wrap > .node').getBoundingClientRect(), annotation = document.querySelector('.framing-note').getBoundingClientRect();
      return { rootWidth: root.width, annotationWidth: annotation.width, separated: annotation.right <= root.left || root.right <= annotation.left || annotation.bottom <= root.top || root.bottom <= annotation.top };
    });
    assert.ok(framingGeometry.rootWidth > 0 && framingGeometry.annotationWidth > 0 && framingGeometry.separated);
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.equal(await page.evaluate(() => window.__savedState.framing.situation), situation);
    assert.equal(await page.evaluate(() => window.__savedState.framing.complication), complication);
    pass('background and complication save in a separate annotation beside the single core text box');
    await page.locator('#node-child').click();
    let ids = await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.children.map(n => n.id));
    const first = ids[0], card = id => page.locator('[data-node-id="' + id + '"]');
    await card(first).locator('.node-text').fill('上层概括下层，保持纵向的问答关系。');
    await page.locator('#node-sibling').click();
    ids = await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.children.map(n => n.id));
    const second = ids[1];
    await card(second).locator('.node-text').fill('同一组的思想按清晰的逻辑顺序排列。');
    await card(first).locator('.node-text').focus();
    await page.locator('#node-child').click();
    const reason = await page.evaluate(first => window.ReadingFlowApp.getState().pyramid.children.find(n => n.id === first).children[0].id, first);
    await card(reason).locator('.node-text').fill('读者可以从核心结论继续追问“为什么”。');
    await card(first).locator('.node-text').focus();
    await page.locator('#node-down').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.children[1].id), first);
    await page.locator('#node-up').click();
    await card(second).locator('.node-text').focus();
    await page.locator('#node-sibling').click();
    await page.locator('#node-delete').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.children.length), 2);
    assert.ok(await page.evaluate(() => window.__heightCalls[window.__heightCalls.length - 1] <= 500));
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    await page.locator('#diagram-scroll').evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
    await page.screenshot({ path: path.join(output, screenshotName('v2-pyramid-tools-650')) });
    await page.setViewportSize({ width: 430, height: 500 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.ok(await page.locator('#diagram-scroll').evaluate(node => node.scrollWidth >= node.clientWidth));
    await page.screenshot({ path: path.join(output, screenshotName('v2-pyramid-tools-430')) });
    await page.setViewportSize({ width: 430, height: 200 });
    await page.waitForFunction(() => document.getElementById('diagram-scroll').getBoundingClientRect().height < 130);
    assert.ok(await page.locator('#insert-pyramid').evaluate(node => node.getBoundingClientRect().bottom < window.innerHeight));
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), false);
    await page.setViewportSize({ width: 430, height: 500 });
    pass('black rectangle pyramid edits, branches, reorders and deletes inside a scrolling 430–650px tools panel');
    await page.locator('#diagram-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await page.locator('#framing-toggle').click();
    await page.locator('#diagram-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await page.locator('#framing-toggle').click();
    await page.waitForFunction(() => {
      const note = document.querySelector('.framing-note').getBoundingClientRect(), viewport = document.getElementById('diagram-scroll').getBoundingClientRect();
      return note.left >= viewport.left - 1 && note.right <= viewport.right + 1;
    });
    assert.equal(await page.locator('.root-wrap > .node > .node-text').count(), 1);
    assert.equal(await page.locator('#framing-situation').textContent(), situation);
    assert.equal(await page.locator('#framing-complication').textContent(), complication);
    pass('background toggle reveals the annotation in a horizontally scrolled 430px tree');

    await page.locator('#insert-pyramid').click();
    await page.waitForFunction(() => window.__inserted.length === 1);
    const image = await page.evaluate(() => window.__inserted[0]);
    const svgRootText = await page.evaluate(() => new DOMParser().parseFromString(window.ReadingFlowCore.renderPyramidSVG(window.ReadingFlowApp.getState()), 'image/svg+xml').querySelector('svg > text').textContent);
    assert.equal((svgRootText.match(/怎样把文章的论证结构组织得清楚/g) || []).length, 1);
    assert.equal((svgRootText.match(/用一个核心回答统领论点/g) || []).length, 1);
    const svgFraming = await page.evaluate(() => new DOMParser().parseFromString(window.ReadingFlowCore.renderPyramidSVG(window.ReadingFlowApp.getState()), 'image/svg+xml').querySelector('[data-role="framing-annotation"]').textContent);
    assert.ok(svgFraming.includes(situation) && svgFraming.includes(complication));
    assert.match(image.pngDataURL, /^data:image\/png;base64,/); assert.ok(image.width <= 4096 && image.height <= 4096 && image.width * image.height <= 8000000);
    fs.writeFileSync(path.join(output, screenshotName('v2-pyramid-insert')), Buffer.from(image.pngDataURL.split(',')[1], 'base64'));
    pass('explicit insertion rasterizes the full black diagram to a white-background PNG object');

    await page.reload(); await page.waitForFunction(() => window.ReadingFlowApp && window.ReadingFlowApp.getState());
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.children[0].children[0].text), '读者可以从核心结论继续追问“为什么”。');
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().inspection.completed), true);
    await page.locator('#pyramid-toggle').click();
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).textContent(), mergedRoot);
    assert.equal(await page.locator('[data-node-id="root"] .node-text').count(), 1);
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().framing.question), '');
    assert.equal(await page.locator('#framing-situation').textContent(), situation);
    assert.equal(await page.locator('#framing-complication').textContent(), complication);
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().framing.situation), situation);
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().framing.complication), complication);
    pass('autosaved tools reload with the complete pyramid and six-step inspection state');

    await page.evaluate(() => { window.__failSave = true; });
    await page.getByRole('textbox', { name: '疑问／回答', exact: true }).fill('保存失败时仍可以导出备份');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('保存失败'));
    await page.locator('#more-toggle').click(); await page.locator('#backup-export').click();
    await page.waitForFunction(() => window.__backup && window.__backup.pyramid.text === '保存失败时仍可以导出备份');
    assert.match(await page.locator('#status').textContent(), /已导出备份；本机记录仍未保存/);
    await page.evaluate(() => { window.__cancelBackup = true; }); await page.locator('#backup-export').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('已取消导出'));
    assert.doesNotMatch(await page.locator('#status').textContent(), /已导出备份/);
    await page.evaluate(() => { window.__failSave = false; window.__cancelBackup = false; }); await page.locator('#status').click();
    await page.waitForFunction(() => window.__savedState && window.__savedState.pyramid.text === '保存失败时仍可以导出备份');
    pass('quiet save error can retry or export a backup; cancelled exports report no success');

    await page.evaluate(() => { window.__import = window.ReadingFlowApp.getState(); window.__import.pyramid.text = '导入后的核心回答'; });
    await page.locator('#backup-import').click();
    await page.waitForFunction(() => window.__savedState.pyramid.text === '导入后的核心回答');
    pass('optional JSON import is tucked into the overflow menu');

    await page.evaluate(async () => {
      const data = window.ReadingFlowApp.getState(), config = window.mockConfig(data.item, data, true);
      window.dispatchEvent(new CustomEvent('reading-flow-config', { detail: config }));
    });
    await page.waitForFunction(() => document.getElementById('mode-label').textContent === '只读');
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).getAttribute('contenteditable'), 'false');
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#node-bold').isDisabled(), true);
    assert.equal(await page.locator('#pyramid-font-size').isDisabled(), true);
    const readOnlySize = await page.evaluate(() => window.ReadingFlowApp.getState().pyramidFontSize);
    await page.locator('#pyramid-font-size').evaluate(select => { select.value = '32'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramidFontSize), readOnlySize);
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), String(readOnlySize));
    assert.equal(await page.locator('#framing-situation').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#framing-complication').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#node-child').isDisabled(), true);
    assert.equal(await page.locator('#insert-pyramid').isDisabled(), true);
    assert.equal(await page.locator('#backup-import').isDisabled(), true);
    await page.locator('#start-analysis').click();
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().timers.analysis.status), 'running');
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    pass('read-only libraries disable editing and native insertion while local timers remain usable');

    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'PAPER002', title: 'Second paper' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, null));
      window.__switchBaseline = window.__saves.length;
    });
    await page.getByRole('textbox', { name: '疑问／回答', exact: true }).fill('未授权旧帧不得覆盖新工具记录');
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'PAPER003', title: 'Third paper' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, null));
    });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__saves.length), await page.evaluate(() => window.__switchBaseline));
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().item.key), 'PAPER003');
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).textContent(), '');
    pass('configuration replacement discards stale-frame debounce without writing the previous draft');
    await page.evaluate(() => { window.__holdSave = true; window.__insertBaseline = window.__inserted.length; });
    await page.getByRole('textbox', { name: '疑问／回答', exact: true }).fill('插入开始时的文献 A');
    await page.locator('#insert-pyramid').click();
    await page.waitForFunction(() => window.__saveBlocked);
    assert.equal(await page.locator('#pyramid-font-size').isDisabled(), true);
    const busySize = await page.evaluate(() => window.ReadingFlowApp.getState().pyramidFontSize);
    await page.locator('#pyramid-font-size').evaluate(select => { select.value = '32'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramidFontSize), busySize);
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'PAPER004', title: 'Fourth paper' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, null));
      window.__holdSave = false; window.__releaseSave();
    });
    await page.waitForFunction(() => !document.getElementById('insert-pyramid').disabled);
    assert.equal(await page.evaluate(() => window.__inserted.length), await page.evaluate(() => window.__insertBaseline));
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().item.key), 'PAPER004');
    pass('an in-flight insert aborts after a paper switch instead of inserting into the new note');
    await page.evaluate(() => { window.__holdImport = true; window.__import = window.ReadingFlowApp.getState(); window.__import.pyramid.text = '旧文献的导入内容'; });
    await page.locator('#backup-import').click();
    await page.waitForFunction(() => window.__importBlocked);
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'PAPER005', title: 'Fifth paper' };
      await window.ReadingFlowApp.loadConfig(window.mockConfig(item, null));
      window.__holdImport = false; window.__releaseImport();
    });
    await page.waitForFunction(() => !document.getElementById('insert-pyramid').disabled);
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().item.key), 'PAPER005');
    assert.equal(await page.getByRole('textbox', { name: '疑问／回答', exact: true }).textContent(), '');
    pass('an in-flight import cannot replace the new paper after configuration changes');
    await page.evaluate(async () => {
      const item = { libraryID: 1, key: 'SYNC0001', title: '同步版本选择' }, first = window.ReadingFlowCore.createSession(item), second = window.ReadingFlowCore.createSession(item);
      first.pyramid.text = '电脑 A 的核心观点'; first.framing.situation = '版本 A 背景'; first.pyramidFontSize = 20;
      second.pyramid.text = '电脑 B 保留的观点'; second.pyramid.boldRanges = [{ start: 0, end: 4 }]; second.pyramidFontSize = 28;
      const config = window.mockConfig(item, first);
      Object.assign(config, { readOnly: true, syncConflict: true, selectedSyncVersion: 'a', syncCanResolve: true, syncVersions: [{ id: 'a', label: '电脑 A', state: first }, { id: 'b', label: '电脑 B', state: second }] });
      config.bridge.canEdit = false;
      window.__conflictBridge = config.bridge;
      config.bridge.resolveSyncVersion = async id => { window.__chosenSyncVersion = id; const fresh = window.mockConfig(item, id === 'b' ? second : first); await window.ReadingFlowApp.loadConfig(fresh); return { message: '已采用所选版本，并保存到 Zotero' }; };
      await window.ReadingFlowApp.loadConfig(config); window.__conflictSaveCount = window.__saves.length;
    });
    assert.equal(await page.locator('#sync-area').isVisible(), true);
    assert.equal(await page.locator('#sync-version').evaluate(node => node.value), 'a');
    assert.equal(await page.locator('#start-inspection').isDisabled(), true);
    assert.equal(await page.locator('#node-child').isDisabled(), true);
    assert.equal(await page.locator('#pyramid-font-size').isDisabled(), true);
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '20');
    await page.locator('#sync-version').evaluate(node => { node.value = 'b'; node.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.text), '电脑 B 保留的观点');
    assert.equal(await page.locator('[data-node-id="root"] strong').textContent(), '电脑 B');
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '28');
    assert.equal(await page.locator('[data-node-id="root"] .node-text').evaluate(editor => getComputedStyle(editor).fontSize), '28px');
    await page.locator('#pyramid-font-size').evaluate(select => { select.value = '10'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramidFontSize), 28);
    await page.evaluate(() => window.ReadingFlowApp.flushPendingSave());
    assert.equal(await page.evaluate(() => window.__saves.length), await page.evaluate(() => window.__conflictSaveCount));
    await page.evaluate(() => { window.__conflictFlushes = 0; window.__conflictBridge.flushState = () => { window.__conflictFlushes++; }; window.dispatchEvent(new Event('beforeunload')); });
    assert.equal(await page.evaluate(() => window.__conflictFlushes), 0);
    await page.screenshot({ path: path.join(output, screenshotName('sync-conflict-preview')) });
    pass('synchronized conflict versions preview text and bold without autosaving or starting timers');
    await page.locator('#sync-use').click();
    await page.waitForFunction(() => window.__chosenSyncVersion === 'b' && document.getElementById('sync-area').hidden);
    assert.equal(await page.locator('#start-inspection').isDisabled(), false);
    assert.equal(await page.locator('[data-node-id="root"] .node-text').getAttribute('contenteditable'), 'true');
    assert.equal(await page.locator('#pyramid-font-size').isDisabled(), false);
    assert.equal(await page.locator('#pyramid-font-size').evaluate(select => select.value), '28');
    assert.match(await page.locator('#status').textContent(), /已采用所选版本/);
    pass('choosing a preserved version explicitly resumes editable tools');
    await page.evaluate(async () => { const current = window.ReadingFlowApp.getState(), config = window.mockConfig(current.item, current); Object.assign(config, { readOnly: true, syncPending: true }); config.bridge.canEdit = false; await window.ReadingFlowApp.loadConfig(config); });
    assert.equal(await page.locator('#node-child').isDisabled(), true);
    assert.equal(await page.locator('#start-analysis').isDisabled(), true);
    assert.equal(await page.locator('#pyramid-font-size').isDisabled(), true);
    assert.equal(await page.locator('#sync-area').isVisible(), false);
    assert.equal(await page.evaluate(() => window.ReadingFlowApp.getState().pyramid.text), '电脑 B 保留的观点');
    pass('incomplete synchronized data preserves the current tree and prevents premature writes');
    await boldEditingRegression(context);
    await framingBoldRegression(context);
    await fontSizingRegression(context);
    await resizingIframeRegression(browser);
    await manualHeightRegression(browser);
    assert.deepEqual(errors, []); pass('no browser JavaScript errors');
    fs.writeFileSync(path.join(output, 'ui-smoke-results-' + version + '.json'), JSON.stringify({ version, passed: checks.length, checks, errors, screenshots: ['v2-tools-collapsed-430', 'v2-checklist-650', 'v2-pyramid-tools-650', 'v2-pyramid-tools-430', 'v2-pyramid-insert', 'v2-pyramid-bold-framing-650', 'v2-pyramid-manual-height-730'].map(screenshotName) }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
