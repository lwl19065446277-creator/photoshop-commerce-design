import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask, getExecution, listExecutions, pauseExecution, reviewExecution, snapshot, type PhotoshopClient } from '../src/runner.js';
import { StudioError } from '../src/errors.js';
import type { DesignTask, DocumentSnapshot } from '../src/tasks/model.js';

/** Explicit injected test peer. No Photoshop operation, rendered preview or editable PSD is asserted. */
async function fixture(t: any, options: { ignoreTextWrites?: number; badBounds?: boolean; wrongSize?: boolean; failOperation?: string; failureCode?: string; pauseOperation?: string } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'das-runner-test-peer-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const task: DesignTask = {
    id: 'test-task', source: { workbook: join(workspace, 'synthetic.xlsx'), sheet: 'Test', row: 2 }, status: 'ready', issues: [],
    productName: '模拟测试商品', sku: '0001', title: '准确主标题', subtitle: '副标题', width: 800, height: 800,
    templatePath: join(workspace, 'mock-input.psd'), productImagePath: join(workspace, 'mock-product.png'),
    titleLayer: 'title', subtitleLayer: 'subtitle', productLayer: 'product', outputName: 'test-output', layout: { translateX: 4, translateY: 2, scalePercent: 100 }
  };
  const document: DocumentSnapshot = {
    id: 7, name: 'MOCK-NOT-A-PHOTOSHOP-DOCUMENT', width: options.wrongSize ? 600 : 800, height: 800,
    layers: [
      { id: 11, name: 'title', kind: 'text', visible: true, text: 'old title', bounds: { left: 20, top: 20, right: options.badBounds ? 900 : 400, bottom: 70 } },
      { id: 12, name: 'subtitle', kind: 'text', visible: true, text: 'old subtitle', bounds: { left: 20, top: 80, right: 400, bottom: 120 } },
      { id: 13, name: 'product', kind: 'smartObject', visible: true, bounds: { left: 100, top: 200, right: 700, bottom: 700 } }
    ]
  };
  const calls: { operation: string; args: Record<string, unknown> }[] = [];
  let executionId = '';
  let titleWriteCount = 0;
  let outputCount = 0;
  let paused = false;
  const client: PhotoshopClient = {
    async execute(operation, args) {
      calls.push({ operation, args: structuredClone(args) });
      if (operation === options.failOperation) throw new StudioError(options.failureCode ?? 'TEST_PEER_ERROR', 'Explicit synthetic peer failure');
      if (operation === options.pauseOperation && !paused) {
        paused = true;
        await pauseExecution(workspace, executionId);
      }
      if (operation === 'preflight_assets') return { kind: 'local-asset-preflight', photoshopExecuted: false, ...args, assets: [{ role: 'template', path: args.templatePath, sha256: 'test-peer-only' }, { role: 'product', path: args.productImagePath, sha256: 'test-peer-only' }] };
      if (operation === 'open_working_copy') return { id: 7, runId: 'test-peer-run', workingPath: join(workspace, 'mock-working.psd') };
      if (operation === 'get_document_info') return { id: document.id, name: document.name, width: document.width, height: document.height };
      if (operation === 'list_layers') return { layers: structuredClone(document.layers) };
      if (operation === 'set_text') {
        const layer = document.layers.find(layer => layer.id === args.layerId)!;
        if (layer.id === 11) titleWriteCount++;
        if (layer.id !== 11 || titleWriteCount > (options.ignoreTextWrites ?? 0)) layer.text = String(args.text);
        return { id: layer.id, text: layer.text };
      }
      if (operation === 'transform_layer') {
        const bounds = document.layers.find(layer => layer.id === args.layerId)!.bounds!;
        bounds.left += Number(args.translateX ?? 0); bounds.right += Number(args.translateX ?? 0);
        bounds.top += Number(args.translateY ?? 0); bounds.bottom += Number(args.translateY ?? 0);
        return { transformed: true };
      }
      if (operation === 'replace_smart_object') return { replaced: true, testPeer: true };
      if (['get_preview', 'save_psd', 'export_image'].includes(operation)) {
        const path = join(workspace, `MOCK-TEST-ONLY-${outputCount++}.${operation === 'save_psd' ? 'psd' : args.format || 'png'}`);
        await writeFile(path, 'MOCK TEST ONLY: not a rendered image or editable Photoshop document\n');
        return { path, testPeer: true };
      }
      throw new Error(`Unexpected fixture operation: ${operation}`);
    }
  };
  async function run(overrides: Partial<DesignTask> = {}, runOptions: Parameters<typeof runTask>[3] = {}) {
    return runTask(workspace, client, { ...task, ...overrides }, { ...runOptions, onStart: id => { executionId = id; runOptions?.onStart?.(id); } });
  }
  async function events(id: string) {
    return (await readFile(join(workspace, '.studio', 'tasks', id, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  }
  return { workspace, task, document, client, calls, run, events };
}

test('runner executes an inspected template plan in order, saves traces, and always waits for preview review', async t => {
  const { workspace, calls, run, events } = await fixture(t);
  const record = await run();
  assert.equal(record.status, 'review_required');
  assert.equal((record.checks as any).structuralPass, true);
  assert.equal((record.checks as any).requiresHumanReview, true);
  assert.equal(record.outputs.length, 3);
  assert.equal((record.preflight as any).photoshopExecuted, false);
  assert.equal(calls.find(call => call.operation === 'set_text')?.args.text, '准确主标题');
  assert.deepEqual(calls.map(call => call.operation), [
    'preflight_assets', 'open_working_copy', 'get_document_info', 'list_layers', 'set_text', 'set_text', 'replace_smart_object', 'transform_layer',
    'get_preview', 'get_document_info', 'list_layers', 'save_psd', 'export_image', 'export_image'
  ]);
  const logged = await events(record.executionId);
  assert.equal(logged.filter(entry => entry.event === 'step_started').length, calls.length);
  assert.equal(logged.filter(entry => entry.event === 'step_finished').length, calls.length);
  assert.ok(logged.some(entry => entry.event === 'plan_generated'));
  assert.equal(logged.at(-1).event, 'awaiting_visual_review');
  assert.equal((await getExecution(workspace, record.executionId)).status, 'review_required');
  assert.equal((await listExecutions(workspace)).length, 1);
});

test('needs_input task makes no Photoshop calls and invalid inspected dimensions stop before mutation', async t => {
  const blocked = await fixture(t);
  const record = await blocked.run({ status: 'needs_input', issues: [{ code: 'MISSING_ASSET', message: 'missing product', severity: 'error' }] });
  assert.equal(record.status, 'needs_input');
  assert.deepEqual(blocked.calls, []);
  const mismatch = await fixture(t, { wrongSize: true });
  const stopped = await mismatch.run();
  assert.equal(stopped.status, 'needs_input');
  assert.equal((stopped.error as any).code, 'DIMENSION_MISMATCH');
  assert.deepEqual(mismatch.calls.map(call => call.operation), ['preflight_assets', 'open_working_copy', 'get_document_info', 'list_layers']);
});

test('bad actual bounds stop delivery, never export, and cannot be approved as a successful task', async t => {
  const { workspace, calls, run } = await fixture(t, { badBounds: true });
  const record = await run({}, { maxCorrections: 2 });
  assert.equal(record.status, 'failed');
  assert.equal((record.error as any).code, 'DESIGN_CHECKS_FAILED');
  assert.equal((record.checks as any).structuralPass, false);
  assert.equal(calls.filter(call => call.operation === 'get_preview').length, 1);
  assert.ok(!calls.some(call => ['save_psd', 'export_image'].includes(call.operation)));
  assert.deepEqual(record.outputs, []);
  await assert.rejects(reviewExecution(workspace, record.executionId, 'approved', ['cannot approve failed structure'], 'test reviewer'), (error: any) => error.code === 'TASK_NOT_REVIEWABLE');
});

test('exact text correction is bounded and a peer refusing edits cannot cause an infinite retry loop', async t => {
  const { calls, run, events } = await fixture(t, { ignoreTextWrites: 100 });
  const record = await run({}, { maxCorrections: 1 });
  assert.equal(record.status, 'failed');
  assert.equal((record.error as any).code, 'DESIGN_CHECKS_FAILED');
  assert.equal(calls.filter(call => call.operation === 'set_text' && call.args.layerId === 11).length, 2);
  assert.equal(calls.filter(call => call.operation === 'get_preview').length, 2);
  assert.ok(!calls.some(call => ['save_psd', 'export_image'].includes(call.operation)));
  const logs = await events(record.executionId);
  assert.deepEqual(logs.filter(entry => entry.event === 'structural_checks').map(entry => entry.round), [0,1]);
});

test('one verified text correction can succeed, and maxCorrections is capped at two', async t => {
  const { calls, run } = await fixture(t, { ignoreTextWrites: 1 });
  const record = await run({}, { maxCorrections: 1, formats: ['png'] });
  assert.equal(record.status, 'review_required');
  assert.equal(calls.filter(call => call.operation === 'get_preview').length, 2);
  assert.equal(calls.filter(call => call.operation === 'replace_smart_object').length, 1);
  assert.equal(calls.filter(call => call.operation === 'transform_layer').length, 1);
  assert.equal(record.outputs.length, 2);
  await assert.rejects(run({}, { maxCorrections: 3 }));
});

test('pause waits for the current operation and stops before the next mutation boundary', async t => {
  const { workspace, calls, run, events } = await fixture(t, { pauseOperation: 'set_text' });
  const record = await run();
  assert.equal(record.status, 'paused');
  assert.equal((record.error as any).code, 'TASK_PAUSED');
  assert.deepEqual(calls.map(call => call.operation), ['preflight_assets', 'open_working_copy', 'get_document_info', 'list_layers', 'set_text']);
  assert.equal((await events(record.executionId)).at(-1).event, 'execution_stopped');
  await assert.rejects(pauseExecution(workspace, record.executionId), (error: any) => error.code === 'TASK_NOT_RUNNING');
});

test('uncertain Photoshop execution is recorded distinctly and the runner never retries that mutation', async t => {
  const { calls, run } = await fixture(t, { failOperation: 'replace_smart_object', failureCode: 'EXECUTION_UNCERTAIN' });
  const record = await run();
  assert.equal(record.status, 'execution_uncertain');
  assert.equal(calls.filter(call => call.operation === 'replace_smart_object').length, 1);
  assert.ok(!calls.some(call => ['save_psd', 'export_image'].includes(call.operation)));
});

test('approval and rejection are explicit recorded decisions after structural pass', async t => {
  const { workspace, run, events } = await fixture(t);
  const record = await run();
  assert.equal(record.status, 'review_required');
  assert.equal(record.review, undefined);
  const rejected = await reviewExecution(workspace, record.executionId, 'rejected', ['TEST ONLY: requested manual refinement'], 'test reviewer');
  assert.equal(rejected.status, 'rejected');
  const approved = await reviewExecution(workspace, record.executionId, 'approved', ['TEST ONLY: exercising local review persistence'], 'test reviewer');
  assert.equal(approved.status, 'approved');
  assert.equal((approved.review as any).reviewer, 'test reviewer');
  assert.equal((await events(record.executionId)).filter(entry => entry.event === 'review_recorded').length, 2);
});

test('preflight failure prevents Photoshop open and all mutations, with a recorded specific reason', async t => {
  const { calls, run, events } = await fixture(t, { failOperation: 'preflight_assets', failureCode: 'INPUT_OUTSIDE_ROOT' });
  const record = await run();
  assert.equal(record.status, 'needs_input');
  assert.equal((record.error as any).code, 'INPUT_OUTSIDE_ROOT');
  assert.deepEqual(calls.map(call => call.operation), ['preflight_assets']);
  assert.equal(record.documentId, undefined);
  assert.deepEqual(record.outputs, []);
  const logs = await events(record.executionId);
  assert.equal(logs.at(-1).event, 'execution_stopped');
});

test('snapshot rejects metadata or layer trees from a document other than the requested ID', async () => {
  for (const mismatch of ['info', 'tree']) {
    const client: PhotoshopClient = { async execute(operation) {
      if (operation === 'get_document_info') return { id: mismatch === 'info' ? 99 : 7, width: 800, height: 800 };
      return { documentId: mismatch === 'tree' ? 99 : 7, layers: [] };
    } };
    await assert.rejects(snapshot(client, 7), (error: any) => error.code === 'INVALID_SNAPSHOT');
  }
});
