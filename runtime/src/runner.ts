import { access, mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { designTaskSchema, TaskPlanningError, type DesignTask, type DocumentSnapshot } from './tasks/model.js';
import { planTask } from './tasks/planner.js';
import { checkDesign } from './tasks/checker.js';
import { Journal } from './journal.js';
import { StudioError, errorData } from './errors.js';

export interface PhotoshopClient { execute(operation: string, args: Record<string, unknown>): Promise<any> }
export interface ExecutionRecord {
  executionId: string;
  task: DesignTask;
  status: 'running' | 'needs_input' | 'paused' | 'failed' | 'execution_uncertain' | 'review_required' | 'approved' | 'rejected';
  backend: 'real-uxp';
  startedAt: string;
  updatedAt: string;
  runId?: string;
  documentId?: number;
  preflight?: unknown;
  plan?: unknown;
  preview?: string;
  outputs: string[];
  checks?: unknown;
  error?: unknown;
  review?: unknown;
}
const executionIdSchema = z.string().uuid();
function recordDir(workspace: string, executionId: string) { return resolve(workspace, '.studio/tasks', executionIdSchema.parse(executionId)); }
async function putRecord(workspace: string, record: ExecutionRecord) {
  const dir = recordDir(workspace, record.executionId);
  await mkdir(dir, { recursive: true });
  record.updatedAt = new Date().toISOString();
  const temp = resolve(dir, `record-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(record, null, 2), { flag: 'wx' });
  await rename(temp, resolve(dir, 'record.json'));
}
export async function getExecution(workspace: string, executionId: string): Promise<ExecutionRecord> {
  return JSON.parse(await readFile(resolve(recordDir(workspace, executionId), 'record.json'), 'utf8'));
}
export async function listExecutions(workspace: string) {
  let names;
  try { names = await readdir(resolve(workspace, '.studio/tasks')); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  const records = await Promise.all(names.filter(name => executionIdSchema.safeParse(name).success).map(name => getExecution(workspace, name)));
  return records.sort((a,b) => b.startedAt.localeCompare(a.startedAt));
}
export async function pauseExecution(workspace: string, executionId: string) {
  const record = await getExecution(workspace, executionId);
  if (record.status !== 'running') throw new StudioError('TASK_NOT_RUNNING', 'Only a running task can be paused');
  await writeFile(resolve(recordDir(workspace, executionId), 'pause-requested'), 'Pause at next operation boundary\n');
  return { executionId, pauseRequested: true, message: 'Current Photoshop operation finishes before pausing. Rerunning creates a fresh copy; no blind resume.' };
}
export async function reviewExecution(workspace: string, executionId: string, decision: 'approved'|'rejected', findings: string[], reviewer: string) {
  const record = await getExecution(workspace, executionId);
  if (!['review_required','rejected'].includes(record.status)) throw new StudioError('TASK_NOT_REVIEWABLE', 'Task must have exported files awaiting review');
  if (decision === 'approved' && !(record.checks as any)?.structuralPass) throw new StudioError('CHECKS_FAILED', 'Failed structural checks cannot be approved');
  record.status = decision; record.review = { reviewer, findings, decision, at: new Date().toISOString() };
  await putRecord(workspace, record);
  await new Journal(resolve(recordDir(workspace, executionId), 'events.jsonl')).record({ event: 'review_recorded', review: record.review });
  return record;
}
export async function snapshot(client: PhotoshopClient, documentId: number): Promise<DocumentSnapshot> {
  const info = await client.execute('get_document_info', { documentId });
  const tree = await client.execute('list_layers', { documentId });
  if (!Number.isInteger(info?.id) || info.id !== documentId || (tree?.documentId !== undefined && tree.documentId !== documentId) || !Number.isFinite(info.width) || !Number.isFinite(info.height) || !Array.isArray(tree?.layers)) throw new StudioError('INVALID_SNAPSHOT', 'Photoshop returned an incomplete or mismatched document snapshot');
  return { ...info, layers: tree.layers };
}

/** No simulator is wired here. Tests inject a clearly labelled fixture client. */
export async function runTask(workspace: string, client: PhotoshopClient, rawTask: DesignTask, options: { maxCorrections?: number; formats?: ('png'|'jpg')[]; onStart?: (id: string) => void } = {}) {
  const task = designTaskSchema.parse(rawTask);
  const maxCorrections = z.number().int().min(0).max(2).parse(options.maxCorrections ?? 1);
  const formats = z.array(z.enum(['png','jpg'])).min(1).max(2).parse(options.formats ?? ['png','jpg']);
  const executionId = randomUUID();
  const now = new Date().toISOString();
  const record: ExecutionRecord = { executionId, task, status: 'running', backend: 'real-uxp', startedAt: now, updatedAt: now, outputs: [] };
  const journal = new Journal(resolve(recordDir(workspace, executionId), 'events.jsonl'));
  await putRecord(workspace, record);
  const boundary = async () => {
    try { await access(resolve(recordDir(workspace, executionId), 'pause-requested')); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    throw new StudioError('TASK_PAUSED', 'Task paused between Photoshop operations. Working copy remains open for inspection.');
  };
  const call = async (operation: string, args: Record<string, unknown>) => {
    await boundary();
    await journal.record({ event: 'step_started', operation, args });
    const result = await client.execute(operation, args);
    await journal.record({ event: 'step_finished', operation, result });
    return result;
  };
  const trackingClient = { execute: call };
  try {
    options.onStart?.(executionId);
    if (task.status !== 'ready' || task.issues.some(issue => issue.severity === 'error')) throw new TaskPlanningError('TASK_NEEDS_INPUT', 'Resolve missing information before running this task');
    if (!task.templatePath || !task.productImagePath) throw new TaskPlanningError('INCOMPLETE_TASK', 'Template and product image paths are required before Photoshop can be opened');
    const preflight = await call('preflight_assets', { templatePath: task.templatePath, productImagePath: task.productImagePath, ...(task.referencePath ? { referencePath: task.referencePath } : {}) });
    if (typeof preflight?.templatePath !== 'string' || typeof preflight?.productImagePath !== 'string') throw new StudioError('INVALID_PREFLIGHT', 'Asset preflight did not return validated paths');
    record.preflight = preflight;
    task.templatePath = preflight.templatePath;
    task.productImagePath = preflight.productImagePath;
    if (preflight.referencePath) task.referencePath = preflight.referencePath;
    await putRecord(workspace, record);
    const opened = await call('open_working_copy', { templatePath: task.templatePath });
    record.documentId = opened.id; record.runId = opened.runId;
    await putRecord(workspace, record);
    const before = await snapshot(trackingClient, opened.id);
    const plan = planTask(task, before);
    record.plan = plan;
    await putRecord(workspace, record);
    await journal.record({ event: 'plan_generated', plan, documentBefore: before });
    for (const step of plan.steps) await call(step.operation, step.args);
    let checks;
    for (let round = 0; round <= maxCorrections; round++) {
      const preview = await call('get_preview', { documentId: opened.id, name: `preview-round-${round}` });
      record.preview = preview.path;
      const current = await snapshot(trackingClient, opened.id);
      checks = checkDesign(task, current);
      record.checks = checks;
      await putRecord(workspace, record);
      await journal.record({ event: 'structural_checks', round, checks, preview: record.preview });
      if (checks.structuralPass) break;
      if (round === maxCorrections || checks.correctionSuggestions.length === 0) throw new StudioError('DESIGN_CHECKS_FAILED', 'Structural checks failed. Inspect the preview and working copy; exports were stopped.', checks);
      // MVP correction allowlist contains exact text restoration only, never invented product edits.
      for (const correction of checks.correctionSuggestions) await call(correction.operation, correction.args);
    }
    const psd = await call('save_psd', { documentId: opened.id, name: task.outputName });
    record.outputs.push(psd.path);
    await putRecord(workspace, record);
    for (const format of [...new Set(formats)]) {
      const output = await call('export_image', { documentId: opened.id, name: task.outputName, format });
      record.outputs.push(output.path);
      await putRecord(workspace, record);
    }
    // Review is an explicit recorded stage; text/bounds checks are not aesthetic verification.
    record.status = 'review_required';
    await journal.record({ event: 'awaiting_visual_review', preview: record.preview, outputs: record.outputs });
  } catch (error) {
    const data = error instanceof TaskPlanningError ? { code: error.code, message: error.message } : errorData(error);
    record.error = data;
    record.status = data.code === 'TASK_PAUSED' ? 'paused' : data.code === 'EXECUTION_UNCERTAIN' || data.code === 'ROLLBACK_FAILED' ? 'execution_uncertain' : error instanceof TaskPlanningError || ['ASSET_UNAVAILABLE','INPUT_OUTSIDE_ROOT','INVALID_PSD','UNSUPPORTED_FILE'].includes(data.code) ? 'needs_input' : 'failed';
    await journal.record({ event: 'execution_stopped', status: record.status, error: data });
  }
  await putRecord(workspace, record);
  return record;
}
