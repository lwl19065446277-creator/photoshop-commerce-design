import { parseArgs } from 'node:util';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, connectionFile } from './config.js';
import { FilePolicy, hashFile } from './paths.js';
import { Journal } from './journal.js';
import { CommandQueue } from './bridge/queue.js';
import { PhotoshopService } from './bridge/service.js';
import { bridgeServer } from './bridge/server.js';
import { BridgeClient } from './client.js';
import { errorData, StudioError } from './errors.js';
import { type ParseWorkbookOptions } from './tasks/parser.js';
import { importWorkbook } from './import-workbook.js';
import { designTaskSchema } from './tasks/model.js';
import { runTask, getExecution, listExecutions, pauseExecution, reviewExecution, snapshot } from './runner.js';
import { planTask } from './tasks/planner.js';

const parsed = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string' }, excel: { type: 'string' }, sheet: { type: 'string' }, row: { type: 'string' },
  options: { type: 'string' }, args: { type: 'string' }, task: { type: 'string' }, document: { type: 'string' },
  execution: { type: 'string' }, decision: { type: 'string' }, findings: { type: 'string' }, reviewer: { type: 'string' },
  path: { type: 'string' }, 'max-corrections': { type: 'string' }, help: { type: 'boolean' }
} });
const workspace = resolve(parsed.values.workspace || fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../' : '../../', import.meta.url)));
const client = new BridgeClient(workspace);
const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const required = (name: keyof typeof parsed.values): string => {
  const value = parsed.values[name];
  if (typeof value !== 'string' || !value) throw new StudioError('MISSING_ARGUMENT', `Missing --${name}`);
  return value;
};
const readJson = async (path: string) => JSON.parse(await readFile(resolve(workspace, path), 'utf8'));
async function fromExcel() {
  const file = await new FilePolicy(workspace, await loadConfig(workspace)).input(required('excel'), ['.xlsx']);
  const options: ParseWorkbookOptions = parsed.values.options ? await readJson(parsed.values.options) : {};
  if (parsed.values.sheet) options.sheetName = parsed.values.sheet;
  return importWorkbook(workspace, file, options);
}
const help = `Design Agent Studio 0.1.0 (local, source tables read-only)
npm run studio -- bridge                     Start real UXP bridge on 127.0.0.1:57123
npm run studio -- doctor                     Environment/connection diagnostics
npm run studio -- status                     Real bridge status
npm run studio -- inspect-source --path FILE  Read PSD/PSB header/hash, no Photoshop claim
npm run studio -- parse --excel FILE.xlsx [--options examples/mapping.example.json]
npm run studio -- run --excel FILE.xlsx --sheet SHEET --row 2 [--max-corrections 1]
npm run studio -- run --task FILE.json        Run one validated task through real UXP
npm run studio -- call list_layers --args args.json
npm run studio -- plan --task FILE.json --document 123
npm run studio -- tasks                      Read local execution records
npm run studio -- task --execution UUID       Read one local execution
npm run studio -- pause --execution UUID      Pause between operations
npm run studio -- review --execution UUID --decision approved --reviewer NAME --findings JSON
npm run studio -- mcp-config                 Print config snippet; does not edit global settings
All relative paths resolve under project workspace. No runtime mock/simulator switch.
`;

async function main() {
  const command = parsed.positionals[0] || 'help';
  if (parsed.values.help || command === 'help') { process.stdout.write(help); return; }
  if (command === 'bridge') {
    const config = await loadConfig(workspace);
    const queue = new CommandQueue(config.commandTimeoutMs);
    const service = new PhotoshopService(queue, new FilePolicy(workspace, config), new Journal(resolve(workspace, '.studio/events.jsonl')));
    let token = 'NOT_INITIALIZED_' + crypto.randomUUID();
    const server = bridgeServer(service, () => token);
    // Bind before rotating credentials so a second startup cannot break a healthy bridge.
    server.listen(config.port, '127.0.0.1');
    await once(server, 'listening');
    try { token = (await connectionFile(workspace, config.port)).token; }
    catch (error) { server.close(); throw error; }
    print({ service: 'Design Agent Studio', baseUrl: `http://127.0.0.1:${config.port}`, mode: 'real-uxp', connected: false, connectionFile: resolve(workspace, '.studio/connection.json'), message: 'In Photoshop plugin, select the connection file. Tokens are never printed.' });
    const shutdown = () => { queue.close(); server.closeAllConnections(); server.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    return;
  }
  if (command === 'mcp-config') {
    const toml = (v: string) => JSON.stringify(v.replace(/\\/g, '/'));
    process.stdout.write(`[mcp_servers.design_agent_studio]\ncommand = ${toml(process.execPath)}\nargs = [${toml(resolve(workspace,'dist/src/mcp.js'))}, "--workspace", ${toml(workspace)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n`);
    return;
  }
  if (command === 'doctor') {
    let status;
    try { status = await client.status(); } catch (error) { status = { error: errorData(error) }; }
    const config = await loadConfig(workspace);
    print({ node: process.version, platform: process.platform, architecture: process.arch, workspace, bridge: status, config, pluginManifest: resolve(workspace, 'uxp-plugin/manifest.json'), sourcePolicy: 'Read-only Excel and Feishu. Working PSD/PSB copies only.', realPhotoshopVerified: false });
    return;
  }
  if (command === 'status') { print(await client.status()); return; }
  if (command === 'inspect-source') {
    const path = await new FilePolicy(workspace, await loadConfig(workspace)).input(required('path'), ['.psd','.psb']);
    const file = await open(path, 'r');
    const header = Buffer.alloc(26);
    try { await file.read(header, 0, 26, 0); } finally { await file.close(); }
    if (header.subarray(0,4).toString('ascii') !== '8BPS') throw new StudioError('INVALID_PSD', 'No PSD/PSB signature');
    print({ path, format: header.readUInt16BE(4) === 2 ? 'PSB' : 'PSD', channels: header.readUInt16BE(12), width: header.readUInt32BE(18), height: header.readUInt32BE(14), depth: header.readUInt16BE(22), colorMode: header.readUInt16BE(24), sha256: await hashFile(path), evidence: 'Local file header only; editable layers and Photoshop compatibility remain unverified.' });
    return;
  }
  if (command === 'parse') { print(await fromExcel()); return; }
  if (command === 'call') {
    const operation = parsed.positionals[1];
    if (!operation) throw new StudioError('MISSING_ARGUMENT', 'Supply operation after call');
    print(await client.execute(operation, parsed.values.args ? await readJson(parsed.values.args) : {})); return;
  }
  if (command === 'plan') {
    const task = designTaskSchema.parse(await readJson(required('task')));
    print(planTask(task, await snapshot(client, z.number().int().positive().parse(Number(required('document')))))); return;
  }
  if (command === 'run') {
    let task;
    if (parsed.values.task) task = designTaskSchema.parse(await readJson(parsed.values.task));
    else {
      const row = z.number().int().positive().parse(Number(required('row')));
      const candidates = (await fromExcel()).filter(t => t.source.row === row);
      if (candidates.length !== 1) throw new StudioError('AMBIGUOUS_TASK', 'Use --sheet and --row to select one exact requirement row');
      task = candidates[0];
    }
    const record = await runTask(workspace, client, task, { maxCorrections: Number(parsed.values['max-corrections'] ?? 1), onStart: id => process.stderr.write(`Execution: ${id}\n`) });
    print(record);
    if (!['review_required','approved'].includes(record.status)) process.exitCode = 1;
    return;
  }
  if (command === 'tasks') { print(await listExecutions(workspace)); return; }
  if (command === 'task') { print(await getExecution(workspace, required('execution'))); return; }
  if (command === 'pause') { print(await pauseExecution(workspace, required('execution'))); return; }
  if (command === 'review') {
    const decision = z.enum(['approved','rejected']).parse(required('decision'));
    const findings = z.array(z.string().min(1)).min(1).parse(await readJson(required('findings')));
    print(await reviewExecution(workspace, required('execution'), decision, findings, required('reviewer'))); return;
  }
  throw new StudioError('UNKNOWN_COMMAND', `Unknown command ${command}. Run help.`);
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: errorData(error) }, null, 2) + '\n'); process.exitCode = 1; });
