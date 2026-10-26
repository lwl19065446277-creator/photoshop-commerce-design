import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { operationSchemas } from './contracts.js';
import { BridgeClient } from './client.js';
import { errorData } from './errors.js';
import { FilePolicy } from './paths.js';
import { loadConfig } from './config.js';
import { importWorkbook } from './import-workbook.js';
import { designTaskSchema, taskValuesSchema } from './tasks/model.js';
import { planTask } from './tasks/planner.js';
import { checkDesign } from './tasks/checker.js';
import { runTask, snapshot, listExecutions, getExecution, pauseExecution, reviewExecution } from './runner.js';

const descriptions: Record<string,string> = {
  ping: 'Check real Photoshop UXP connectivity. Never returns simulated success.',
  preflight_assets: 'Validate all explicitly bound local assets before Photoshop modifications; works disconnected. Does not execute Photoshop.',
  get_document_info: 'Read real Photoshop document metadata. Omit documentId for current document.',
  list_layers: 'Read the real nested layer tree, IDs, text and pixel bounds.',
  find_layer: 'Find a single layer by exact name. Ambiguous names are rejected.',
  open_working_copy: 'Copy an allowed PSD/PSB to a unique run folder and open only the copy. Original files stay protected.',
  set_text: 'Set exact text on a managed text layer, with history rollback on failure.',
  replace_smart_object: 'Replace embedded Smart Object content with a protected local asset copy. Linked objects are rejected.',
  set_visibility: 'Show or hide one managed layer.', transform_layer: 'Translate or uniformly scale one managed layer. No anisotropic product deformation.',
  create_text: 'Create an editable text layer in a managed document.',
  get_preview: 'Save an actual PNG preview from Photoshop; return file path and inline image when small enough.',
  save_psd: 'Save an editable layered PSD under the run folder. Refuse existing destinations.',
  export_image: 'Export a real PNG or JPG under the run folder. Refuse existing destinations.',
  close_document: 'Close a working copy without saving changes to its input file.'
};
const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
export function createStudioMcp(workspace: string) {
  const server = new McpServer({ name: 'design-agent-studio', version: '0.1.0' });
  const client = new BridgeClient(workspace);
  const safe = (fn: (args: any) => Promise<any>) => async (args: any) => {
    try { return await fn(args); }
    catch (error) { return { ...textResult({ error: errorData(error) }), isError: true }; }
  };
  for (const [operation, schema] of Object.entries(operationSchemas)) {
    server.registerTool(`photoshop_${operation}`, {
      description: descriptions[operation], inputSchema: schema,
      annotations: { readOnlyHint: ['ping','get_document_info','list_layers','find_layer','preflight_assets'].includes(operation), destructiveHint: false, idempotentHint: ['ping','get_document_info','list_layers','find_layer','preflight_assets'].includes(operation), openWorldHint: false }
    }, safe(async args => {
      const result = await client.execute(operation, args);
      const content: any[] = textResult(result).content;
      if (operation === 'get_preview' && result.path) {
        const bytes = await readFile(result.path);
        if (bytes.length <= 8 * 1024 * 1024) content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    }));
  }
  server.registerTool('studio_status', { description: 'Inspect local bridge, real UXP session and uncertain execution state.', inputSchema: {}, annotations: { readOnlyHint: true } }, safe(async () => textResult(await client.status())));
  server.registerTool('studio_parse_excel', { description: 'Read .xlsx without editing. ALL workbook file-path cells are ignored. Assets come only from explicit assetBindings within configured asset roots. Missing inputs become needs_input.', inputSchema: { path: z.string(), sheetName: z.string().optional(), headerRow: z.number().int().positive().optional(), materialRoot: z.string().optional(), mapping: z.record(z.string()).optional(), defaults: taskValuesSchema.optional(), assetBindings: z.object({ templatePath: z.string().optional(), productImagePath: z.string().optional(), referencePath: z.string().optional() }).strict().optional() }, annotations: { readOnlyHint: true } }, safe(async args => {
    const config = await loadConfig(workspace);
    const path = await new FilePolicy(workspace, config).input(args.path, ['.xlsx']);
    return textResult(await importWorkbook(workspace, path, args));
  }));
  server.registerTool('studio_plan_task', { description: 'Create a conservative template plan using actual Photoshop layer IDs. It does not apply mutations.', inputSchema: { task: designTaskSchema, documentId: z.number().int().positive() }, annotations: { readOnlyHint: true } }, safe(async args => textResult(planTask(args.task, await snapshot(client, args.documentId)))));
  server.registerTool('studio_check_design', { description: 'Compare exact text, dimensions, visibility and bounds. Aesthetics/product identity still require real preview review.', inputSchema: { task: designTaskSchema, documentId: z.number().int().positive() }, annotations: { readOnlyHint: true } }, safe(async args => textResult(checkDesign(args.task, await snapshot(client, args.documentId)))));
  server.registerTool('studio_run_task', { description: 'Run one real template task: working copy, actual layer inspection, plan, mutations, preview, bounded checks, PSD and PNG/JPG export. Ends review_required; never fabricates Photoshop.', inputSchema: { task: designTaskSchema, maxCorrections: z.number().int().min(0).max(2).default(1), formats: z.array(z.enum(['png','jpg'])).min(1).max(2).default(['png','jpg']) }, annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false } }, safe(async args => textResult(await runTask(workspace, client, args.task, args))));
  server.registerTool('studio_list_tasks', { description: 'Read local execution records only. Does not write to source Excel or Feishu.', inputSchema: {}, annotations: { readOnlyHint: true } }, safe(async () => textResult(await listExecutions(workspace))));
  server.registerTool('studio_get_task', { description: 'Read a local execution record and trace artifacts.', inputSchema: { executionId: z.string().uuid() }, annotations: { readOnlyHint: true } }, safe(async args => textResult(await getExecution(workspace, args.executionId))));
  server.registerTool('studio_pause_task', { description: 'Request pause at next operation boundary; no forced interruption or automatic replay.', inputSchema: { executionId: z.string().uuid() } }, safe(async args => textResult(await pauseExecution(workspace, args.executionId))));
  server.registerTool('studio_review_task', { description: 'Record an explicit preview review in local files only. Call only after inspecting the real preview. Approval is reviewer evidence, not automatic aesthetic proof.', inputSchema: { executionId: z.string().uuid(), decision: z.enum(['approved','rejected']), findings: z.array(z.string().max(2000)).min(1).max(30), reviewer: z.string().min(1).max(100) } }, safe(async args => textResult(await reviewExecution(workspace, args.executionId, args.decision, args.findings, args.reviewer))));
  return server;
}
