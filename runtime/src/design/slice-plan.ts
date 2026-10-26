import { z } from 'zod';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { hashFile, inside } from '../paths.js';
import { sliceSchema } from './plan.js';

/** Whole-width, contiguous partitions preserve the original page when joined. */
export const nativeSlicePlanSchema = z.object({
  kind: z.literal('native-slices'), name: z.string().min(1),
  working: z.string().min(1), sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rasterSource: z.string().min(1).optional(), rasterSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  width: z.number().int().positive().max(30000),
  height: z.number().int().positive().max(30000),
  slices: z.array(sliceSchema).min(1).max(200)
}).strict().superRefine((p, ctx) => {
  if (Boolean(p.rasterSource) !== Boolean(p.rasterSha256)) ctx.addIssue({code:'custom',message:'Raster source requires its hash'});
  let y = 0;
  for (const s of p.slices) {
    if (s.x !== 0 || s.width !== p.width || s.y !== y || s.y + s.height > p.height)
      ctx.addIssue({ code: 'custom', message: 'Slices must partition the full canvas without gaps, overlaps or resizing' });
    y = s.y + s.height;
  }
  if (y !== p.height) ctx.addIssue({ code: 'custom', message: 'Slices must include the bottom margin' });
});

export function fourProductBands(width: number, height: number, rowStarts: number[], count: number) {
  if (!Number.isInteger(count) || count < 1 || rowStarts.length !== Math.ceil(count / 2)
      || rowStarts.some((y, i) => !Number.isInteger(y) || y < 0 || y >= height || (i > 0 && y <= rowStarts[i - 1])))
    throw Error('Expected ordered row boundaries for a two-column page');
  return Array.from({ length: Math.ceil(count / 4) }, (_, i) => {
    const y = i === 0 ? 0 : rowStarts[i * 2];
    const end = (i + 1) * 2 < rowStarts.length ? rowStarts[(i + 1) * 2] : height;
    return { x: 0, y, width, height: end - y, first: i * 4 + 1, last: Math.min(count, i * 4 + 4) };
  });
}

export async function validateNativeSlicePlan(path: string, workspace: string) {
  const root = await realpath(resolve(workspace, 'runs')), actual = await realpath(path);
  if (!inside(root, actual) || extname(actual) !== '.json' || !(await stat(actual)).isFile() || (await stat(actual)).size > 1024 * 1024)
    throw Error('Slice plan must be a small JSON file inside runs');
  const parent = await realpath(dirname(actual));
  const plan = nativeSlicePlanSchema.parse(JSON.parse(await readFile(actual, 'utf8')));
  const working = await realpath(plan.working);
  if (dirname(working).toLowerCase() !== parent.toLowerCase() || basename(working).toLowerCase() !== 'working.psd'
      || await hashFile(working) !== plan.sourceSha256) throw Error('Slice working-copy path/hash mismatch');
  if (plan.rasterSource) {
    const raster = await realpath(plan.rasterSource);
    if (dirname(raster).toLowerCase() !== parent.toLowerCase() || extname(raster).toLowerCase() !== '.png'
        || await hashFile(raster) !== plan.rasterSha256) throw Error('Slice raster source path/hash mismatch');
  }
  const outputs = plan.slices.flatMap(s => [s.png, s.jpg].filter((x): x is string => !!x));
  if (new Set(outputs.map(x => resolve(x).toLowerCase())).size !== outputs.length) throw Error('Duplicate slice output');
  for (const output of outputs) {
    if ((await realpath(dirname(output))).toLowerCase() !== parent.toLowerCase()) throw Error('Slice output outside plan directory');
    try { await access(output); } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
    throw Error('Slice output exists; no overwrite or replay');
  }
  return plan;
}
