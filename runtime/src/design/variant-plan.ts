import {z} from 'zod';
import {access,readFile,realpath,stat} from 'node:fs/promises';
import {basename,dirname,extname,resolve} from 'node:path';
import {hashFile,inside} from '../paths.js';
const id=z.number().int().positive();
const bounds=z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative(),z.number().int().positive(),z.number().int().positive()]);
export const variantPlanSchema=z.object({
 kind:z.literal('native-variant'),name:z.string().min(1),working:z.string().min(1),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
 width:id.max(30000),height:id.max(30000),psd:z.string(),png:z.string(),jpg:z.string(),
 visibility:z.array(z.object({id,name:z.string(),visible:z.boolean()}).strict()).max(50),
 texts:z.array(z.object({id,expected:z.string(),text:z.string().max(10000),fit:bounds.optional(),autoLeading:z.literal(true).optional(),color:z.string().regex(/^[a-f0-9]{6}$/i).optional(),emphasis:z.object({text:z.string().min(1),color:z.string().regex(/^[a-f0-9]{6}$/i)}).strict().optional()}).strict()).max(50),
 overlay:z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),box:z.tuple([z.number().finite(),z.number().finite(),z.number().positive(),z.number().positive()]),name:z.string().min(1),aboveLayerId:id}).strict().optional(),
 crop:bounds.optional(),sourceCells:z.array(z.object({sheet:z.string(),cell:z.string()}).strict())
}).strict().superRefine((p,ctx)=>{
 if(new Set(p.texts.map(x=>x.id)).size!==p.texts.length||new Set(p.visibility.map(x=>x.id)).size!==p.visibility.length)ctx.addIssue({code:'custom',message:'Duplicate layer edits'});
 for(const t of p.texts)if(t.emphasis&&(!t.color||t.text.indexOf(t.emphasis.text)<0))ctx.addIssue({code:'custom',message:'Emphasis needs an explicit base color and matching text'});
 if(p.crop&&(p.crop[0]+p.crop[2]>p.width||p.crop[1]+p.crop[3]>p.height))ctx.addIssue({code:'custom',message:'Crop outside source canvas'});
 for(const t of p.texts)if(t.fit&&(t.fit[0]+t.fit[2]>p.width||t.fit[1]+t.fit[3]>p.height))ctx.addIssue({code:'custom',message:'Text fit outside source canvas'});
});
export async function validateVariantPlan(path:string,workspace:string){
 const root=await realpath(resolve(workspace,'runs')),actual=await realpath(path),parent=await realpath(dirname(actual));
 if(!inside(root,actual)||extname(actual)!=='.json'||(await stat(actual)).size>1024*1024)throw Error('Invalid native variant plan');
 const p=variantPlanSchema.parse(JSON.parse(await readFile(actual,'utf8'))),working=await realpath(p.working);
 if(dirname(working).toLowerCase()!==parent.toLowerCase()||basename(working).toLowerCase()!=='working.psd'||await hashFile(working)!==p.sourceSha256)throw Error('Variant working copy/hash mismatch');
 if(p.overlay){const f=await realpath(p.overlay.path);if(!inside(root,f)||!['.psd','.png'].includes(extname(f).toLowerCase())||await hashFile(f)!==p.overlay.sha256)throw Error('Overlay must be a hash-verified run artifact');}
 const outputs=[p.psd,p.png,p.jpg];if(new Set(outputs.map(x=>resolve(x).toLowerCase())).size!==3)throw Error('Duplicate variant output');
 for(let i=0;i<3;i++){const f=outputs[i];if((await realpath(dirname(f))).toLowerCase()!==parent.toLowerCase()||extname(f).toLowerCase()!==['.psd','.png','.jpg'][i])throw Error('Invalid variant output path/extension');try{await access(f);}catch(e:any){if(e.code==='ENOENT')continue;throw e;}throw Error('Variant output exists; inspect before retry');}
 return p;
}
