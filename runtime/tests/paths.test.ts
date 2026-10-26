import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { FilePolicy, hashFile, inside } from '../src/paths.js';

const isCode = (code: string) => (error: any) => error?.code === code;
const fakePsd = Buffer.concat([Buffer.from([56, 66, 80, 83, 0, 1]), Buffer.alloc(32)]); // Header-only fixture, never an editable Photoshop PSD.

async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'das-path-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = join(root, 'inputs');
  await mkdir(inputs);
  const policy = new FilePolicy(root, { port: 57123, allowedInputRoots: ['inputs'], outputRoot: 'outputs', commandTimeoutMs: 100 });
  const source = join(inputs, 'template.psd');
  await writeFile(source, fakePsd);
  return { root, inputs, source, policy };
}

test('path containment rejects sibling-prefix confusion and traversal', () => {
  const root = resolve('allowed');
  assert.equal(inside(root, join(root, 'nested', 'file.psd')), true);
  assert.equal(inside(root, root), true);
  assert.equal(inside(root, resolve('allowed-other', 'file.psd')), false);
  assert.equal(inside(root, resolve(root, '..', 'file.psd')), false);
});

test('input policy enforces canonical allowed roots, extensions, regular files and PSD signature', async t => {
  const { root, inputs, policy } = await setup(t);
  const outside = join(root, 'outside.psd');
  await writeFile(outside, fakePsd);
  await assert.rejects(policy.input(outside, ['.psd']), isCode('INPUT_OUTSIDE_ROOT'));
  await writeFile(join(inputs, 'text.txt'), 'content');
  await assert.rejects(policy.input(join(inputs, 'text.txt'), ['.psd']), isCode('UNSUPPORTED_FILE'));
  await mkdir(join(inputs, 'folder.psd'));
  await assert.rejects(policy.input(join(inputs, 'folder.psd'), ['.psd']), isCode('NOT_A_FILE'));
  await writeFile(join(inputs, 'invalid.psd'), 'this is not a Photoshop file');
  await assert.rejects(policy.newRun(join(inputs, 'invalid.psd')), isCode('INVALID_PSD'));
});

test('each working run is a separate copy and writing the copy leaves the original hash unchanged', async t => {
  const { source, policy } = await setup(t);
  const originalHash = await hashFile(source);
  const first = await policy.newRun(source);
  const second = await policy.newRun(source);
  assert.notEqual(first.workingPath, second.workingPath);
  assert.notEqual(first.workingPath, source);
  assert.equal(first.sourceHash, originalHash);
  assert.deepEqual(await readFile(first.workingPath), await readFile(source));
  await writeFile(first.workingPath, 'working copy edited by test');
  assert.equal(await hashFile(source), originalHash);
  assert.deepEqual(await readFile(second.workingPath), fakePsd);
});

test('PSB template remains an exact PSB working copy with its original extension and source hash', async t => {
  const { inputs, policy } = await setup(t);
  // Header version 2 is PSB; bytes are only a synthetic transport fixture.
  const psb = Buffer.concat([Buffer.from([56, 66, 80, 83, 0, 2]), Buffer.alloc(36), Buffer.from('synthetic PSB test payload')]);
  const source = join(inputs, 'large-template.psb');
  await writeFile(source, psb);
  const before = await hashFile(source);
  const run = await policy.newRun(source);
  assert.equal(extname(run.workingPath), '.psb');
  assert.deepEqual(await readFile(run.workingPath), psb);
  assert.equal(run.sourceHash, before);
  assert.equal(await hashFile(source), before);
});

test('PSD/PSB extension mismatch cannot silently create a working file with the wrong format', async t => {
  const { inputs, policy } = await setup(t);
  const psbWithPsdName = join(inputs, 'mislabeled.psd');
  const psdWithPsbName = join(inputs, 'mislabeled.psb');
  await writeFile(psbWithPsdName, Buffer.concat([Buffer.from([56,66,80,83,0,2]), Buffer.alloc(32)]));
  await writeFile(psdWithPsbName, fakePsd);
  await assert.rejects(policy.newRun(psbWithPsdName), isCode('INVALID_PSD'));
  await assert.rejects(policy.newRun(psdWithPsbName), isCode('INVALID_PSD'));
});

test('output names cannot escape a run, use device names, or overwrite a prior delivery', async t => {
  const { source, policy } = await setup(t);
  const run = await policy.newRun(source);
  for (const name of ['../template', '..\\template', 'sub/file', 'sub\\file', 'CON', 'nul.jpg', 'com1', '.', '..', 'trailing.', 'trailing ', 'a:b']) {
    await assert.rejects(policy.output(run.dir, name, 'png'), isCode('INVALID_OUTPUT_NAME'), name);
  }
  const first = await policy.output(run.dir, '商品主图', 'png');
  await writeFile(first, 'existing delivery', { flag: 'wx' });
  const second = await policy.output(run.dir, '商品主图', 'png');
  assert.notEqual(first, second);
  assert.equal(inside(run.dir, first), true);
  assert.equal(inside(run.dir, second), true);
  assert.equal((await stat(first)).isFile(), true);
  assert.equal(await readFile(first, 'utf8'), 'existing delivery');
});

test('symlink or Windows junction under allowed root cannot redirect input outside it', async t => {
  const { root, inputs, policy } = await setup(t);
  const outside = join(root, 'external');
  await mkdir(outside);
  await writeFile(join(outside, 'external.psd'), fakePsd);
  const redirect = join(inputs, 'redirect');
  try { await symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error: any) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Platform does not permit test symlinks/junctions'); return; }
    throw error;
  }
  await assert.rejects(policy.input(join(redirect, 'external.psd'), ['.psd']), isCode('INPUT_OUTSIDE_ROOT'));
});

test('workbook download roots do not authorize design assets, and missing configured roots do not broaden access', async t => {
  const { root, inputs, source } = await setup(t);
  const workbooks = join(root, 'workbooks');
  await mkdir(workbooks);
  const xlsx = join(workbooks, 'requirements.xlsx');
  const assetInWorkbookRoot = join(workbooks, 'untrusted-template.psd');
  const workbookInAssetRoot = join(inputs, 'not-an-authorized-workbook.xlsx');
  await writeFile(xlsx, 'TEST ONLY: .xlsx path authorization fixture');
  await writeFile(assetInWorkbookRoot, fakePsd);
  await writeFile(workbookInAssetRoot, 'TEST ONLY: unauthorized workbook path');
  const policy = new FilePolicy(root, { port: 57123, allowedInputRoots: ['inputs', 'missing-asset-root'], workbookRoots: ['workbooks', 'missing-workbook-root'], outputRoot: 'outputs', commandTimeoutMs: 100 });
  assert.equal(await policy.input(xlsx, ['.xlsx']), xlsx);
  assert.equal(await policy.input(source, ['.psd']), source);
  await assert.rejects(policy.input(assetInWorkbookRoot, ['.psd']), isCode('INPUT_OUTSIDE_ROOT'));
  await assert.rejects(policy.input(workbookInAssetRoot, ['.xlsx']), isCode('INPUT_OUTSIDE_ROOT'));
});
