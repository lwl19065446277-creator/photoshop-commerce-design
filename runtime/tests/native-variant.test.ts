import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve} from 'node:path';
import {variantPlanSchema,validateVariantPlan} from '../src/design/variant-plan.js';import {hashFile} from '../src/paths.js';
const plan={kind:'native-variant',name:'fixture',working:'working.psd',sourceSha256:'a'.repeat(64),width:1440,height:649,psd:'a.psd',png:'a.png',jpg:'a.jpg',visibility:[],texts:[],sourceCells:[]};
test('native variants constrain edits, emphasis and native crop geometry',()=>{
 assert.equal(variantPlanSchema.safeParse(plan).success,true);
 assert.equal(variantPlanSchema.safeParse({...plan,script:'app.quit()'}).success,false);
 assert.equal(variantPlanSchema.safeParse({...plan,crop:[0,500,1440,200]}).success,false);
 assert.equal(variantPlanSchema.safeParse({...plan,texts:[{id:1,expected:'a',text:'b',color:'FFFFFF',emphasis:{text:'c',color:'FF0000'}}]}).success,false);
});
test('native variant overlay must have verified provenance and no output may overwrite input',async()=>{
 const workspace=await mkdtemp(resolve(tmpdir(),'native-variant-'));
 try{
  const dir=resolve(workspace,'runs','fixture');await mkdir(dir,{recursive:true});const working=resolve(dir,'working.psd');await writeFile(working,'test fixture only');
  const p={...plan,working,sourceSha256:await hashFile(working),psd:resolve(dir,'design.psd'),png:resolve(dir,'out.png'),jpg:resolve(dir,'out.jpg')};
  const path=resolve(dir,'plan.json');await writeFile(path,JSON.stringify(p));await validateVariantPlan(path,workspace);
  await writeFile(path,JSON.stringify({...p,psd:working}));await assert.rejects(validateVariantPlan(path,workspace),/exists/);
  const outside=resolve(workspace,'outside.psd');await writeFile(outside,'outside fixture');
  await writeFile(path,JSON.stringify({...p,overlay:{path:outside,sha256:await hashFile(outside),box:[0,0,1440,649],name:'test',aboveLayerId:1}}));await assert.rejects(validateVariantPlan(path,workspace),/hash-verified run artifact/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
