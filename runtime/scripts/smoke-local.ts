import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BridgeClient } from '../src/client.js';

// Real Node HTTP and MCP stdio processes; NO Photoshop emulator is started.
const workspace = resolve('.');
const bridge = spawn(process.execPath, ['dist/src/cli.js','bridge'], { cwd: workspace, stdio: ['ignore','pipe','pipe'], windowsHide: true });
let diagnostics = '';
bridge.stderr.on('data', chunk => { diagnostics += String(chunk); });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/mcp.js'),'--workspace',workspace], cwd: workspace, stderr: 'pipe' });
const mcp = new Client({ name: 'studio-local-smoke', version: '0.1.0' });
try {
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Bridge startup timed out: ' + diagnostics)), 10000);
    bridge.once('error', error => { clearTimeout(timer); reject(error); });
    bridge.once('exit', code => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${diagnostics}`)); });
    bridge.stdout.once('data', () => { clearTimeout(timer); resolveReady(); });
  });
  const local = new BridgeClient(workspace);
  const status = await local.status();
  if (status.connected !== false || status.mode !== 'real-uxp') throw new Error('Unexpected Photoshop status in no-UXP smoke check');
  let disconnectedCode: string | undefined;
  try { await local.execute('ping', {}); } catch (error: any) { disconnectedCode = error.code; }
  if (disconnectedCode !== 'PHOTOSHOP_DISCONNECTED') throw new Error('Photoshop disconnection was not reported honestly');
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  const statusViaMcp = await mcp.callTool({ name: 'studio_status', arguments: {} });
  if (statusViaMcp.isError) throw new Error('MCP status round-trip failed');
  const ping = await mcp.callTool({ name: 'photoshop_ping', arguments: {} });
  if (!ping.isError || !JSON.stringify(ping.content).includes('PHOTOSHOP_DISCONNECTED')) throw new Error('MCP pretended Photoshop was connected');
  process.stdout.write(JSON.stringify({ httpBridge: 'passed', mcpStdioHandshake: 'passed', toolCount: tools.tools.length, photoshopConnected: false, photoshopExecuted: false, disconnectedError: disconnectedCode, originalAssetsModified: false, evidence: 'Actual local Node bridge and stdio MCP. No Photoshop plugin, document operation, or mock peer.' }, null, 2) + '\n');
} finally {
  await mcp.close().catch(() => {});
  await transport.close().catch(() => {});
  if (bridge.exitCode === null) { bridge.kill(); await once(bridge, 'exit'); }
}
