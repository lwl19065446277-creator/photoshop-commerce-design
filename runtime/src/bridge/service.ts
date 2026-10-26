import { copyFile, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operationSchemas, type Operation } from '../contracts.js';
import { StudioError, errorData } from '../errors.js';
import { FilePolicy, hashFile } from '../paths.js';
import { Journal, saveRecord } from '../journal.js';
import { CommandQueue } from './queue.js';

export type Run = Awaited<ReturnType<FilePolicy['newRun']>> & { documentId: number; assets: { source: string; hash: string; copy: string }[] };
export class PhotoshopService {
  readonly runs = new Map<number, Run>();
  private executing = false;
  constructor(readonly queue: CommandQueue, readonly files: FilePolicy, readonly journal: Journal) {}
  clearManagedDocuments() { this.runs.clear(); }
  status() {
    return { connected: this.queue.connected, busy: this.queue.busy || this.executing, uncertain: this.queue.uncertain,
      session: this.queue.session && { ...this.queue.session }, managedDocuments: [...this.runs.keys()], mode: 'real-uxp', protocolVersion: 1 };
  }
  private run(documentId: number) {
    const run = this.runs.get(documentId);
    if (!run) throw new StudioError('UNMANAGED_DOCUMENT', 'Only working copies opened by this bridge session may be modified. Use open_working_copy first.');
    return run;
  }
  private async verifySources(run: Run) {
    for (const item of [{ source: run.source, hash: run.sourceHash }, ...run.assets]) {
      if (await hashFile(item.source) !== item.hash) throw new StudioError('SOURCE_CHANGED', 'An original input changed during execution. Stop and inspect.', { path: item.source });
    }
  }
  private async preflightAssets(args: { templatePath: string; productImagePath: string; referencePath?: string }) {
    const imageExtensions = ['.png','.jpg','.jpeg','.tif','.tiff','.psd'];
    const templatePath = await this.files.input(args.templatePath, ['.psd','.psb']);
    const productImagePath = await this.files.input(args.productImagePath, imageExtensions);
    const referencePath = args.referencePath === undefined ? undefined : await this.files.input(args.referencePath, [...imageExtensions,'.psb']);
    const template = await open(templatePath, 'r');
    try {
      const header = Buffer.alloc(6);
      const { bytesRead } = await template.read(header, 0, header.length, 0);
      const expectedVersion = extname(templatePath).toLowerCase() === '.psb' ? 2 : 1;
      if (bytesRead !== header.length || header.subarray(0,4).toString('ascii') !== '8BPS' || header.readUInt16BE(4) !== expectedVersion) {
        throw new StudioError('INVALID_PSD', 'Template requires a matching PSD/PSB signature and format version', { path: templatePath });
      }
    } finally { await template.close(); }
    const assets: { role: string; path: string; sha256: string; format?: string }[] = [
      { role: 'template', path: templatePath, sha256: await hashFile(templatePath), format: extname(templatePath).slice(1).toLowerCase() },
      { role: 'product', path: productImagePath, sha256: await hashFile(productImagePath) }
    ];
    if (referencePath) assets.push({ role: 'reference', path: referencePath, sha256: await hashFile(referencePath) });
    return { kind: 'local-asset-preflight', photoshopExecuted: false, templatePath, productImagePath, ...(referencePath ? { referencePath } : {}), assets };
  }
  private async verifyOutput(path: string, ext: string) {
    const file = await open(path, 'r');
    try {
      const head = Buffer.alloc(8); await file.read(head, 0, 8, 0);
      const valid = ext === 'psd' ? head.subarray(0, 4).toString() === '8BPS' && head.readUInt16BE(4) === 1 : ext === 'png' ? head.equals(Buffer.from([137,80,78,71,13,10,26,10])) : head[0] === 255 && head[1] === 216;
      if (!valid || (await stat(path)).size < 16) throw new StudioError('INVALID_OUTPUT', 'Photoshop reported success but the output has no valid file signature', { path });
    } finally { await file.close(); }
  }
  async execute(operation: string, input: unknown): Promise<any> {
    if (!Object.hasOwn(operationSchemas, operation)) throw new StudioError('UNKNOWN_OPERATION', 'Operation is not in the Photoshop tool allowlist');
    const args: any = operationSchemas[operation as Operation].parse(input);
    if (this.executing) throw new StudioError('BUSY', 'A Photoshop operation is already being prepared or executed');
    this.executing = true;
    const commandId = randomUUID();
    let run: Run | undefined;
    let pluginOperation = operation;
    let pluginArgs: Record<string, unknown> = { ...args };
    let outputPath: string | undefined;
    let outputExtension: string | undefined;
    try {
      await this.journal.record({ event: 'operation_requested', commandId, operation, args });
      if (operation === 'preflight_assets') {
        const result = await this.preflightAssets(args);
        await this.journal.record({ event: 'operation_succeeded', commandId, operation, result });
        return result;
      }
      if (!this.queue.connected) throw new StudioError('PHOTOSHOP_DISCONNECTED', 'Photoshop UXP is not connected. Start Photoshop, load the plugin and select .studio/connection.json.');
      if (this.queue.uncertain) throw new StudioError('EXECUTION_UNCERTAIN', 'Inspect Photoshop and restart the bridge before further execution.');
      if (operation === 'open_working_copy') {
        const created = await this.files.newRun(args.templatePath);
        run = { ...created, documentId: 0, assets: [] };
        await saveRecord(run.dir, 'source.json', { ...created, backend: 'real-uxp' });
        pluginOperation = 'open_document'; pluginArgs = { path: run.workingPath };
      } else if (!['ping','get_document_info','list_layers','find_layer'].includes(operation)) {
        run = this.run(args.documentId);
        if (operation === 'replace_smart_object') {
          const source = await this.files.input(args.path, ['.png','.jpg','.jpeg','.tif','.tiff','.psd']);
          const copy = resolve(run.dir, `asset-${randomUUID()}${extname(source).toLowerCase()}`);
          const hash = await hashFile(source);
          await copyFile(source, copy, constants.COPYFILE_EXCL);
          if (await hashFile(copy) !== hash || await hashFile(source) !== hash) throw new StudioError('SOURCE_CHANGED', 'Product image changed while copying');
          run.assets.push({ source, hash, copy });
          pluginArgs.path = copy;
        }
        if (['get_preview','save_psd','export_image'].includes(operation)) {
          outputExtension = operation === 'save_psd' ? 'psd' : operation === 'get_preview' ? 'png' : args.format;
          outputPath = await this.files.output(run.dir, args.name || (operation === 'get_preview' ? 'preview' : 'design'), outputExtension!);
          pluginArgs = { ...args, path: outputPath }; delete pluginArgs.name;
        }
      }
      await this.journal.record({ event: 'command_queued', commandId, runId: run?.runId, operation: pluginOperation, args: pluginArgs });
      const result: any = await this.queue.submit(pluginOperation, pluginArgs, commandId);
      if (operation === 'open_working_copy') {
        if (!Number.isInteger(result?.id) || result.id < 1) throw new StudioError('INVALID_PLUGIN_RESULT', 'open_document did not return a document id');
        run!.documentId = result.id; this.runs.set(result.id, run!);
      }
      if (outputPath && outputExtension) {
        await this.verifyOutput(outputPath, outputExtension);
        await this.verifySources(run!);
        run!.files.push(outputPath);
      }
      if (operation === 'close_document') { await this.verifySources(run!); this.runs.delete(args.documentId); }
      const response = outputPath ? { ...result, path: outputPath, runId: run!.runId, backend: 'real-uxp' } : operation === 'open_working_copy' ? { ...result, runId: run!.runId, workingPath: run!.workingPath, sourceHash: run!.sourceHash, backend: 'real-uxp' } : result;
      await this.journal.record({ event: 'operation_succeeded', commandId, operation, runId: run?.runId, result: response });
      return response;
    } catch (error) {
      if (error instanceof StudioError && (error.code === 'ROLLBACK_FAILED' || (error.details as any)?.outcome === 'unknown')) this.queue.uncertain = true;
      await this.journal.record({ event: 'operation_failed', commandId, operation, runId: run?.runId, error: errorData(error) });
      throw error;
    } finally { this.executing = false; }
  }
}
