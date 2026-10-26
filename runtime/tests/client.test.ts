import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient } from '../src/client.js';

/** Fetch stubs exist only in this isolated test process; no bridge or Photoshop is simulated at runtime. */
async function clientFixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'das-client-transport-test-'));
  await mkdir(join(root, '.studio'));
  await writeFile(join(root, '.studio', 'connection.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:57123', protocolVersion: 1, token: 'TEST-ONLY-NOT-A-REAL-CREDENTIAL' }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new BridgeClient(root);
}

test('a modifying request whose response body is lost reports unknown execution and is never retried', async t => {
  const client = await clientFixture(t);
  const operations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    operations.push(JSON.parse(String(init.body)).operation);
    const response = new Response('{}', { status: 200 });
    t.mock.method(response, 'json', async () => { throw new Error('TEST: socket closed after response headers'); });
    return response;
  });
  for (const operation of ['set_text', 'replace_smart_object', 'save_psd', 'open_working_copy']) {
    await assert.rejects(client.execute(operation, { documentId: 7, layerId: 11, text: 'literal test text' }), (error: any) => {
      assert.equal(error.code, 'EXECUTION_UNCERTAIN');
      assert.equal(error.details.outcome, 'unknown');
      assert.match(error.message, /Do not replay automatically/);
      return true;
    });
  }
  assert.deepEqual(operations, ['set_text', 'replace_smart_object', 'save_psd', 'open_working_copy']);
});

test('read-only response loss remains BRIDGE_UNREACHABLE and does not retry', async t => {
  const client = await clientFixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const response = new Response('{}', { status: 200 });
    t.mock.method(response, 'json', async () => { throw new Error('TEST: read-only body unavailable'); });
    return response;
  });
  for (const operation of ['ping', 'list_layers', 'preflight_assets']) {
    await assert.rejects(client.execute(operation, {}), (error: any) => error.code === 'BRIDGE_UNREACHABLE' && error.details.outcome === 'not_connected');
  }
  await assert.rejects(client.status(), (error: any) => error.code === 'BRIDGE_UNREACHABLE');
  assert.equal(calls, 4);
});

test('fetch failure during a modifying request remains uncertain without assuming nothing was executed', async t => {
  const client = await clientFixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('TEST: connection reset'); });
  await assert.rejects(client.execute('set_visibility', { documentId: 7, layerId: 11, visible: false }), (error: any) => error.code === 'EXECUTION_UNCERTAIN' && error.details.outcome === 'unknown');
  assert.equal(calls, 1);
});

test('a structured bridge rejection preserves its concrete error code and details for a modifying request', async t => {
  const client = await clientFixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'WRONG_LAYER_KIND', message: 'Expected a text layer', details: { layerId: 11 } } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  });
  await assert.rejects(client.execute('set_text', { documentId: 7, layerId: 11, text: 'literal' }), (error: any) => {
    assert.equal(error.code, 'WRONG_LAYER_KIND');
    assert.equal(error.message, 'Expected a text layer');
    assert.deepEqual(error.details, { layerId: 11 });
    return true;
  });
  assert.equal(calls, 1);
});
