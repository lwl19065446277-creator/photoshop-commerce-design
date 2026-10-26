import { constants } from 'node:fs';
import { copyFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { StudioConfig } from './config.js';
import { StudioError } from './errors.js';

export function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export class FilePolicy {
  constructor(readonly workspace: string, readonly config: StudioConfig) {}
  async input(path: string, extensions: string[]) {
    let full: string;
    try { full = await realpath(resolve(this.workspace, path)); }
    catch (error: any) {
      if (['ENOENT','EACCES','EPERM'].includes(error.code)) throw new StudioError('ASSET_UNAVAILABLE', 'Input file is missing or cannot be accessed', { path: resolve(this.workspace, path), reason: error.code });
      throw error;
    }
    // Workbook downloads and design assets have distinct trust boundaries.
    const configuredRoots = extname(full).toLowerCase() === '.xlsx' ? this.config.workbookRoots ?? this.config.allowedInputRoots : this.config.allowedInputRoots;
    const roots = (await Promise.all(configuredRoots.map(async r => {
      try { return await realpath(resolve(this.workspace, r)); }
      catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
    }))).filter((r): r is string => r !== undefined);
    if (!roots.some(r => inside(r, full))) throw new StudioError('INPUT_OUTSIDE_ROOT', 'Input file is outside configured allowedInputRoots', { path: full });
    if (!extensions.includes(extname(full).toLowerCase())) throw new StudioError('UNSUPPORTED_FILE', `Allowed extensions: ${extensions.join(', ')}`);
    if (!(await stat(full)).isFile()) throw new StudioError('NOT_A_FILE', 'Input is not a regular file');
    return full;
  }
  async newRun(template: string) {
    const source = await this.input(template, ['.psd','.psb']);
    const handle = await open(source, 'r');
    try {
      const signature = Buffer.alloc(6);
      await handle.read(signature, 0, 6, 0);
      const version = signature.readUInt16BE(4);
      if (signature.subarray(0,4).toString('ascii') !== '8BPS' || ![1,2].includes(version)) throw new StudioError('INVALID_PSD', 'File does not have a PSD/PSB signature');
      if (version !== (extname(source).toLowerCase() === '.psb' ? 2 : 1)) throw new StudioError('INVALID_PSD', 'PSD/PSB extension and format version do not match');
    } finally { await handle.close(); }
    const outputRoot = resolve(this.workspace, this.config.outputRoot);
    await mkdir(outputRoot, { recursive: true });
    const canonicalOutput = await realpath(outputRoot);
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const dir = resolve(canonicalOutput, runId);
    await mkdir(dir);
    const workingPath = resolve(dir, `working${extname(source).toLowerCase()}`);
    const sourceHash = await hashFile(source);
    await copyFile(source, workingPath, constants.COPYFILE_EXCL);
    if (await hashFile(workingPath) !== sourceHash || await hashFile(source) !== sourceHash) {
      throw new StudioError('SOURCE_CHANGED', 'Template changed while copying. Stop and use a stable source file.');
    }
    return { runId, dir, source, sourceHash, workingPath, files: [] as string[] };
  }
  async output(dir: string, name: string | undefined, extension: string) {
    const stem = name || 'design';
    if (stem !== basename(stem) || /[<>:"/\\|?*\x00-\x1f]/.test(stem) || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) || stem === '.' || stem === '..') {
      throw new StudioError('INVALID_OUTPUT_NAME', 'Use a plain filename stem without path separators or reserved characters');
    }
    const path = resolve(await realpath(dir), `${stem}-${randomUUID().slice(0, 8)}.${extension}`);
    if (!inside(await realpath(dir), path)) throw new StudioError('INVALID_OUTPUT_PATH', 'Output escaped task directory');
    try { await stat(path); } catch (e: any) { if (e.code === 'ENOENT') return path; throw e; }
    throw new StudioError('OUTPUT_EXISTS', 'Refusing to overwrite an output file');
  }
}
