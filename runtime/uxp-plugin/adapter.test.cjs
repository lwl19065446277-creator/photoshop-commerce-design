"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPhotoshopAdapter, fileUrl, localPath } = require("./photoshop-adapter.js");

function harness() {
  const calls = [];
  const renderFaults = {};
  const text = { id: 10, name: "主标题", kind: "text", visible: true, locked: false, boundsNoEffects: { left: 12, top: 12, right: 220, bottom: 40 }, textItem: { contents: "旧文案" }, linkedLayers: [] };
  const smart = { id: 11, name: "商品", kind: "smart", visible: true, boundsNoEffects: { left: 20, top: 70, right: 300, bottom: 350 }, linkedLayers: [] };
  const doc = { id: 2, name: "working.psd", path: "C:/runs/working.psd", width: 800, height: 800, layers: [text, smart], activeLayers: [], saveAs: {}, mode: "rgb", colorProfileName: "sRGB IEC61966-2.1" };
  text.scale = smart.scale = async (...args) => calls.push(["scale", ...args]);
  text.translate = smart.translate = async (...args) => calls.push(["translate", ...args]);
  doc.close = async option => calls.push(["close", option]);
  doc.createTextLayer = async options => { calls.push(["createText", options]); return text; };
  let batchError = null;
  let smartMetadata = { linked: false };
  const outputFile = { name: "out.psd", nativePath: "C:/runs/out.psd", isFile: true, getMetadata: async () => ({ size: 128 }) };
  let existingOutput = false;
  for (const format of ["psd", "png", "jpg"]) doc.saveAs[format] = async (...args) => calls.push(["save", format, ...args]);
  const folder = { isFolder: true, getEntries: async () => existingOutput ? [{ name: "out.psd" }] : [], createFile: async (name, options) => { calls.push(["createFile", name, options]); return outputFile; } };
  const input = { isFile: true, name: "working.psd", nativePath: "C:/runs/working.psd" };
  const app = { version: "27.0", documents: [], activeDocument: doc, open: async entry => { calls.push(["open", entry]); app.documents.push(doc); return doc; } };
  let temporary;
  doc.duplicate = async (name, mergeLayersOnly) => {
    calls.push(["duplicate", name, mergeLayersOnly]);
    if (renderFaults.sameDocument) return doc;
    temporary = { id: 99, name, width: doc.width, height: doc.height, mode: doc.mode, colorProfileName: doc.colorProfileName, layers: [{ id: 100, kind: "normal" }], saveAs: {} };
    temporary.changeMode = async mode => { calls.push(["temporaryMode", mode]); if (renderFaults.changeMode) throw new Error("Unsupported color mode conversion"); temporary.mode = mode; };
    temporary.convertProfile = async (...args) => { calls.push(["temporaryProfile", ...args]); if (renderFaults.convertProfile) throw new Error("Destination profile unavailable"); if (!renderFaults.profileReadback) temporary.colorProfileName = args[0]; };
    temporary.close = async option => { calls.push(["temporaryClose", option]); if (renderFaults.close) throw new Error("Close rejected"); app.documents = app.documents.filter(d => d !== temporary); };
    for (const format of ["png", "jpg"]) temporary.saveAs[format] = async (...args) => { calls.push(["temporarySave", format, ...args]); if (renderFaults.save) { const error = new Error("Disk full"); error.code = "DISK_FULL"; throw error; } };
    app.documents.push(temporary); app.activeDocument = temporary;
    return temporary;
  };
  let modalDepth = 0;
  const photoshop = {
    app,
    constants: { LayerKind: { TEXT: "text", SMARTOBJECT: "smart", GROUP: "group", NORMAL: "normal" }, AnchorPosition: { MIDDLECENTER: "center" }, SaveOptions: { DONOTSAVECHANGES: "discard" }, DocumentMode: { RGB: "rgb", CMYK: "cmyk" }, ChangeMode: { RGB: "rgb" }, Intent: { RELATIVECOLORIMETRIC: "relative" } },
    action: { batchPlay: async descriptors => { calls.push(["batchPlay", descriptors]); if (descriptors[0]._obj === "get") return [{ smartObject: smartMetadata }]; return batchError ? [batchError] : [{}]; } },
    core: { executeAsModal: async fn => {
      assert.equal(modalDepth, 0, "adapter must not nest modal scopes");
      modalDepth++;
      calls.push(["modal"]);
      try {
        return await fn({ isCancelled: false, hostControl: { suspendHistory: async options => { calls.push(["suspend", options]); return "history-1"; }, resumeHistory: async (...args) => calls.push(["resume", ...args]), registerAutoCloseDocument: async id => calls.push(["autoCloseRegister", id]), unregisterAutoCloseDocument: async id => calls.push(["autoCloseUnregister", id]) } });
      } finally { modalDepth--; }
    } }
  };
  const uxp = { storage: { localFileSystem: {
    getEntryWithUrl: async url => { calls.push(["getEntry", url]); return /\/runs$/.test(url) ? folder : url.endsWith(".png") ? { isFile: true, name: "asset.png", nativePath: "C:/assets/asset.png" } : input; },
    createSessionToken: entry => { calls.push(["sessionToken", entry]); return "session-token"; }
  } } };
  return { adapter: createPhotoshopAdapter(photoshop, uxp), calls, doc, text, smart, app, input, renderFaults, setBatchError(value) { batchError = value; }, setSmartMetadata(value) { smartMetadata = value; }, setExistingOutput(value) { existingOutput = value; } };
}

test("local native paths support Chinese names and reject traversal, network and URLs", () => {
  assert.equal(fileUrl("C:\\设计\\工作副本.psd"), "file:/C:/设计/工作副本.psd");
  for (const path of ["../template.psd", "C:/runs/../original.psd", "https://example.com/a.psd", "//server/a.psd", "\\\\server\\a.psd"]) assert.throws(() => localPath(path), { code: "INVALID_PATH" });
});

test("existing Photoshop documents are readable but cannot be modified or adopted", async () => {
  const h = harness(); h.app.documents.push(h.doc);
  assert.equal((await h.adapter.execute("get_document_info", { documentId: 2 })).managed, false);
  await assert.rejects(h.adapter.execute("set_text", { documentId: 2, layerId: 10, text: "新文案" }), { code: "UNMANAGED_DOCUMENT" });
  await assert.rejects(h.adapter.execute("open_document", { path: "C:/runs/working.psd" }), { code: "DOCUMENT_ALREADY_OPEN" });
  assert.equal(h.text.textItem.contents, "旧文案");
});

test("working-copy text changes are scoped, read back and committed into one history state", async () => {
  const h = harness();
  assert.equal((await h.adapter.execute("open_document", { path: "C:/runs/working.psd" })).managed, true);
  const result = await h.adapter.execute("set_text", { documentId: 2, layerId: 10, text: "今日上新 ¥199" });
  assert.equal(result.text, "今日上新 ¥199");
  assert.deepEqual(h.calls.find(c => c[0] === "suspend"), ["suspend", { documentID: 2, name: "Design Agent: set_text" }]);
  assert.deepEqual(h.calls.find(c => c[0] === "resume"), ["resume", "history-1", true]);
  await assert.rejects(h.adapter.execute("set_text", { documentId: 2, layerId: 999, text: "wrong" }), { code: "LAYER_NOT_FOUND" });
});

test("PSB sources open as managed working copies while PSD oversize delivery fails without flattening", async () => {
  const h = harness();
  h.input.name = "working.psb"; h.input.nativePath = "C:/runs/working.psb";
  h.doc.name = "working.psb"; h.doc.path = "C:/runs/working.psb";
  assert.equal((await h.adapter.execute("open_document", { path: "C:/runs/working.psb" })).managed, true);
  h.doc.width = 30001;
  await assert.rejects(h.adapter.execute("save_psd", { documentId: 2, path: "C:/runs/out.psd" }), { code: "PSD_LIMIT_EXCEEDED" });
  assert.equal(h.calls.filter(c => c[0] === "save" || c[0] === "createFile").length, 0);
});

test("Photoshop CR text newlines are exposed as LF without changing whitespace", async () => {
  const h = harness();
  let contents = "旧文案";
  Object.defineProperty(h.text.textItem, "contents", { get: () => contents, set: value => { contents = value.replace(/\r\n?|\n/g, "\r"); } });
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  const result = await h.adapter.execute("set_text", { documentId: 2, layerId: 10, text: "  第一行\n第二行  " });
  assert.equal(contents, "  第一行\r第二行  ");
  assert.equal(result.text, "  第一行\n第二行  ");
});

test("nested layers are enumerated and duplicate names cannot be silently selected", async () => {
  const h = harness();
  const duplicate = { ...h.text, id: 12 };
  const group = { id: 20, name: "文案组", kind: "group", visible: true, boundsNoEffects: h.text.boundsNoEffects, layers: [duplicate] };
  h.doc.layers.push(group); h.app.documents.push(h.doc);
  const tree = await h.adapter.execute("list_layers", { documentId: 2 });
  assert.equal(tree.layers[2].children[0].id, 12);
  await assert.rejects(h.adapter.execute("find_layer", { documentId: 2, name: "主标题" }), { code: "AMBIGUOUS_LAYER" });
});

test("Smart Object replacement uses a session token and rolls back returned Photoshop errors", async () => {
  const h = harness();
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  h.setBatchError({ _obj: "error", result: -25922, message: "Replace Contents is not available" });
  await assert.rejects(h.adapter.execute("replace_smart_object", { documentId: 2, layerId: 11, path: "C:/assets/asset.png" }), { code: "PHOTOSHOP_ACTION_ERROR" });
  const replace = h.calls.filter(c => c[0] === "batchPlay")[1][1][0];
  assert.equal(replace.null._path, "session-token");
  assert.equal(replace._options.dialogOptions, "dontDisplay");
  assert.deepEqual(h.calls.find(c => c[0] === "resume"), ["resume", "history-1", false]);
});

test("linked Smart Objects and unknown embedded status stop before replacement", async () => {
  for (const metadata of [{ linked: true }, {}]) {
    const h = harness(); await h.adapter.execute("open_document", { path: "C:/runs/working.psd" }); h.setSmartMetadata(metadata);
    await assert.rejects(h.adapter.execute("replace_smart_object", { documentId: 2, layerId: 11, path: "C:/assets/asset.png" }), { code: metadata.linked ? "LINKED_SMART_OBJECT" : "SMART_OBJECT_METADATA_UNAVAILABLE" });
    assert.equal(h.calls.filter(c => c[0] === "batchPlay").length, 1);
  }
});

test("export preserves editable PSD layers, saves a copy and refuses an existing path", async () => {
  const h = harness(); await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  const result = await h.adapter.execute("save_psd", { documentId: 2, path: "C:/runs/out.psd" });
  assert.equal(result.bytes, 128);
  const save = h.calls.find(c => c[0] === "save");
  assert.equal(save[1], "psd"); assert.equal(save[3].layers, true); assert.equal(save[4], true);
  h.setExistingOutput(true);
  await assert.rejects(h.adapter.execute("save_psd", { documentId: 2, path: "C:/runs/out.psd" }), { code: "OUTPUT_EXISTS" });
  assert.equal(h.calls.filter(c => c[0] === "save").length, 1);
});

test("CMYK PNG preview converts only a merged temporary duplicate and restores original layer IDs/mode", async () => {
  const h = harness(); h.doc.mode = "cmyk"; h.doc.colorProfileName = "U.S. Web Coated (SWOP) v2";
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  const before = JSON.stringify({ mode: h.doc.mode, profile: h.doc.colorProfileName, layers: h.doc.layers });
  const result = await h.adapter.execute("get_preview", { documentId: 2, path: "C:/runs/preview.png" });
  assert.equal(result.color.sourceMode, "cmyk");
  assert.equal(result.color.outputProfile, "sRGB IEC61966-2.1");
  assert.equal(result.color.requiresColorReview, true);
  assert.equal(JSON.stringify({ mode: h.doc.mode, profile: h.doc.colorProfileName, layers: h.doc.layers }), before);
  assert.equal(h.calls.find(c => c[0] === "duplicate")[2], true);
  assert.deepEqual(h.calls.find(c => c[0] === "temporaryMode"), ["temporaryMode", "rgb"]);
  assert.deepEqual(h.calls.find(c => c[0] === "temporaryProfile"), ["temporaryProfile", "sRGB IEC61966-2.1", "relative", true, true]);
  assert.deepEqual(h.calls.find(c => c[0] === "temporaryClose"), ["temporaryClose", "discard"]);
  assert.deepEqual(h.calls.find(c => c[0] === "autoCloseRegister"), ["autoCloseRegister", 99]);
  assert.deepEqual(h.calls.find(c => c[0] === "autoCloseUnregister"), ["autoCloseUnregister", 99]);
  assert.equal(h.calls.filter(c => c[0] === "save").length, 0);
  assert.equal(h.app.activeDocument, h.doc);
  assert.equal(h.app.documents.length, 1);
});

test("CMYK JPG export uses an RGB copy while PSD retains the source color space and editable layers", async () => {
  const h = harness(); h.doc.mode = "cmyk"; h.doc.colorProfileName = "Japan Color 2001 Coated";
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  await h.adapter.execute("export_image", { documentId: 2, path: "C:/runs/render.jpg", format: "jpg", quality: 12 });
  const jpeg = h.calls.find(c => c[0] === "temporarySave");
  assert.equal(jpeg[1], "jpg"); assert.equal(jpeg[3].quality, 12); assert.equal(jpeg[3].embedColorProfile, true); assert.equal(jpeg[4], true);
  const duplicatesBeforePsd = h.calls.filter(c => c[0] === "duplicate").length;
  await h.adapter.execute("save_psd", { documentId: 2, path: "C:/runs/out.psd" });
  assert.equal(h.doc.mode, "cmyk"); assert.equal(h.doc.colorProfileName, "Japan Color 2001 Coated");
  assert.equal(h.calls.filter(c => c[0] === "duplicate").length, duplicatesBeforePsd);
  assert.equal(h.calls.find(c => c[0] === "save")[3].layers, true);
});

test("conversion failure or unverifiable profile stops PNG output and closes the disposable duplicate", async () => {
  for (const fault of ["changeMode", "convertProfile", "profileReadback"]) {
    const h = harness(); h.doc.mode = "cmyk"; h.doc.colorProfileName = "U.S. Web Coated (SWOP) v2"; h.renderFaults[fault] = true;
    await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
    await assert.rejects(h.adapter.execute("get_preview", { documentId: 2, path: "C:/runs/preview.png" }), { code: "UNSUPPORTED_PREVIEW_MODE" });
    assert.equal(h.calls.filter(c => c[0] === "temporarySave").length, 0);
    assert.deepEqual(h.calls.find(c => c[0] === "temporaryClose"), ["temporaryClose", "discard"]);
    assert.equal(h.doc.mode, "cmyk"); assert.equal(h.app.activeDocument, h.doc); assert.equal(h.app.documents.length, 1);
  }
});

test("disk-save failure still cleans the temporary export document without saving it", async () => {
  const h = harness(); h.doc.mode = "cmyk"; h.renderFaults.save = true;
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  await assert.rejects(h.adapter.execute("get_preview", { documentId: 2, path: "C:/runs/preview.png" }), { code: "DISK_FULL" });
  assert.deepEqual(h.calls.find(c => c[0] === "temporaryClose"), ["temporaryClose", "discard"]);
  assert.equal(h.doc.mode, "cmyk"); assert.equal(h.app.activeDocument, h.doc); assert.equal(h.app.documents.length, 1);
});

test("cleanup failure is explicit and keeps auto-close registered instead of reporting export success", async () => {
  const h = harness(); h.doc.mode = "cmyk"; h.renderFaults.close = true;
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  await assert.rejects(h.adapter.execute("get_preview", { documentId: 2, path: "C:/runs/preview.png" }), error => error.code === "TEMP_DOCUMENT_CLEANUP_FAILED" && error.details.outcome === "unknown");
  assert.equal(h.calls.filter(c => c[0] === "autoCloseUnregister").length, 0);
  assert.equal(h.doc.mode, "cmyk"); assert.equal(h.app.activeDocument, h.doc);
});

test("a failed duplicate result cannot cause the source document to be converted or closed", async () => {
  const h = harness(); h.doc.mode = "cmyk"; h.renderFaults.sameDocument = true;
  await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  await assert.rejects(h.adapter.execute("get_preview", { documentId: 2, path: "C:/runs/preview.png" }), { code: "UNSUPPORTED_PREVIEW_MODE" });
  assert.equal(h.calls.filter(c => ["temporaryClose", "close", "temporaryMode", "temporaryProfile", "save"].includes(c[0])).length, 0);
  assert.equal(h.doc.mode, "cmyk");
});

test("transform only accepts uniform scale and rejects linked-layer side effects", async () => {
  const h = harness(); await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  await h.adapter.execute("transform_layer", { documentId: 2, layerId: 11, scalePercent: 75, translateX: 20, translateY: -10 });
  assert.deepEqual(h.calls.find(c => c[0] === "scale"), ["scale", 75, 75, "center"]);
  assert.deepEqual(h.calls.find(c => c[0] === "translate"), ["translate", 20, -10]);
  h.smart.linkedLayers = [h.text];
  await assert.rejects(h.adapter.execute("transform_layer", { documentId: 2, layerId: 11, scalePercent: 80 }), { code: "LINKED_LAYER_TRANSFORM" });
});

test("arbitrary operations are rejected and source files are never saved in place", async () => {
  const h = harness(); await h.adapter.execute("open_document", { path: "C:/runs/working.psd" });
  await assert.rejects(h.adapter.execute("eval", { script: "delete all" }), { code: "UNKNOWN_OPERATION" });
  await assert.rejects(h.adapter.execute("close_document", { documentId: 2, save: true }), { code: "INVALID_ARGUMENT" });
  await h.adapter.execute("close_document", { documentId: 2, save: false });
  assert.deepEqual(h.calls.find(c => c[0] === "close"), ["close", "discard"]);
});
