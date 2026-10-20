/* Synthetic V1 records for the isolated native file-sync migration harness.
 * Call only after the harness verifies its disposable profile/data paths.
 * No user library, account, or filesystem path is embedded in these helpers.
 */
(function (root) {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));

  async function create({ Zotero, core, legacy, BlobClass }) {
    if (!Zotero || !core || !legacy || !BlobClass) throw new Error("Native fixture dependencies are required");
    const libraryID = Zotero.Libraries.userLibraryID;
    const owners = [], legacyNotes = [], protectedNotes = [];
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iM1sAAAAASUVORK5CYII="), character => character.charCodeAt(0));

    async function noteFor(owner, html, managed) {
      const note = new Zotero.Item("note"); note.libraryID = libraryID;
      if (!owner.isNote()) note.parentID = owner.id;
      note.setNote(html);
      if (managed) note.addTag(legacy.TAG);
      await note.saveTx();
      return note;
    }
    async function originalProse(owner, label) {
      const note = owner.isNote() ? owner : await noteFor(owner, '<div data-schema-version="9"><p>' + label + " original native prose</p></div>", false);
      const image = await Zotero.Attachments.importEmbeddedImage({ blob: new BlobClass([png], { type: "image/png" }), parentItemID: note.id });
      note.setNote('<div data-schema-version="9"><p>' + label + ' original native prose</p><p><img data-attachment-key="' + image.key + '" width="1" height="1" /></p></div>');
      await note.saveTx();
      return { note, image, marker: label + " original native prose" };
    }
    function stateFor(owner, prose, label, large) {
      const state = core.createSession({ libraryID, key: owner.key, title: label });
      state.noteKey = prose.note.key; state.pyramidFontSize = large ? 24 : 28;
      state.pyramid.text = label + " root 核心观点";
      state.pyramid.boldRanges = [{ start: 0, end: label.length }];
      state.framing.situation = label + " background 背景";
      state.framing.complication = label + " conflict 冲突";
      state.framing.situationBoldRanges = [{ start: 0, end: label.length }];
      state.framing.complicationBoldRanges = [{ start: 0, end: label.length }];
      state.inspection.completed = true;
      state.inspection.checklist = [true, false, true, true, false, true];
      const argument = core.addNode(state, "root", "argument");
      argument.text = label + " supporting argument"; argument.boldRanges = [{ start: 0, end: label.length }];
      const evidence = core.addNode(state, argument.id, "evidence");
      evidence.text = "Synthetic evidence with page reference"; evidence.source = "p. 3, fig. 2";
      if (large) for (let i = 0; i < 4; i++) {
        const child = core.addNode(state, "root", "evidence");
        child.text = "分块迁移证据😀".repeat(1200); child.source = "Synthetic chunk " + i;
      }
      return core.normalizeSession(state, state.item);
    }
    async function writeHead(owner, state, label) {
      const encoded = legacy.splitPayload(state), parts = [];
      const base = { format: legacy.FORMAT, ownerKey: owner.key, ownerKind: owner.isNote() ? "note" : "item", deviceID: "legacy-device-" + label, revision: "legacy-revision-" + label };
      for (let index = 0; encoded.parts.length > 1 && index < encoded.parts.length; index++) {
        const part = await noteFor(owner, legacy.encodeNote({ ...base, kind: "part", index, count: encoded.parts.length, data: encoded.parts[index] }), true);
        parts.push(part); legacyNotes.push(part);
      }
      const body = encoded.parts.length === 1 ? { data: encoded.parts[0] } : { partKeys: parts.map(part => part.key) };
      const envelope = { ...base, kind: "head", clock: { [base.deviceID]: 1 }, ...body, hash: encoded.hash, length: encoded.length };
      const head = await noteFor(owner, legacy.encodeNote(envelope), true); legacyNotes.push(head);
      return { head, parts, state: clone(state), envelope };
    }

    for (const kind of ["item", "note"]) {
      const owner = new Zotero.Item(kind === "item" ? "journalArticle" : "note"); owner.libraryID = libraryID;
      if (kind === "item") owner.setField("title", "Synthetic V1 parent migration fixture");
      else owner.setNote('<div data-schema-version="9"><p>Synthetic V1 standalone migration fixture</p></div>');
      await owner.saveTx();
      const prose = await originalProse(owner, kind), first = await writeHead(owner, stateFor(owner, prose, kind + "-A", true), kind + "-A"), second = await writeHead(owner, stateFor(owner, prose, kind + "-B", false), kind + "-B");
      if (first.parts.length < 2) throw new Error("The native fixture must exercise multiple V1 part notes");
      owners.push({ kind, owner, prose, heads: [first, second] });
    }
    const incompleteOwner = new Zotero.Item("journalArticle"); incompleteOwner.libraryID = libraryID; incompleteOwner.setField("title", "Synthetic incomplete V1 migration fixture"); await incompleteOwner.saveTx();
    const incompleteState = core.createSession({ libraryID, key: incompleteOwner.key, title: "Incomplete V1" });
    incompleteState.pyramid.text = "Incomplete data must remain protected";
    const encoded = legacy.splitPayload(incompleteState);
    const incompleteHead = await noteFor(incompleteOwner, legacy.encodeNote({ format: legacy.FORMAT, ownerKey: incompleteOwner.key, ownerKind: "item", deviceID: "legacy-device-incomplete", revision: "legacy-revision-incomplete", kind: "head", clock: { "legacy-device-incomplete": 1 }, partKeys: ["Z8Z8Z8Z8"], hash: encoded.hash, length: encoded.length }), true);
    protectedNotes.push(incompleteHead);
    const ordinary = await noteFor(owners[0].owner, '<div data-schema-version="9"><p>Ordinary tagged prose, not managed data. Reading flow · 金字塔数据</p></div>', true);
    protectedNotes.push(ordinary);
    const orphan = await noteFor(incompleteOwner, legacy.encodeNote({ format: legacy.FORMAT, ownerKey: incompleteOwner.key, ownerKind: "item", deviceID: "legacy-device-orphan", revision: "legacy-revision-orphan", kind: "part", index: 0, count: 1, data: encoded.parts[0] }), true);
    protectedNotes.push(orphan);
    return { libraryID, owners, legacyNotes, protectedNotes, incompleteOwner };
  }

  root.ReadingFlowFileSyncFixtures = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
