import { loadConfig } from './config.js';
import { FilePolicy } from './paths.js';
import { parseWorkbook, type ParseWorkbookOptions } from './tasks/parser.js';

/** Public import boundary: workbook paths are data; only external bindings can select assets. */
export async function importWorkbook(workspace: string, path: string, options: ParseWorkbookOptions = {}) {
  const files = new FilePolicy(workspace, await loadConfig(workspace));
  const workbook = await files.input(path, ['.xlsx']);
  // Parser never stats paths before the configured root policy has validated them.
  const tasks = await parseWorkbook(workbook, { ...options, checkFiles: false });
  for (const task of tasks) {
    for (const [field, extensions] of [
      ['templatePath', ['.psd','.psb']],
      ['productImagePath', ['.png','.jpg','.jpeg','.tif','.tiff','.psd']],
      ['referencePath', ['.png','.jpg','.jpeg','.tif','.tiff','.psd','.psb']]
    ] as const) {
      if (!task[field]) continue;
      try { task[field] = await files.input(task[field]!, [...extensions]); }
      catch (error) {
        task.status = 'needs_input';
        task.issues.push({ code: 'ASSET_NOT_AUTHORIZED_OR_MISSING', field, severity: 'error', message: `${field}: ${error instanceof Error ? error.message : String(error)}` });
        delete task[field];
      }
    }
  }
  return tasks;
}
