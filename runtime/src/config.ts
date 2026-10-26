import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
export const configSchema = z.object({
  port: z.literal(57123).default(57123),
  allowedInputRoots: z.array(z.string()).min(1),
  workbookRoots: z.array(z.string()).min(1).optional(),
  outputRoot: z.string(),
  commandTimeoutMs: z.number().int().min(100).max(600000).default(90000)
}).strict();
export type StudioConfig = z.infer<typeof configSchema>;
export async function loadConfig(workspace: string): Promise<StudioConfig> {
  return configSchema.parse(JSON.parse(await readFile(resolve(workspace, 'studio.config.json'), 'utf8')));
}
export async function connectionFile(workspace: string, port: number) {
  const dir = resolve(workspace, '.studio');
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, 'connection.json');
  // Rotate on every bridge start: stale plugin sessions cannot execute later commands.
  const connection = { baseUrl: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('hex'), protocolVersion: 1 };
  await writeFile(file, JSON.stringify(connection, null, 2), { mode: 0o600 });
  return connection;
}
