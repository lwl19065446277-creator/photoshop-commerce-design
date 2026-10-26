import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StudioError } from './errors.js';
import { mutatingOperations } from './contracts.js';
export class BridgeClient {
  constructor(readonly workspace: string) {}
  async request(path: string, body?: unknown): Promise<any> {
    let connection;
    try { connection = JSON.parse(await readFile(resolve(this.workspace, '.studio/connection.json'), 'utf8')); }
    catch { throw new StudioError('BRIDGE_NOT_STARTED', 'Run npm start in the project directory first'); }
    if (connection.baseUrl !== 'http://127.0.0.1:57123' || connection.protocolVersion !== 1) throw new StudioError('INVALID_CONNECTION_FILE', 'Only the local bridge on port 57123 is supported');
    let response, data: any;
    try {
      response = await fetch(connection.baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(610000) });
      data = await response.json();
    }
    catch (e) {
      const operation = (body as any)?.operation;
      const uncertain = operation && (mutatingOperations.has(operation) || operation === 'open_working_copy');
      throw new StudioError(uncertain ? 'EXECUTION_UNCERTAIN' : 'BRIDGE_UNREACHABLE', uncertain ? 'Transport failed during a modifying request. Its outcome is unknown; inspect Photoshop and bridge logs before restarting. Do not replay automatically.' : 'Cannot reach local bridge; run npm start.', { outcome: uncertain ? 'unknown' : 'not_connected', cause: String(e) });
    }
    if (!response.ok) throw new StudioError(data.error?.code || 'HTTP_ERROR', data.error?.message || `HTTP ${response.status}`, data.error?.details);
    return data;
  }
  async execute(operation: string, args: Record<string, unknown>) { return (await this.request('/api/commands', { operation, args })).result; }
  status() { return this.request('/api/status'); }
}
