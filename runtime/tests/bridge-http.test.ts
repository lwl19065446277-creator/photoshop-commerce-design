import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { bridgeServer } from '../src/bridge/server.js';
import { PhotoshopService } from '../src/bridge/service.js';
import { CommandQueue } from '../src/bridge/queue.js';
import { FilePolicy } from '../src/paths.js';
import { Journal } from '../src/journal.js';

const testToken = 'test-only-token-not-a-real-credential';
async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'das-http-tests-'));
  const queue = new CommandQueue(1000);
  const service = new PhotoshopService(queue, new FilePolicy(root, { port: 57123, allowedInputRoots: ['.'], outputRoot: 'outputs', commandTimeoutMs: 1000 }), new Journal(join(root, 'journal.jsonl')));
  const server = bridgeServer(service, () => testToken);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    queue.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  async function request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${testToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { base, queue, service, request };
}

test('HTTP health is minimal; all operations require bearer authentication and browser origins are rejected', async t => {
  const { base, request } = await setup(t);
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  const metadata = await health.json();
  assert.deepEqual(Object.keys(metadata).sort(), ['protocolVersion', 'service']);
  for (const authorization of ['', 'Bearer wrong', `Bearer ${testToken}trailing`]) {
    const response = await request('/api/status', undefined, { Authorization: authorization });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  }
  const status = await request('/api/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).connected, false);
  const browser = await request('/api/status', undefined, { Origin: 'https://example.invalid' });
  assert.equal(browser.status, 400);
  assert.equal((await browser.json()).error.code, 'ORIGIN_DENIED');
});

test('HTTP boundaries validate protocol, payload schema, MIME type and disconnected execution', async t => {
  const { request, base } = await setup(t);
  const badVersion = await request('/plugin/hello', { pluginVersion: 'test', photoshopVersion: 'TEST', protocolVersion: 2 });
  assert.equal(badVersion.status, 400);
  assert.equal((await badVersion.json()).error.code, 'INVALID_ARGUMENTS');
  const badFields = await request('/api/commands', { operation: 'ping', args: {}, script: 'forbidden' });
  assert.equal((await badFields.json()).error.code, 'INVALID_ARGUMENTS');
  const badMime = await fetch(base + '/api/commands', { method: 'POST', headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal((await badMime.json()).error.code, 'CONTENT_TYPE');
  const invalidJson = await fetch(base + '/api/commands', { method: 'POST', headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON');
  const disconnected = await request('/api/commands', { operation: 'ping', args: {} });
  assert.equal((await disconnected.json()).error.code, 'PHOTOSHOP_DISCONNECTED');
});

test('HTTP command/result round trip uses a test peer and rejects stale/mismatched receipts', async t => {
  const { request } = await setup(t);
  const hello = await request('/plugin/hello', { pluginVersion: 'test-peer', photoshopVersion: 'TEST-NOT-PHOTOSHOP', protocolVersion: 1 });
  const { sessionId } = await hello.json();
  assert.equal(typeof sessionId, 'string');
  const wrongSession = await request('/plugin/next?sessionId=wrong');
  assert.equal((await wrongSession.json()).error.code, 'INVALID_SESSION');
  const execution = request('/api/commands', { operation: 'ping', args: {} });
  const next = await request(`/plugin/next?sessionId=${encodeURIComponent(sessionId)}`);
  const { command } = await next.json();
  assert.equal(command.operation, 'ping');
  const badReceipt = await request('/plugin/result', { sessionId, id: 'wrong', ok: true, result: {} });
  assert.equal((await badReceipt.json()).error.code, 'UNEXPECTED_RESULT');
  const receipt = { sessionId, id: command.id, ok: true, result: { testPeer: true } };
  assert.equal((await request('/plugin/result', receipt)).status, 200);
  const returned = await execution;
  assert.equal(returned.status, 200);
  assert.deepEqual((await returned.json()).result, { testPeer: true });
  assert.equal((await request('/plugin/result', receipt)).status, 200);
});

test('HTTP explicit disconnect refuses pending execution, clears document ownership and permits reconnect', async t => {
  const { request, service } = await setup(t);
  const hello = await request('/plugin/hello', { pluginVersion: 'test-peer', photoshopVersion: 'TEST-NOT-PHOTOSHOP', protocolVersion: 1 });
  const { sessionId } = await hello.json();
  const execution = request('/api/commands', { operation: 'ping', args: {} });
  const next = await request(`/plugin/next?sessionId=${encodeURIComponent(sessionId)}`);
  const { command } = await next.json();
  const busy = await request('/plugin/disconnect', { sessionId });
  assert.equal((await busy.json()).error.code, 'BUSY');
  await request('/plugin/result', { sessionId, id: command.id, ok: true, result: {} });
  await execution;
  // This sentinel represents session ownership only; no Photoshop file exists.
  service.runs.set(7, { documentId: 7 } as any);
  const disconnected = await request('/plugin/disconnect', { sessionId });
  assert.equal(disconnected.status, 200);
  assert.equal(service.status().connected, false);
  assert.deepEqual(service.status().managedDocuments, []);
  const reconnect = await request('/plugin/hello', { pluginVersion: 'test-peer', photoshopVersion: 'TEST-NOT-PHOTOSHOP', protocolVersion: 1 });
  assert.equal(reconnect.status, 200);
  assert.notEqual((await reconnect.json()).sessionId, sessionId);
});
