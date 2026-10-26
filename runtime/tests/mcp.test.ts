import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStudioMcp } from '../src/mcp-server.js';
import { operationSchemas } from '../src/contracts.js';

/** Real SDK transports and server, isolated workspace, no Photoshop peer or runtime simulator. */
async function session(t: any) {
  const workspace = await mkdtemp(join(tmpdir(), 'das-mcp-sdk-test-'));
  const server = createStudioMcp(workspace);
  const client = new Client({ name: 'studio-integration-test-client', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); await rm(workspace, { recursive: true, force: true }); });
  return { workspace, client };
}
function contentText(result: any) { return result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n'); }

test('real MCP SDK handshake advertises allowlisted typed tools without arbitrary Photoshop execution', async t => {
  const { client } = await session(t);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const operation of Object.keys(operationSchemas)) assert.ok(names.includes(`photoshop_${operation}`), operation);
  assert.ok(names.includes('studio_run_task'));
  assert.ok(names.includes('studio_review_task'));
  assert.ok(names.every(name => /^(photoshop_|studio_)/.test(name)));
  assert.ok(!names.some(name => /eval|batch.?play|shell|script|execute_js/i.test(name)));
  const textTool = tools.find(tool => tool.name === 'photoshop_set_text')!;
  assert.equal(textTool.inputSchema.type, 'object');
  assert.deepEqual([...textTool.inputSchema.required!].sort(), ['documentId', 'layerId', 'text']);
  assert.equal(textTool.inputSchema.additionalProperties, false);
  assert.equal((textTool.annotations as any).idempotentHint, false);
  const inspectTool = tools.find(tool => tool.name === 'photoshop_list_layers')!;
  assert.equal((inspectTool.annotations as any).readOnlyHint, true);
});

test('MCP tools return explicit disconnected errors instead of synthetic Photoshop results', async t => {
  const { client } = await session(t);
  for (const name of ['photoshop_ping', 'studio_status']) {
    const response = await client.callTool({ name, arguments: {} });
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(contentText(response)).error.code, 'BRIDGE_NOT_STARTED');
    assert.ok(!('structuredContent' in response));
  }
});

test('MCP schema rejects invalid layer IDs, unknown fields, empty transforms and unlisted raw commands', async t => {
  const { client } = await session(t);
  for (const [name, args] of [
    ['photoshop_set_text', { documentId: 1, layerId: 0, text: 'bad id' }],
    ['photoshop_set_text', { documentId: 1, layerId: 2, text: 'data', script: 'forbidden' }],
    ['photoshop_transform_layer', { documentId: 1, layerId: 2 }],
    ['photoshop_transform_layer', { documentId: 1, layerId: 2, scalePercent: -1 }],
    ['photoshop_batch_play', { descriptors: [] }],
    ['studio_review_task', { executionId: '../escape', decision: 'approved', findings: ['test'], reviewer: 'test' }]
  ] as const) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, name);
    assert.match(contentText(response), /validation|not found|Invalid arguments/i);
    assert.ok(!contentText(response).includes('BRIDGE_NOT_STARTED'), 'Input should be rejected before hitting the bridge client');
  }
});

test('MCP bridge connection file is restricted to localhost protocol v1', async t => {
  const { client, workspace } = await session(t);
  await mkdir(join(workspace, '.studio'));
  await writeFile(join(workspace, '.studio', 'connection.json'), JSON.stringify({ baseUrl: 'https://example.invalid', protocolVersion: 1, token: 'test-only' }));
  const response = await client.callTool({ name: 'photoshop_ping', arguments: {} });
  assert.equal(response.isError, true);
  assert.equal(JSON.parse(contentText(response)).error.code, 'INVALID_CONNECTION_FILE');
});

test('MCP local task listing works while Photoshop is disconnected and does not claim a completed design', async t => {
  const { client } = await session(t);
  const response = await client.callTool({ name: 'studio_list_tasks', arguments: {} });
  assert.ok(!response.isError);
  assert.deepEqual(JSON.parse(contentText(response)), []);
});
