import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fourProductBands, nativeSlicePlanSchema, validateNativeSlicePlan } from '../src/design/slice-plan.js';
import { hashFile } from '../src/paths.js';

test('four-product slicing includes header, handles odd remainder and joins exactly', () => {
  const bands = fourProductBands(697, 3202, [187,617,1047,1477,1907,2337,2767], 13);
  assert.deepEqual(bands.map(b => [b.y,b.height,b.first,b.last]), [[0,1047,1,4],[1047,860,5,8],[1907,860,9,12],[2767,435,13,13]]);
  assert.deepEqual(fourProductBands(1440,2190,[404,1284],4), [{x:0,y:0,width:1440,height:2190,first:1,last:4}]);
  assert.throws(() => fourProductBands(100,100,[20,10],4));
});

test('native slice plan refuses gaps, overlaps and missing bottom margin', () => {
  const plan = {kind:'native-slices',name:'test',working:'working.psd',sourceSha256:'a'.repeat(64),width:100,height:100,slices:[{name:'a',x:0,y:0,width:100,height:50,png:'a.png'},{name:'b',x:0,y:50,width:100,height:50,png:'b.png'}]};
  assert.equal(nativeSlicePlanSchema.safeParse(plan).success,true);
  for (const y of [49,51]) assert.equal(nativeSlicePlanSchema.safeParse({...plan,slices:[plan.slices[0],{...plan.slices[1],y}]}).success,false);
  assert.equal(nativeSlicePlanSchema.safeParse({...plan,slices:[plan.slices[0]]}).success,false);
});

test('native slice validation protects source hash, output scope and existing files', async () => {
  const workspace=await mkdtemp(resolve(tmpdir(),'studio-slices-'));
  try {
    const dir=resolve(workspace,'runs','job'); await mkdir(dir,{recursive:true});
    const working=resolve(dir,'working.psd'), path=resolve(dir,'plan.json'); await writeFile(working,'test fixture only');
    const plan={kind:'native-slices',name:'test',working,sourceSha256:await hashFile(working),width:100,height:100,slices:[{name:'a',x:0,y:0,width:100,height:100,png:resolve(dir,'a.png')}]};
    await writeFile(path,JSON.stringify(plan)); await validateNativeSlicePlan(path,workspace);
    const raster=resolve(dir,'full.png');await writeFile(raster,'test raster fixture only');
    await writeFile(path,JSON.stringify({...plan,rasterSource:raster,rasterSha256:'0'.repeat(64)}));await assert.rejects(validateNativeSlicePlan(path,workspace),/raster source path\/hash/);
    await writeFile(path,JSON.stringify({...plan,rasterSource:raster,rasterSha256:await hashFile(raster)}));await validateNativeSlicePlan(path,workspace);
    await writeFile(path,JSON.stringify(plan));
    await writeFile(plan.slices[0].png,'existing'); await assert.rejects(validateNativeSlicePlan(path,workspace),/exists/);
    await writeFile(path,JSON.stringify({...plan,slices:[{...plan.slices[0],png:resolve(workspace,'outside.png')}]})); await assert.rejects(validateNativeSlicePlan(path,workspace),/outside/);
    await writeFile(path,JSON.stringify({...plan,sourceSha256:'0'.repeat(64)})); await assert.rejects(validateNativeSlicePlan(path,workspace),/hash/);
  } finally { await rm(workspace,{recursive:true,force:true}); }
});
