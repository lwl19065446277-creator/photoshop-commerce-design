import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export class Journal {
  private tail = Promise.resolve();
  constructor(readonly path: string) {}
  record(event: Record<string, unknown>) {
    const work = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
export async function saveRecord(dir: string, name: string, value: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, name), JSON.stringify(value, null, 2), { flag: 'wx' });
}
