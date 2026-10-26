import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandQueue } from '../src/bridge/queue.js';
import { PhotoshopService } from '../src/bridge/service.js';
import { FilePolicy, hashFile, inside } from '../src/paths.js';
import { Journal } from '../src/journal.js';
import type { Command } from '../src/contracts.js';

// Explicit test-only peer emulator. These bytes verify transport/file safeguards,
// never claim to be valid editable Photoshop documents or rendered images.
const signatureOnlyPsd = Buffer.concat([Buffer.from([56,66,80,83,0,1]), Buffer.alloc(32)]);
const signatureOnlyPng = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(32)]);
const isCode = (code: string) => (error: any) => error?.code === code;

async function setup(t: any, connected = true) {
  const root = await mkdtemp(join(tmpdir(), 'das-service-tests-'));
  const inputRoot = join(root, 'inputs');
  await mkdir(inputRoot);
  const template = join(inputRoot, 'source.psd');
  const product = join(inputRoot, 'product.png');
  await writeFile(template, signatureOnlyPsd);
  await writeFile(product, signatureOnlyPng);
  const queue = new CommandQueue(1000);
  const journal = new Journal(join(root, 'journal.jsonl'));
  const service = new PhotoshopService(queue, new FilePolicy(root, { port: 57123, allowedInputRoots: ['inputs'], outputRoot: 'outputs', commandTimeoutMs: 1000 }), journal);
  t.after(async () => { queue.close(); await rm(root, { recursive: true, force: true }); });
  const sessionId = connected ? queue.hello({ pluginVersion: 'test-emulator', photoshopVersion: 'TEST-NOT-PHOTOSHOP' }).sessionId : '';
  async function dispatch(operation: string, args: unknown, peer: (command: Command) => Promise<unknown> | unknown) {
    const result = service.execute(operation, args).then(value => ({ value, error: undefined as any }), error => ({ value: undefined, error }));
    const command = await queue.next(sessionId, 250);
    assert.ok(command, 'Service should dispatch a command to the explicit test peer');
    try {
      queue.finish({ sessionId, id: command.id, ok: true, result: await peer(command) });
    } catch (error) { queue.close(); throw error; }
    const outcome = await result;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
  const openWorking = () => dispatch('open_working_copy', { templatePath: template }, command => {
    assert.equal(command.operation, 'open_document');
    assert.notEqual(command.args.path, template);
    return { id: 7, name: 'working.psd', width: 800, height: 800 };
  });
  return { root, queue, journal, service, template, product, sessionId, dispatch, openWorking };
}

test('real service refuses absent Photoshop, records specific failure, and creates no pretend output', async t => {
  const { service, journal } = await setup(t, false);
  assert.equal(service.status().mode, 'real-uxp');
  assert.equal(service.status().connected, false);
  await assert.rejects(service.execute('ping', {}), isCode('PHOTOSHOP_DISCONNECTED'));
  const entries = (await readFile(journal.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(e => e.event), ['operation_requested', 'operation_failed']);
  assert.equal(entries.at(-1).error.code, 'PHOTOSHOP_DISCONNECTED');
});

test('service rejects arbitrary commands, unknown fields, and writes to unmanaged Photoshop documents', async t => {
  const { service, queue } = await setup(t);
  await assert.rejects(service.execute('eval', { code: 'anything' }), isCode('UNKNOWN_OPERATION'));
  await assert.rejects(service.execute('set_text', { documentId: 8, layerId: 1, text: 'x', script: 'unexpected' }));
  await assert.rejects(service.execute('set_text', { documentId: 8, layerId: 1, text: 'x' }), isCode('UNMANAGED_DOCUMENT'));
  await assert.rejects(service.execute('close_document', { documentId: 8, save: true }));
  assert.equal(queue.busy, false);
});

test('service copies template and replacement asset, confines outputs, and preserves original input hashes', async t => {
  const { service, template, product, dispatch, openWorking, journal } = await setup(t);
  const originalTemplateHash = await hashFile(template);
  const originalAssetHash = await hashFile(product);
  const opened = await openWorking();
  assert.equal(opened.id, 7);
  assert.equal(opened.sourceHash, originalTemplateHash);
  const run = service.runs.get(7)!;
  assert.equal(inside(run.dir, opened.workingPath), true);
  await dispatch('replace_smart_object', { documentId: 7, layerId: 2, path: product }, async command => {
    assert.equal(command.operation, 'replace_smart_object');
    assert.notEqual(command.args.path, product);
    assert.equal(inside(run.dir, String(command.args.path)), true);
    assert.deepEqual(await readFile(String(command.args.path)), await readFile(product));
    return { layerId: 2, replaced: true };
  });
  const exported = await dispatch('get_preview', { documentId: 7, name: 'preview' }, async command => {
    assert.equal(command.operation, 'get_preview');
    assert.equal(command.args.name, undefined);
    await writeFile(String(command.args.path), signatureOnlyPng, { flag: 'wx' });
    return { width: 800, height: 800 };
  });
  assert.equal(inside(run.dir, exported.path), true);
  assert.equal(await hashFile(template), originalTemplateHash);
  assert.equal(await hashFile(product), originalAssetHash);
  assert.equal(run.files.length, 1);
  const second = await dispatch('get_preview', { documentId: 7, name: 'preview' }, async command => {
    await writeFile(String(command.args.path), signatureOnlyPng, { flag: 'wx' });
    return {};
  });
  assert.notEqual(second.path, exported.path);
  assert.deepEqual(await readFile(exported.path), signatureOnlyPng);
  const records = (await readFile(journal.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(e => e.event === 'operation_succeeded').length, 4);
});

test('output signature validation rejects plugin success without a matching image file', async t => {
  const { service, dispatch, openWorking } = await setup(t);
  await openWorking();
  await assert.rejects(dispatch('export_image', { documentId: 7, format: 'png' }, async command => {
    await writeFile(String(command.args.path), 'not a PNG image', { flag: 'wx' });
    return { exported: true };
  }), isCode('INVALID_OUTPUT'));
  assert.deepEqual(service.runs.get(7)!.files, []);
});

test('source integrity check prevents marking a changed original as successfully delivered', async t => {
  const { service, template, dispatch, openWorking } = await setup(t);
  await openWorking();
  await writeFile(template, Buffer.concat([signatureOnlyPsd, Buffer.from('external modification')]));
  await assert.rejects(dispatch('save_psd', { documentId: 7 }, async command => {
    await writeFile(String(command.args.path), signatureOnlyPsd, { flag: 'wx' });
    return { saved: true };
  }), isCode('SOURCE_CHANGED'));
  assert.deepEqual(service.runs.get(7)!.files, []);
});

test('service lock covers async preparation, releases after result, and close removes managed ownership', async t => {
  const { service, queue, sessionId, openWorking, dispatch } = await setup(t);
  await openWorking();
  const pending = service.execute('set_text', { documentId: 7, layerId: 2, text: 'one' });
  await assert.rejects(service.execute('set_text', { documentId: 7, layerId: 2, text: 'two' }), isCode('BUSY'));
  const command = await queue.next(sessionId);
  queue.finish({ sessionId, id: command!.id, ok: true, result: { text: 'one' } });
  await pending;
  await dispatch('close_document', { documentId: 7, save: false }, command => {
    assert.equal(command.operation, 'close_document');
    return { closed: true };
  });
  await assert.rejects(service.execute('set_visibility', { documentId: 7, layerId: 2, visible: false }), isCode('UNMANAGED_DOCUMENT'));
});

test('local asset preflight works without Photoshop, returns canonical hashes and never queues, copies or exports', async t => {
  const { root, queue, service, template, product, journal } = await setup(t, false);
  const templateHash = await hashFile(template);
  const productHash = await hashFile(product);
  const result = await service.execute('preflight_assets', { templatePath: template, productImagePath: product, referencePath: product });
  assert.equal(result.kind, 'local-asset-preflight');
  assert.equal(result.photoshopExecuted, false);
  assert.equal(result.templatePath, template);
  assert.equal(result.productImagePath, product);
  assert.equal(result.referencePath, product);
  assert.deepEqual(result.assets.map((asset: any) => ({ role: asset.role, sha256: asset.sha256 })), [
    { role: 'template', sha256: templateHash }, { role: 'product', sha256: productHash }, { role: 'reference', sha256: productHash }
  ]);
  assert.equal(queue.busy, false);
  assert.equal(queue.connected, false);
  assert.equal(service.runs.size, 0);
  assert.deepEqual((await readdir(root)).sort(), ['inputs', 'journal.jsonl']);
  assert.equal(await hashFile(template), templateHash);
  assert.equal(await hashFile(product), productHash);
  const records = (await readFile(journal.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(entry => entry.event), ['operation_requested', 'operation_succeeded']);
  assert.ok(records.every(entry => entry.operation === 'preflight_assets'));
});

test('asset preflight rejects disallowed paths and invalid PSD/PSB headers before any Photoshop command', async t => {
  const { root, queue, service, template, product } = await setup(t, false);
  const outside = join(root, 'outside.png');
  await writeFile(outside, signatureOnlyPng);
  await assert.rejects(service.execute('preflight_assets', { templatePath: template, productImagePath: outside }), isCode('INPUT_OUTSIDE_ROOT'));
  await writeFile(template, Buffer.from('this is not a PSD template'));
  await assert.rejects(service.execute('preflight_assets', { templatePath: template, productImagePath: product }), isCode('INVALID_PSD'));
  await writeFile(template, Buffer.concat([Buffer.from([56,66,80,83,0,2]), Buffer.alloc(32)]));
  await assert.rejects(service.execute('preflight_assets', { templatePath: template, productImagePath: product }), isCode('INVALID_PSD'));
  assert.equal(queue.busy, false);
  assert.equal(service.runs.size, 0);
});

test('asset preflight accepts PSB version 2 while uncertain Photoshop execution remains locked', async t => {
  const { root, queue, service, product } = await setup(t, false);
  const psb = join(root, 'inputs', 'large-template.psb');
  await writeFile(psb, Buffer.concat([Buffer.from([56,66,80,83,0,2]), Buffer.alloc(32)]));
  queue.uncertain = true;
  const result = await service.execute('preflight_assets', { templatePath: psb, productImagePath: product });
  assert.equal(result.assets[0].format, 'psb');
  assert.equal(result.photoshopExecuted, false);
  assert.equal(queue.uncertain, true);
  assert.equal(queue.busy, false);
});
