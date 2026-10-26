/* Static, allowlisted ExtendScript dispatcher. Request values enter only as
 * COM Arguments strings. Never evaluate request text as JavaScript. ES3 only. */
(function (argv) {
    #include "design-com.jsxinc"
    #include "catalog-com.jsxinc"
    #include "slices-com.jsxinc"
    #include "variant-com.jsxinc"
    function problem(code, message, details) {
        var e = new Error(message); e.code = code; if (details !== undefined) e.details = details; return e;
    }
    function quote(value) {
        var result = '"', i, n, hex;
        value = String(value);
        for (i = 0; i < value.length; i++) {
            n = value.charCodeAt(i);
            if (n === 34) result += '\\"';
            else if (n === 92) result += '\\\\';
            else if (n < 32 || n > 126) { hex = n.toString(16); while (hex.length < 4) hex = '0' + hex; result += '\\u' + hex; }
            else result += value.charAt(i);
        }
        return result + '"';
    }
    function json(value) {
        var parts = [], i, key, type = typeof value;
        if (value === null || value === undefined) return 'null';
        if (type === 'string') return quote(value);
        if (type === 'boolean') return value ? 'true' : 'false';
        if (type === 'number') return isFinite(value) ? String(value) : 'null';
        if (value instanceof Array) { for (i = 0; i < value.length; i++) parts.push(json(value[i])); return '[' + parts.join(',') + ']'; }
        for (key in value) if (value.hasOwnProperty(key)) parts.push(quote(key) + ':' + json(value[key]));
        return '{' + parts.join(',') + '}';
    }
    function required(value, label) {
        if (typeof value !== 'string' || !value.length || value.indexOf('\u0000') >= 0) throw problem('INVALID_ARGUMENT', label + ' must be a nonempty string');
        return value;
    }
    function fileFor(path) {
        required(path, 'path');
        var norm = path.replace(/\\/g, '/');
        if (!/^[a-z]:\//i.test(norm) || /(^|\/)\.\.?($|\/)/.test(norm)) throw problem('INVALID_PATH', 'Only absolute local Windows paths without traversal are supported');
        return new File(path);
    }
    function canon(file) { return file.fsName.replace(/\\/g, '/').toLowerCase(); }
    function workingFile(path) {
        var file = fileFor(path), normalized = canon(file);
        if (!/^working\.(psd|psb)$/i.test(file.name) || normalized.indexOf('/runs/') < 0) throw problem('WORKING_COPY_REQUIRED', 'Only working.psd/working.psb inside a runs directory may be opened or modified');
        if (!file.exists) throw problem('FILE_NOT_FOUND', 'Working copy does not exist', { path: file.fsName });
        return file;
    }
    function id(value, label) {
        var parsed = Number(value);
        if (!isFinite(parsed) || parsed <= 0 || Math.floor(parsed) !== parsed) throw problem('INVALID_ARGUMENT', label + ' must be a positive integer');
        return parsed;
    }
    function documentFor(documentId, workingPath) {
        var expected = workingFile(workingPath), value = id(documentId, 'documentId'), i, doc;
        for (i = 0; i < app.documents.length; i++) if (app.documents[i].id === value) { doc = app.documents[i]; break; }
        if (!doc) throw problem('DOCUMENT_NOT_FOUND', 'The requested document is not open');
        if (canon(doc.fullName) !== canon(expected)) throw problem('DOCUMENT_PATH_MISMATCH', 'Document ID does not match the exact working-copy path', { actual: doc.fullName.fsName, expected: expected.fsName });
        return doc;
    }
    function outputFile(path, sourcePath, extension) {
        var output = fileFor(path), source = workingFile(sourcePath);
        if (!new RegExp('\\.' + extension + '$', 'i').test(output.name)) throw problem('INVALID_OUTPUT_EXTENSION', 'Expected .' + extension + ' output');
        if (canon(output.parent) !== canon(source.parent)) throw problem('OUTPUT_OUTSIDE_RUN', 'Output must be in the same task directory as the working copy');
        if (canon(output) === canon(source) || output.exists) throw problem('OUTPUT_EXISTS', 'Refusing to overwrite an existing file', { path: output.fsName });
        if (!output.parent.exists) throw problem('OUTPUT_DIRECTORY_MISSING', 'Output directory does not exist');
        return output;
    }
    function pixels(value) { return Number(value.as('px')); }
    function layerKind(layer) {
        if (layer.typename === 'LayerSet') return 'group';
        if (layer.kind === LayerKind.TEXT) return 'text';
        if (layer.kind === LayerKind.SMARTOBJECT) return 'smartObject';
        if (layer.kind === LayerKind.NORMAL) return 'pixel';
        return String(layer.kind);
    }
    function styleRanges(documentIdValue, layerIdValue) {
        var ref = new ActionReference(), result, textKey, ranges, list = [], i, range, style, stream, h, part, j;
        ref.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('textKey'));
        ref.putIdentifier(charIDToTypeID('Lyr '), layerIdValue);
        ref.putIdentifier(charIDToTypeID('Dcmn'), documentIdValue);
        result = executeActionGet(ref);
        textKey = result.getObjectValue(stringIDToTypeID('textKey'));
        ranges = textKey.getList(stringIDToTypeID('textStyleRange'));
        for (i = 0; i < ranges.count; i++) {
            range = ranges.getObjectValue(i);
            style = range.getObjectValue(stringIDToTypeID('textStyle'));
            stream = style.toStream(); h = '';
            for (j = 0; j < stream.length; j++) { part = stream.charCodeAt(j).toString(16); while (part.length < 2) part = '0' + part; h += part; }
            list.push({ from: range.getInteger(stringIDToTypeID('from')), to: range.getInteger(stringIDToTypeID('to')), styleStreamHex: h });
        }
        return list;
    }
    function layerInfo(layer, docId) {
        var kind = layerKind(layer), out = { id: layer.id, name: layer.name, kind: kind, visible: layer.visible }, bounds, i;
        try { bounds = layer.bounds; out.bounds = { left: pixels(bounds[0]), top: pixels(bounds[1]), right: pixels(bounds[2]), bottom: pixels(bounds[3]) }; }
        catch (e) { out.bounds = null; out.boundsError = String(e.message || e); }
        if (kind === 'text') {
            try { out.text = layer.textItem.contents; } catch (emptyTextError) { out.text = null; out.textReadError = String(emptyTextError); }
            try { out.font = layer.textItem.font; } catch (fontError) { out.font = null; out.fontError = String(fontError.message || fontError); }
            try { out.textStyleRanges = styleRanges(docId, layer.id); } catch (styleError) { out.textStyleReadError = String(styleError.message || styleError); }
        }
        if (kind === 'group') { out.children = []; for (i = 0; i < layer.layers.length; i++) out.children.push(layerInfo(layer.layers[i], docId)); }
        return out;
    }
    function snapshot(doc, layerSubset) {
        var profileName = null; try { profileName = doc.colorProfileName; } catch (untaggedProfile) {}
        var result = { id: doc.id, name: doc.name, fullName: doc.fullName.fsName, width: pixels(doc.width), height: pixels(doc.height), mode: String(doc.mode), colorProfile: profileName, bits: String(doc.bitsPerChannel), channels: doc.channels.length, layers: [] }, i;
        var selectedLayers=layerSubset||doc.layers;for (i = 0; i < selectedLayers.length; i++) result.layers.push(layerInfo(selectedLayers[i], doc.id));
        return result;
    }
    function ids(layers) {
        var output = [], i, child;
        for (i = 0; i < layers.length; i++) { output.push(layers[i].id); if (layers[i].typename === 'LayerSet') { child = ids(layers[i].layers); output = output.concat(child); } }
        return output;
    }
    function descriptorData(d){
        function keyName(k){var n='';try{n=typeIDToStringID(k);}catch(e){}if(!n)try{n=typeIDToCharID(k);}catch(e){}return n||String(k);}
        function value(o,k){var t=o.getType(k);if(t===DescValueType.OBJECTTYPE)return {className:keyName(o.getObjectType(k)),value:descriptorData(o.getObjectValue(k))};if(t===DescValueType.LISTTYPE){var a=[],l=o.getList(k),j;for(j=0;j<l.count;j++)a.push(value(l,j));return a;}if(t===DescValueType.STRINGTYPE)return o.getString(k);if(t===DescValueType.BOOLEANTYPE)return o.getBoolean(k);if(t===DescValueType.INTEGERTYPE)return o.getInteger(k);if(t===DescValueType.DOUBLETYPE)return o.getDouble(k);if(t===DescValueType.UNITDOUBLE)return {unit:keyName(o.getUnitDoubleType(k)),value:o.getUnitDoubleValue(k)};if(t===DescValueType.ENUMERATEDTYPE)return {type:keyName(o.getEnumerationType(k)),value:keyName(o.getEnumerationValue(k))};return String(t);}
        var out={},i;for(i=0;i<d.count;i++){var k=d.getKey(i);try{out[keyName(k)]=value(d,k);}catch(e){out[keyName(k)]={error:String(e)};}}return out;
    }
    function auditDocument(doc,layerSubset){
        var output={id:doc.id,path:doc.fullName.fsName,width:pixels(doc.width),height:pixels(doc.height),resolution:doc.resolution,bits:String(doc.bitsPerChannel),mode:String(doc.mode),profile:null,layers:[]};try{output.profile=doc.colorProfileName;}catch(noProfile){}
        function walk(layers){var list=[],j,l,o,b,t,r,d,keys,k,key;for(j=0;j<layers.length;j++){l=layers[j];o={id:l.id,name:l.name,kind:layerKind(l),visible:l.visible,opacity:l.opacity,blendMode:String(l.blendMode)};try{b=l.bounds;o.bounds=[pixels(b[0]),pixels(b[1]),pixels(b[2]),pixels(b[3])];}catch(e){}try{o.fillOpacity=l.fillOpacity;}catch(e){}
            if(o.kind==='text'){try{t=l.textItem;o.text=t.contents;o.font=t.font;o.sizePt=t.size.as('pt');o.sizePxAtResolution=o.sizePt*doc.resolution/72;o.color=t.color.rgb.hexValue;o.tracking=t.tracking;o.fauxItalic=t.fauxItalic;o.fauxBold=t.fauxBold;o.antiAlias=String(t.antiAliasMethod);o.justification=String(t.justification);try{o.strikeThru=String(t.strikeThru);}catch(noStrike){}}catch(e){o.textError=String(e);}}
            try{r=new ActionReference();r.putIdentifier(charIDToTypeID('Lyr '),l.id);r.putIdentifier(charIDToTypeID('Dcmn'),doc.id);d=executeActionGet(r);o.properties={};keys=['hasUserMask','hasVectorMask','userMaskFeather','vectorMaskFeather','userMaskDensity','vectorMaskDensity'];for(k=0;k<keys.length;k++){key=stringIDToTypeID(keys[k]);if(d.hasKey(key)){var ty=d.getType(key);if(ty===DescValueType.BOOLEANTYPE)o.properties[keys[k]]=d.getBoolean(key);else if(ty===DescValueType.DOUBLETYPE)o.properties[keys[k]]=d.getDouble(key);else if(ty===DescValueType.UNITDOUBLE)o.properties[keys[k]]=d.getUnitDoubleValue(key);else if(ty===DescValueType.INTEGERTYPE)o.properties[keys[k]]=d.getInteger(key);}}
                if(o.kind==='LayerKind.GRADIENTFILL'&&d.hasKey(stringIDToTypeID('adjustment'))){var adj=d.getList(stringIDToTypeID('adjustment')).getObjectValue(0);o.gradientKeys=[];for(k=0;k<adj.count;k++)o.gradientKeys.push(typeIDToStringID(adj.getKey(k)));}
            }catch(e){o.descriptorError=String(e);}if(o.kind==='group')o.children=walk(l.layers);list.push(o);}return list;}
        output.layers=walk(layerSubset||doc.layers);return output;
    }
    function invariant(doc) { return json({ mode: String(doc.mode), profile: doc.colorProfileName, width: pixels(doc.width), height: pixels(doc.height), layers: ids(doc.layers), path: doc.fullName.fsName }); }
    function findLayer(layers, layerId) {
        var i, match;
        for (i = 0; i < layers.length; i++) {
            if (layers[i].id === layerId) return layers[i];
            if (layers[i].typename === 'LayerSet') { match = findLayer(layers[i].layers, layerId); if (match) return match; }
        }
        return null;
    }
    var operation = String(argv[0] || ''), documentId = String(argv[1] || ''), path = String(argv[2] || ''), sourcePath = String(argv[3] || ''), layerId = String(argv[4] || ''), expectedText = String(argv[5] || ''), text = String(argv[6] || ''), format = String(argv[7] || '');
    var oldDialogs, oldCompatibility, settingsCaptured = false, result, failure, doc, file, i, options, oldState, temp, tempId, before, output, closeFailure;
    try {
        oldDialogs = app.displayDialogs;
        oldCompatibility = app.preferences.maximizeCompatibility;
        settingsCaptured = true;
        app.displayDialogs = DialogModes.NO;
        if (operation === 'ping') {
            var documents = [], d;
            for (i = 0; i < app.documents.length; i++) { d = app.documents[i]; var docPath = null; try { docPath = d.fullName.fsName; } catch (noPath) {} documents.push({ id: d.id, name: d.name, path: docPath }); }
            result = { connected: true, backend: 'real-com', photoshopVersion: app.version, documentCount: app.documents.length, documents: documents };
        }
        else if (operation === 'font_catalog') {
            var fonts=[];for(i=0;i<app.fonts.length;i++){var f=app.fonts[i];if(/MiSans|SourceHanSans|Futura|Arial|HarmonyOS|AlimamaFangYuan/.test(f.postScriptName))fonts.push({postScriptName:f.postScriptName,name:f.name});}result={backend:'real-com',fonts:fonts};
        }
        else if(operation==='purge_idle_history'){
            if(app.documents.length!==0)throw problem('OPEN_DOCUMENTS_PROTECTED','History cache cleanup requires zero open documents');
            app.purge(PurgeTarget.HISTORYCACHES);$.gc();result={backend:'real-com',openDocuments:0,historyCachePurged:true,clipboardUntouched:true};
        }
        else if(operation==='close_created_probe'){
            doc=null;for(i=0;i<app.documents.length;i++)if(app.documents[i].id===id(documentId,'documentId'))doc=app.documents[i];
            if(!doc||doc.name!=='00_\u63a5\u53e3\u9a8c\u8bc1'||expectedText!==doc.name)throw problem('PROBE_NOT_FOUND','Only a known named scratch probe may be discarded');
            var savedProbePath=null;try{savedProbePath=doc.fullName;}catch(unsavedProbe){}
            if(savedProbePath)throw problem('SAVED_DOCUMENT_PROTECTED','Refusing to discard a saved document');
            var discardedId=doc.id;doc.close(SaveOptions.DONOTSAVECHANGES);result={backend:'real-com',closedProbeId:discardedId};
        }
        else if (operation === 'render_design') result = renderDesign(path);
        else if (operation === 'render_native_catalog') result = renderNativeCatalog(path);
        else if (operation === 'export_native_slices') result = exportNativeSlices(path);
        else if (operation === 'render_native_variant') result = renderNativeVariant(path);
        else if(operation==='discard_failed_render'){
            file=fileFor(path);if(canon(file).indexOf('/runs/')<0||!/\.json$/i.test(file.name))throw problem('INVALID_PLAN','Expected a local run plan');file.encoding='UTF8';file.open('r');var failedPlan;try{failedPlan=parseDataJSON(file.read());}finally{file.close();}
            doc=null;for(i=0;i<app.documents.length;i++)if(app.documents[i].id===id(documentId,'documentId'))doc=app.documents[i];
            if(!doc||failedPlan.kind!=='compose'||doc.name!==failedPlan.name||new File(failedPlan.psd).exists||new File(failedPlan.png).exists)throw problem('RECOVERY_PRECONDITION_FAILED','Failed render identity or absent-output checks failed');
            var existingSavedPath=null;try{existingSavedPath=doc.fullName;}catch(unsavedRender){}if(existingSavedPath)throw problem('SAVED_DOCUMENT_PROTECTED','Only an unsaved failed render can be discarded');
            var discardedRenderId=doc.id;doc.close(SaveOptions.DONOTSAVECHANGES);result={backend:'real-com',discardedUnsavedRender:discardedRenderId};
        }
        else if (operation === 'open_working_copy') {
            file = workingFile(path);
            for (i = 0; i < app.documents.length; i++) {
                var existingPath = null;
                try { existingPath = app.documents[i].fullName; } catch (unsavedDocument) { /* Unsaved user documents have no fullName. */ }
                if (existingPath && canon(existingPath) === canon(file)) throw problem('DOCUMENT_ALREADY_OPEN', 'Working copy is already open; refusing to adopt it');
            }
            doc = app.open(file);
            if (canon(doc.fullName) !== canon(file)) throw problem('DOCUMENT_PATH_MISMATCH', 'Photoshop opened a different file');
            var openedProfile=null;try{openedProfile=doc.colorProfileName;}catch(noOpenedProfile){}
            result = { id: doc.id, name: doc.name, fullName: doc.fullName.fsName, width: pixels(doc.width), height: pixels(doc.height), mode: String(doc.mode), colorProfile: openedProfile, backend: 'real-com' };
        } else if (operation === 'inspect_document') result = snapshot(documentFor(documentId, sourcePath || path));
        else if(operation==='layer_descriptor'){doc=documentFor(documentId,sourcePath);app.activeDocument=doc;var lr=new ActionReference();lr.putIdentifier(charIDToTypeID('Lyr '),id(layerId,'layerId'));lr.putIdentifier(charIDToTypeID('Dcmn'),doc.id);result=descriptorData(executeActionGet(lr));}
        else if(operation==='audit_document'){doc=documentFor(documentId,sourcePath);app.activeDocument=doc;result=auditDocument(doc);}
        else if (operation === 'set_text') {
            doc = documentFor(documentId, sourcePath); app.activeDocument = doc;
            var target = findLayer(doc.layers, id(layerId, 'layerId'));
            if (!target || layerKind(target) !== 'text') throw problem('TEXT_LAYER_NOT_FOUND', 'Requested layer is not editable text');
            if (target.textItem.contents !== expectedText) throw problem('TEXT_PRECONDITION_FAILED', 'Actual text differs from the supplied exact previous contents', { actualText: target.textItem.contents, expectedText: expectedText });
            oldState = doc.activeHistoryState;
            try { target.textItem.contents = text; if (target.textItem.contents !== text) throw problem('TEXT_READBACK_FAILED', 'Text readback differs from the exact requested text'); }
            catch (textError) { try { doc.activeHistoryState = oldState; } catch (rollbackError) { throw problem('ROLLBACK_FAILED', 'Text operation and rollback failed', { outcome: 'unknown', cause: String(textError), rollback: String(rollbackError) }); } throw textError; }
            result = layerInfo(target, doc.id);
        } else if (operation === 'save_psd') {
            doc = documentFor(documentId, sourcePath); app.activeDocument = doc;
            if (pixels(doc.width) > 30000 || pixels(doc.height) > 30000) throw problem('PSD_LIMIT_EXCEEDED', 'Document exceeds PSD dimension limits; no flattening or resizing was performed');
            output = outputFile(path, sourcePath, 'psd'); before = invariant(doc);
            options = new PhotoshopSaveOptions(); options.layers = true; options.alphaChannels = true; options.spotColors = true; options.annotations = true; options.embedColorProfile = true; options.maximizeCompatibility = true;
            app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
            doc.saveAs(output, options, true, Extension.LOWERCASE);
            if (invariant(doc) !== before) throw problem('SOURCE_DOCUMENT_CHANGED', 'Saving changed the source path, mode, profile, dimensions or layer IDs', { outcome: 'unknown' });
            if (!output.exists || output.length <= 0) throw problem('OUTPUT_MISSING', 'Photoshop did not write the PSD file');
            result = { documentId: doc.id, path: output.fsName, bytes: output.length, format: 'psd', mode: String(doc.mode), layersPreserved: true, backend: 'real-com' };
        } else if (operation === 'export_preview') {
            if (format !== 'png' && format !== 'jpg') throw problem('INVALID_FORMAT', 'Export format must be png or jpg');
            doc = documentFor(documentId, sourcePath); app.activeDocument = doc;
            output = outputFile(path, sourcePath, format); before = invariant(doc);
            try {
                temp = doc.duplicate('Design Agent temporary export ' + new Date().getTime(), true); tempId = temp.id;
                if (tempId === doc.id) throw problem('INVALID_DUPLICATE', 'Export duplicate must be a distinct document');
                app.activeDocument = temp;
                try { if (temp.mode !== DocumentMode.RGB) temp.changeMode(ChangeMode.RGB); temp.convertProfile('sRGB IEC61966-2.1', Intent.RELATIVECOLORIMETRIC, true, true); }
                catch (conversionError) { throw problem('UNSUPPORTED_PREVIEW_MODE', 'Temporary RGB/sRGB conversion failed', { sourceMode: String(doc.mode), cause: String(conversionError.message || conversionError) }); }
                if (temp.mode !== DocumentMode.RGB || temp.colorProfileName !== 'sRGB IEC61966-2.1') throw problem('UNSUPPORTED_PREVIEW_MODE', 'Temporary RGB/sRGB conversion could not be verified');
                options = format === 'jpg' ? new JPEGSaveOptions() : new PNGSaveOptions();
                if (format === 'jpg') { options.quality = 12; options.embedColorProfile = true; }
                temp.saveAs(output, options, true, Extension.LOWERCASE);
            } finally {
                if (temp && tempId !== doc.id) { try { temp.close(SaveOptions.DONOTSAVECHANGES); } catch (cleanupError) { closeFailure = cleanupError; } }
                app.activeDocument = doc;
                if (invariant(doc) !== before) throw problem('SOURCE_DOCUMENT_CHANGED', 'Raster export changed the working document', { outcome: 'unknown' });
                if (closeFailure) throw problem('TEMP_DOCUMENT_CLEANUP_FAILED', 'Unable to close disposable export document', { outcome: 'unknown', cause: String(closeFailure.message || closeFailure) });
            }
            if (!output.exists || output.length <= 0) throw problem('OUTPUT_MISSING', 'Photoshop did not write an export file');
            result = { documentId: doc.id, path: output.fsName, bytes: output.length, format: format, backend: 'real-com', color: { sourceMode: String(doc.mode), sourceProfile: doc.colorProfileName, outputProfile: 'sRGB IEC61966-2.1', conversionScope: 'temporary-merged-duplicate', requiresColorReview: true } };
        } else if (operation === 'close_document') {
            doc = documentFor(documentId, sourcePath || path); var closedId = doc.id;
            doc.close(SaveOptions.DONOTSAVECHANGES);
            result = { documentId: closedId, closed: true, saved: false, backend: 'real-com' };
        } else throw problem('UNKNOWN_OPERATION', 'Operation is not allowed');
    } catch (error) { failure = { code: error.code || 'PHOTOSHOP_COM_ERROR', message: String(error.message || error), details: error.details || { number: error.number || null, line: error.line || null } }; }
    finally {
        if (settingsCaptured) {
            try { app.preferences.maximizeCompatibility = oldCompatibility; app.displayDialogs = oldDialogs; }
            catch (restoreError) { failure = { code: 'SETTINGS_RESTORE_FAILED', message: String(restoreError.message || restoreError), details: { outcome: 'unknown', priorError: failure || null } }; }
        }
    }
    return json(failure ? { ok: false, error: failure } : { ok: true, result: result });
})(arguments);
