import {parseArgs} from 'node:util';
import {access,mkdir,open,readFile,writeFile,unlink,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {ComPhotoshopClient,type ComOperation} from '../src/legacy/client.js';
import {Journal} from '../src/journal.js';
import {errorData} from '../src/errors.js';
import {validateRenderPlan} from '../src/design/plan.js';
import {validateCatalogPlan} from '../src/design/catalog-plan.js';
import {validateNativeSlicePlan} from '../src/design/slice-plan.js';
import {validateVariantPlan} from '../src/design/variant-plan.js';

// This entrypoint never accepts raw JSX, Shell or BatchPlay.
const operations=['ping','font_catalog','inspect_document','audit_document','layer_descriptor','open_working_copy','set_text','save_psd','export_preview','close_document','render_design','render_native_catalog','export_native_slices','render_native_variant'] as const;
const reads=new Set(['ping','font_catalog','inspect_document','audit_document','layer_descriptor']);
const parsed=parseArgs({allowPositionals:true,options:{workspace:{type:'string'},args:{type:'string'},'timeout-ms':{type:'string'},help:{type:'boolean'}}});
async function exists(p:string){try{await access(p);return true;}catch(e:any){if(e.code==='ENOENT')return false;throw e;}}
async function main(){
 const name=parsed.positionals[0];
 if(parsed.values.help||!name){console.log('npm run com -- OPERATION [--args args.json] [--timeout-ms 120000] [--workspace PROJECT]\nOperations: '+operations.join(', ')+'\nWindows real-com only. Mutations are serialized and never retried automatically.');return;}
 if(!(operations as readonly string[]).includes(name))throw Error('Unknown static COM operation');
 if(process.platform!=='win32')throw Error('real-com requires Windows; use a separately verified UXP bridge on other systems');
 const workspace=await realpath(resolve(parsed.values.workspace||'.'));
 const args=parsed.values.args?JSON.parse(await readFile(resolve(workspace,parsed.values.args),'utf8')):{};
 const timeout=Number(parsed.values['timeout-ms']||120000);if(!Number.isInteger(timeout)||timeout<1000||timeout>3600000)throw Error('Timeout must be 1000–3600000ms');
 let folder:string|undefined;
 if(['render_design','render_native_catalog','export_native_slices','render_native_variant'].includes(name)){
  if(typeof args.path!=='string')throw Error('Render requires a JSON plan path');args.path=await realpath(resolve(workspace,args.path));
  if(name==='render_design')await validateRenderPlan(args.path,workspace);
  else if(name==='render_native_catalog')await validateCatalogPlan(args.path,workspace);
  else if(name==='export_native_slices')await validateNativeSlicePlan(args.path,workspace);
  else await validateVariantPlan(args.path,workspace);
  folder=dirname(args.path);if(await exists(resolve(folder,'receipt.json')))throw Error('Receipt already exists; inspect it instead of replaying');
 }
 await mkdir(resolve(workspace,'.studio'),{recursive:true});
 const lock=resolve(workspace,'.studio','skill-com.lock');
 const handle=await open(lock,'wx');await handle.writeFile(JSON.stringify({operation:name,started:new Date().toISOString(),pid:process.pid}));await handle.close();
 let retainLock=false;
 try{
  if(folder)await writeFile(resolve(folder,'skill-attempt.json'),JSON.stringify({operation:name,plan:args.path,at:new Date().toISOString()}),{flag:'wx'});
  const client=new ComPhotoshopClient(workspace,resolve(workspace,'.studio','com-commands'),new Journal(resolve(workspace,'.studio','com-events.jsonl')));
  try{
   const result=await client.execute(name as ComOperation,args,timeout);
   if(folder)await writeFile(resolve(folder,'receipt.json'),JSON.stringify(result,null,2),{flag:'wx'});
   console.log(JSON.stringify(result,null,2));
  }catch(error){
   if(!reads.has(name)){
    retainLock=true;
    await writeFile(resolve(workspace,'.studio','needs-inspection.json'),JSON.stringify({operation:name,error:errorData(error),message:'Mutation failed or has an uncertain outcome. Inspect command/result files, partial outputs and Photoshop. Do not replay or clear the lock solely because time passed.'},null,2));
   }
   throw error;
  }
 }finally{if(!retainLock)await unlink(lock);}
}
main().catch(e=>{console.error(JSON.stringify({error:errorData(e)},null,2));process.exitCode=1;});
