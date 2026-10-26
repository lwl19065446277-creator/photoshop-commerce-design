/* Real Photoshop adapter. Dependency injection exists only for contract tests;
 * production always supplies require('photoshop') and require('uxp'). */
"use strict";

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function number(value, name, positive) {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    throw fail("INVALID_ARGUMENT", `${name} must be a finite ${positive ? "positive " : ""}number`);
  }
  return value;
}

function integer(value, name) {
  number(value, name, true);
  if (!Number.isInteger(value)) throw fail("INVALID_ARGUMENT", `${name} must be an integer`);
  return value;
}

function string(value, name, allowEmpty) {
  if (typeof value !== "string" || (!allowEmpty && !value.length) || value.length > 100000 || value.indexOf("\0") >= 0) {
    throw fail("INVALID_ARGUMENT", `${name} must be a valid string`);
  }
  return value;
}

function localPath(value) {
  const path = string(value, "path").replace(/\\/g, "/");
  // MVP accepts absolute local-drive paths and POSIX paths, never remote shares/URLs.
  if ((!/^[A-Za-z]:\//.test(path) && !/^\/(?!\/)/.test(path)) || path.split("/").some(p => p === ".." || p === ".")) {
    throw fail("INVALID_PATH", "An absolute local path without traversal segments is required");
  }
  return path;
}

function fileUrl(path) {
  const normalized = localPath(path);
  // UXP getEntryWithUrl documents the native file:/ scheme (not OS path strings).
  return `file:${normalized.charAt(0) === "/" ? "" : "/"}${normalized}`;
}

function normalizedPath(path) { return localPath(path).toLowerCase(); }
function normalizedText(text) { return text.replace(/\r\n?/g, "\n"); }

function collectionItems(collection) {
  const result = [];
  if (collection) for (let i = 0; i < collection.length; i++) result.push(collection[i]);
  return result;
}

function createPhotoshopAdapter(photoshop, uxp) {
  const { app, action, core, constants } = photoshop;
  const fs = uxp.storage.localFileSystem;
  const managedDocuments = new Set();
  let executing = false;

  function documentById(id, writable) {
    if (id !== undefined) integer(id, "documentId");
    const documents = collectionItems(app.documents);
    const doc = id === undefined ? (documents.length ? app.activeDocument : undefined) : documents.find(d => d.id === id);
    if (!doc) throw fail("DOCUMENT_NOT_FOUND", id === undefined ? "No document is open" : `Document ${id} is not open`);
    if (writable && !managedDocuments.has(doc.id)) throw fail("UNMANAGED_DOCUMENT", "Only a working copy opened by this bridge may be modified");
    return doc;
  }

  function kindOf(layer) {
    const kind = layer.kind;
    if (kind === constants.LayerKind.TEXT) return "text";
    if (kind === constants.LayerKind.SMARTOBJECT) return "smartObject";
    if (kind === constants.LayerKind.GROUP) return "group";
    if (kind === constants.LayerKind.NORMAL) return "pixel";
    return String(kind || "other");
  }

  function plainBounds(layer) {
    const b = layer.boundsNoEffects || layer.bounds;
    return { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) };
  }

  function serializeLayer(layer) {
    const kind = kindOf(layer);
    const result = { id: layer.id, name: layer.name, kind, visible: layer.visible, bounds: plainBounds(layer), locked: Boolean(layer.locked) };
    if (kind === "text") result.text = normalizedText(layer.textItem.contents);
    if (kind === "group") result.children = collectionItems(layer.layers).map(serializeLayer);
    return result;
  }

  function flatten(layers) {
    const result = [];
    collectionItems(layers).forEach(layer => {
      result.push(layer);
      if (kindOf(layer) === "group") result.push(...flatten(layer.layers));
    });
    return result;
  }

  function layerById(doc, id) {
    integer(id, "layerId");
    const layer = flatten(doc.layers).find(l => l.id === id);
    if (!layer) throw fail("LAYER_NOT_FOUND", `Layer ${id} is not in document ${doc.id}`);
    return layer;
  }

  function documentInfo(doc) {
    return { id: doc.id, name: doc.name, width: Number(doc.width), height: Number(doc.height), path: doc.path || null, managed: managedDocuments.has(doc.id), colorMode: String(doc.mode), colorProfile: doc.colorProfileName || null };
  }

  function sourceState(doc) {
    return JSON.stringify({ mode: doc.mode, profile: doc.colorProfileName, width: doc.width, height: doc.height,
      layers: flatten(doc.layers).map(layer => [layer.id, layer.kind]) });
  }

  async function rasterCopy(doc, output, format, quality, context) {
    const rgb = constants.DocumentMode && constants.DocumentMode.RGB;
    const intent = constants.Intent && constants.Intent.RELATIVECOLORIMETRIC;
    const changeRgb = constants.ChangeMode && constants.ChangeMode.RGB;
    if (rgb === undefined || intent === undefined || changeRgb === undefined || typeof doc.duplicate !== "function") {
      throw fail("UNSUPPORTED_PREVIEW_MODE", "This Photoshop version does not expose the documented RGB duplicate export APIs", { sourceMode: String(doc.mode), format });
    }
    // Converting a merged duplicate avoids changing the editable source mode,
    // layers or IDs, and avoids recomputing its blend modes in a new space.
    const before = sourceState(doc);
    const sourceMode = String(doc.mode);
    const sourceProfile = doc.colorProfileName || null;
    const targetProfile = "sRGB IEC61966-2.1";
    let temporary;
    let temporaryId;
    let registered = false;
    let operationError;
    try {
      temporary = await doc.duplicate(`Design Agent export ${Date.now()}`, true);
      if (!temporary || temporary.id === doc.id) throw fail("UNSUPPORTED_PREVIEW_MODE", "Photoshop did not create a distinct export document");
      temporaryId = temporary.id;
      // Ensures cancellation/exception also closes a disposable document without
      // saving it, even if later close() calls are rejected by cancellation.
      await context.hostControl.registerAutoCloseDocument(temporaryId);
      registered = true;
      app.activeDocument = temporary;
      try {
        if (temporary.mode !== rgb) {
          if (typeof temporary.changeMode !== "function") throw new Error("Document.changeMode is unavailable");
          await temporary.changeMode(changeRgb);
        }
        if (temporary.mode !== rgb || typeof temporary.convertProfile !== "function") throw new Error("RGB color mode could not be established");
        await temporary.convertProfile(targetProfile, intent, true, true);
        if (temporary.mode !== rgb || temporary.colorProfileName !== targetProfile) throw new Error("RGB/sRGB conversion readback did not match the requested color space");
      } catch (error) {
        if (context.isCancelled) throw fail("CANCELLED", "Photoshop RGB export was cancelled");
        throw fail("UNSUPPORTED_PREVIEW_MODE", `Cannot safely render ${sourceMode} as ${format.toUpperCase()}: ${error.message || String(error)}`, { sourceMode, sourceProfile, targetProfile, cause: error.message || String(error) });
      }
      const options = format === "jpg" ? { quality: quality === undefined ? 10 : quality, embedColorProfile: true } : {};
      await temporary.saveAs[format](output, options, true);
      if (context.isCancelled) throw fail("CANCELLED", "Photoshop export was cancelled");
      return { sourceMode, sourceProfile, outputMode: "RGB", outputProfile: targetProfile, conversionScope: "temporary-merged-duplicate",
        requiresColorReview: true, colorReview: "RGB conversion uses Photoshop color settings and may change gamut/spot-color appearance. Review the screen export against the CMYK source; this is not an approved print proof." };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      let cleanupError;
      if (temporary && temporaryId !== undefined && temporaryId !== doc.id) {
        try {
          await temporary.close(constants.SaveOptions.DONOTSAVECHANGES);
          if (registered) await context.hostControl.unregisterAutoCloseDocument(temporaryId);
        } catch (error) { cleanupError = error; }
      }
      try { app.activeDocument = doc; }
      catch (error) { cleanupError = cleanupError || error; }
      if (sourceState(doc) !== before) throw fail("SOURCE_DOCUMENT_CHANGED", "Export changed the working document's color mode, profile, dimensions or layer IDs; stop and inspect", { outcome: "unknown", path: output.nativePath });
      if (cleanupError) throw fail("TEMP_DOCUMENT_CLEANUP_FAILED", `Temporary export cleanup failed: ${cleanupError.message || String(cleanupError)}`, { outcome: "unknown", outputPath: output.nativePath, temporaryDocumentId: temporaryId, originalCode: operationError && operationError.code });
    }
  }

  async function checkedBatch(descriptors) {
    const results = await action.batchPlay(descriptors, {});
    if (!Array.isArray(results) || results.length !== descriptors.length) throw fail("PHOTOSHOP_INVALID_RESULT", "Photoshop returned an unexpected action result");
    const error = results.find(r => r && (r._obj === "error" || (typeof r.result === "number" && r.result < 0)));
    if (error) throw fail("PHOTOSHOP_ACTION_ERROR", error.message || "Photoshop action failed", error);
    return results;
  }

  async function mutate(doc, operation, fn) {
    return core.executeAsModal(async context => {
      app.activeDocument = doc;
      const suspensionId = await context.hostControl.suspendHistory({ documentID: doc.id, name: `Design Agent: ${operation}` });
      try {
        const result = await fn(context);
        if (context.isCancelled) throw fail("CANCELLED", "Photoshop operation was cancelled");
        await context.hostControl.resumeHistory(suspensionId, true);
        return result;
      } catch (error) {
        try { await context.hostControl.resumeHistory(suspensionId, false); }
        catch (rollbackError) {
          throw fail("ROLLBACK_FAILED", `${error.message}; rollback also failed: ${rollbackError.message}`, { originalCode: error.code || "PHOTOSHOP_ERROR", outcome: "unknown" });
        }
        throw error;
      }
    }, { commandName: `Design Agent: ${operation}` });
  }

  async function inputEntry(path) {
    const entry = await fs.getEntryWithUrl(fileUrl(path));
    if (!entry || !entry.isFile) throw fail("FILE_NOT_FOUND", "Input path is not a file");
    return entry;
  }

  async function newOutputEntry(path, extension) {
    const normalized = localPath(path);
    if (!normalized.toLowerCase().endsWith(extension)) throw fail("INVALID_PATH", `Output extension must be ${extension}`);
    const slash = normalized.lastIndexOf("/");
    const folder = await fs.getEntryWithUrl(fileUrl(normalized.slice(0, slash)));
    if (!folder || !folder.isFolder) throw fail("OUTPUT_DIRECTORY_MISSING", "Output parent directory must already exist");
    // Do not swallow permission errors as 'not found'. Listing proves a free name.
    const entries = await folder.getEntries();
    const name = normalized.slice(slash + 1);
    if (entries.some(entry => entry.name.toLowerCase() === name.toLowerCase())) throw fail("OUTPUT_EXISTS", `Refusing to overwrite ${name}`);
    return folder.createFile(name, { overwrite: false });
  }

  async function saveCopy(doc, path, format, quality) {
    if (format === "psd" && (Number(doc.width) > 30000 || Number(doc.height) > 30000)) {
      throw fail("PSD_LIMIT_EXCEEDED", "PSD supports dimensions up to 30,000 pixels; this PSB requires a PSB delivery workflow. No flattening or resizing was performed.");
    }
    const output = await newOutputEntry(path, `.${format}`);
    return core.executeAsModal(async context => {
      app.activeDocument = doc;
      let color;
      if (format === "psd") await doc.saveAs.psd(output, { embedColorProfile: true, layers: true, maximizeCompatibility: true, alphaChannels: true, spotColor: true, annotations: true }, true);
      else color = await rasterCopy(doc, output, format, quality, context);
      const metadata = await output.getMetadata();
      if (!(metadata.size > 0)) throw fail("EMPTY_OUTPUT", "Photoshop returned without writing output bytes");
      return { documentId: doc.id, path: output.nativePath, format, bytes: metadata.size, ...(color ? { color } : {}) };
    }, { commandName: `Design Agent: save ${format.toUpperCase()} copy` });
  }

  async function execute(operation, args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw fail("INVALID_ARGUMENT", "args must be an object");
    switch (operation) {
      case "ping": return { connected: true, photoshopVersion: app.version, pluginVersion: "0.1.0", protocolVersion: 1, documentCount: app.documents.length };
      case "get_document_info": return documentInfo(documentById(args.documentId, false));
      case "list_layers": return { documentId: args.documentId, layers: collectionItems(documentById(args.documentId, false).layers).map(serializeLayer) };
      case "find_layer": {
        const doc = documentById(args.documentId, false);
        const name = string(args.name, "name");
        const matches = flatten(doc.layers).filter(l => l.name === name);
        if (!matches.length) throw fail("LAYER_NOT_FOUND", `No exact layer named ${name}`);
        if (matches.length > 1) throw fail("AMBIGUOUS_LAYER", `There are ${matches.length} exact layers named ${name}; use layerId`, { layerIds: matches.map(l => l.id) });
        return serializeLayer(matches[0]);
      }
      case "open_document": {
        const entry = await inputEntry(args.path);
        if (!/\.(psd|psb)$/i.test(entry.name)) throw fail("INVALID_PATH", "Only PSD/PSB working copies can be opened in MVP");
        if (collectionItems(app.documents).some(doc => doc.path && normalizedPath(doc.path) === normalizedPath(entry.nativePath))) {
          throw fail("DOCUMENT_ALREADY_OPEN", "Working copy is already open; refusing to adopt an existing document");
        }
        return core.executeAsModal(async () => {
          const doc = await app.open(entry);
          managedDocuments.add(doc.id);
          return documentInfo(doc);
        }, { commandName: "Design Agent: open working PSD" });
      }
      case "set_text": {
        const doc = documentById(args.documentId, true);
        const layer = layerById(doc, args.layerId);
        const text = string(args.text, "text", true);
        if (kindOf(layer) !== "text") throw fail("WRONG_LAYER_KIND", "Target layer is not editable text");
        return mutate(doc, operation, async () => {
          layer.textItem.contents = text;
          if (normalizedText(layer.textItem.contents) !== normalizedText(text)) throw fail("TEXT_VERIFICATION_FAILED", "Photoshop text readback differs from requested text");
          return serializeLayer(layer);
        });
      }
      case "replace_smart_object": {
        const doc = documentById(args.documentId, true);
        const layer = layerById(doc, args.layerId);
        if (kindOf(layer) !== "smartObject") throw fail("WRONG_LAYER_KIND", "Target layer is not a Smart Object");
        const file = await inputEntry(args.path);
        if (!/\.(png|jpe?g|tiff?|psd)$/i.test(file.name)) throw fail("UNSUPPORTED_ASSET", "MVP accepts PNG/JPEG/TIFF/PSD product assets");
        return mutate(doc, operation, async () => {
          const [descriptor] = await checkedBatch([{ _obj: "get", _target: [{ _property: "smartObject" }, { _ref: "layer", _id: layer.id }, { _ref: "document", _id: doc.id }], _options: { dialogOptions: "dontDisplay" } }]);
          if (!descriptor.smartObject || typeof descriptor.smartObject.linked !== "boolean") throw fail("SMART_OBJECT_METADATA_UNAVAILABLE", "Cannot determine whether this Smart Object is embedded; replacement requires manual review");
          if (descriptor.smartObject.linked) throw fail("LINKED_SMART_OBJECT", "Linked Smart Objects require manual review; MVP only replaces embedded content");
          doc.activeLayers = [layer];
          await checkedBatch([{ _obj: "placedLayerReplaceContents", null: { _path: fs.createSessionToken(file), _kind: "local" }, _options: { dialogOptions: "dontDisplay" } }]);
          return { ...serializeLayer(layerById(doc, layer.id)), sourcePath: file.nativePath, embedded: true, verification: "Photoshop action completed; product appearance still requires preview review" };
        });
      }
      case "set_visibility": {
        const doc = documentById(args.documentId, true);
        const layer = layerById(doc, args.layerId);
        if (typeof args.visible !== "boolean") throw fail("INVALID_ARGUMENT", "visible must be boolean");
        return mutate(doc, operation, async () => { layer.visible = args.visible; return serializeLayer(layer); });
      }
      case "transform_layer": {
        const doc = documentById(args.documentId, true);
        const layer = layerById(doc, args.layerId);
        if (args.translateX === undefined && args.translateY === undefined && args.scalePercent === undefined) throw fail("INVALID_ARGUMENT", "Specify a translation or uniform scale");
        const dx = args.translateX === undefined ? 0 : number(args.translateX, "translateX");
        const dy = args.translateY === undefined ? 0 : number(args.translateY, "translateY");
        const scale = args.scalePercent === undefined ? 100 : number(args.scalePercent, "scalePercent", true);
        if (scale > 1000 || scale < 1) throw fail("INVALID_ARGUMENT", "scalePercent must be 1..1000");
        if (collectionItems(layer.linkedLayers).length) throw fail("LINKED_LAYER_TRANSFORM", "Transforming a linked layer can affect other layers; manual review is required");
        return mutate(doc, operation, async () => {
          if (scale !== 100) await layer.scale(scale, scale, constants.AnchorPosition.MIDDLECENTER);
          if (dx || dy) await layer.translate(dx, dy);
          return serializeLayer(layer);
        });
      }
      case "create_text": {
        const doc = documentById(args.documentId, true);
        const name = string(args.name, "name");
        const text = string(args.text, "text", true);
        const x = number(args.x, "x"), y = number(args.y, "y"), fontSize = number(args.fontSize, "fontSize", true);
        return mutate(doc, operation, async () => serializeLayer(await doc.createTextLayer({ name, contents: text, fontSize, position: { x, y } })));
      }
      case "get_preview": return saveCopy(documentById(args.documentId, true), args.path, "png");
      case "save_psd": return saveCopy(documentById(args.documentId, true), args.path, "psd");
      case "export_image": {
        if (!["png", "jpg"].includes(args.format)) throw fail("INVALID_ARGUMENT", "format must be png or jpg");
        if (args.quality !== undefined && (!Number.isInteger(args.quality) || args.quality < 0 || args.quality > 12)) throw fail("INVALID_ARGUMENT", "JPEG quality must be an integer 0..12");
        return saveCopy(documentById(args.documentId, true), args.path, args.format, args.quality);
      }
      case "close_document": {
        const doc = documentById(args.documentId, true);
        const documentId = doc.id;
        if (args.save !== false) throw fail("INVALID_ARGUMENT", "close_document requires save:false");
        return core.executeAsModal(async () => {
          await doc.close(constants.SaveOptions.DONOTSAVECHANGES);
          managedDocuments.delete(documentId);
          return { documentId, closed: true, saved: false };
        }, { commandName: "Design Agent: close working copy" });
      }
      default: throw fail("UNKNOWN_OPERATION", `Unsupported operation: ${operation}`);
    }
  }

  return {
    async execute(operation, args) {
      if (executing) throw fail("ADAPTER_BUSY", "Photoshop adapter is already executing a command");
      executing = true;
      try { return await execute(operation, args || {}); }
      finally { executing = false; }
    }
  };
}

module.exports = { createPhotoshopAdapter, fileUrl, localPath };
