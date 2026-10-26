import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Journal } from '../journal.js';
import { StudioError } from '../errors.js';
import { validateRenderPlan } from '../design/plan.js';
import { validateCatalogPlan } from '../design/catalog-plan.js';
import { validateNativeSlicePlan } from '../design/slice-plan.js';
import { validateVariantPlan } from '../design/variant-plan.js';

const schemas = {
  ping: z.object({}).strict(),
  purge_idle_history: z.object({}).strict(),
  layer_descriptor: z.object({documentId:z.number().int().positive(),sourceWorkingPath:z.string().min(1),layerId:z.number().int().positive()}).strict(),
  font_catalog: z.object({}).strict(),
  close_created_probe: z.object({documentId:z.number().int().positive(),expectedText:z.literal('00_接口验证')}).strict(),
  render_design: z.object({path:z.string().min(1)}).strict(),
  render_native_catalog: z.object({path:z.string().min(1)}).strict(),
  export_native_slices: z.object({path:z.string().min(1)}).strict(),
  render_native_variant: z.object({path:z.string().min(1)}).strict(),
  discard_failed_render: z.object({documentId:z.number().int().positive(),path:z.string().min(1)}).strict(),
  open_working_copy: z.object({ path: z.string().min(1) }).strict(),
  inspect_document: z.object({ documentId: z.number().int().positive(), sourceWorkingPath: z.string().min(1) }).strict(),
  audit_document: z.object({ documentId: z.number().int().positive(), sourceWorkingPath: z.string().min(1) }).strict(),
  set_text: z.object({ documentId: z.number().int().positive(), sourceWorkingPath: z.string().min(1), layerId: z.number().int().positive(), expectedText: z.string(), text: z.string() }).strict(),
  save_psd: z.object({ documentId: z.number().int().positive(), sourceWorkingPath: z.string().min(1), path: z.string().min(1) }).strict(),
  export_preview: z.object({ documentId: z.number().int().positive(), sourceWorkingPath: z.string().min(1), path: z.string().min(1), format: z.enum(['png','jpg']) }).strict(),
  close_document: z.object({ documentId: z.number().int().positive(), sourceWorkingPath: z.string().min(1), save:z.literal(false).default(false) }).strict()
};
export type ComOperation = keyof typeof schemas;
/** A separate, explicitly labelled real Adobe Windows COM compatibility adapter. */
export class ComPhotoshopClient {
  constructor(readonly workspace: string, readonly commandDirectory: string, readonly journal: Journal) {}
  async execute(operation: ComOperation, args: Record<string, unknown>, timeoutMs = 120000): Promise<any> {
    const parsed = schemas[operation].parse(args);
    if(operation==='render_design'||operation==='discard_failed_render')await validateRenderPlan(String(args.path),this.workspace);
    if(operation==='render_native_catalog')await validateCatalogPlan(String(args.path),this.workspace);
    if(operation==='export_native_slices')await validateNativeSlicePlan(String(args.path),this.workspace);
    if(operation==='render_native_variant')await validateVariantPlan(String(args.path),this.workspace);
    await mkdir(this.commandDirectory, { recursive: true });
    const commandId = randomUUID();
    const requestPath = resolve(this.commandDirectory, `${commandId}.request.json`);
    const resultPath = resolve(this.commandDirectory, `${commandId}.result.json`);
    await writeFile(requestPath, JSON.stringify({ operation, args: parsed }), { flag: 'wx' });
    const dispatcherHashes:Record<string,string>={};for(const name of ['src/legacy/photoshop-com.jsx','src/legacy/design-com.jsxinc','src/legacy/catalog-com.jsxinc','src/legacy/slices-com.jsxinc','src/legacy/variant-com.jsxinc','scripts/Invoke-PhotoshopCom.ps1'])dispatcherHashes[name]=createHash('sha256').update(await readFile(resolve(this.workspace,name))).digest('hex');
    await this.journal.record({ event: 'command_started', backend: 'real-com', commandId, operation, args: parsed, requestPath, resultPath,dispatcherHashes });
    let processError: unknown;
    try {
      await new Promise<void>((resolveDone, reject) => {
        const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile','-NonInteractive','-Sta','-File',resolve(this.workspace,'scripts/Invoke-PhotoshopCom.ps1'),'-RequestPath',requestPath,'-ResultPath',resultPath], { cwd: this.workspace, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        let errors = '';
        const timer = setTimeout(() => { child.kill(); reject(new StudioError('EXECUTION_UNCERTAIN','Photoshop COM request exceeded its deadline. Inspect Photoshop and saved command files; no automatic retry.', { commandId, outcome: 'unknown' })); }, timeoutMs);
        child.stderr.on('data', data => { errors = (errors + String(data)).slice(-10000); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveDone(); else reject(new StudioError('COM_PROCESS_FAILED', `COM helper exited ${code}`, { stderr: errors, commandId })); });
      });
    } catch (error) { processError = error; }
    let response: any;
    try { response = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/,'')); }
    catch {
      const error = processError || new StudioError('EXECUTION_UNCERTAIN','No readable Photoshop COM receipt. Inspect the working copy; do not replay automatically.', { commandId, outcome:'unknown' });
      await this.journal.record({ event:'command_unknown', backend:'real-com', commandId, operation, error: String(error) });
      throw error;
    }
    if (!response.ok) {
      await this.journal.record({ event:'command_failed', backend:'real-com', commandId, operation, error: response.error });
      throw new StudioError(response.error?.code || 'PHOTOSHOP_COM_ERROR', response.error?.message || 'Photoshop returned a failed command', response.error?.details);
    }
    if (processError) {
      await this.journal.record({ event:'command_receipt_recovered', backend:'real-com', commandId, operation, result:response.result, processError:String(processError) });
    } else await this.journal.record({ event:'command_succeeded', backend:'real-com', commandId, operation, result:response.result });
    return response.result;
  }
}
