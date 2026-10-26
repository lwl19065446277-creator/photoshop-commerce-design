import {z} from 'zod';
import {access,readFile,realpath,stat} from 'node:fs/promises';
import {dirname,extname,resolve} from 'node:path';
import {inside} from '../paths.js';
import {loadConfig} from '../config.js';
const finite=z.number().finite();
const coordinate=finite.min(-20000).max(20000);
const gradientMask=z.object({from:z.tuple([coordinate,coordinate]),to:z.tuple([coordinate,coordinate]),feather:finite.min(0).max(100).optional()}).strict().refine(m=>m.from[0]!==m.to[0]||m.from[1]!==m.to[1],'Gradient mask needs two distinct points');
const common={name:z.string().min(1).max(150),group:z.string().min(1).max(80),opacity:finite.min(0).max(100).optional(),gradientMask:gradientMask.optional()};
const hex=z.string().regex(/^[0-9a-f]{6}$/i);
export const layerSchema=z.discriminatedUnion('type',[
 z.object({...common,type:z.literal('text'),text:z.string().max(10000),font:z.string().min(1),size:finite.min(1).max(1296),x:finite,y:finite,color:hex,align:z.enum(['left','center','right']).optional(),maxWidth:finite.positive().optional(),tracking:finite.min(-1000).max(10000).optional(),leading:finite.positive().optional(),italic:z.boolean().optional(),strike:z.boolean().optional()}).strict(),
 z.object({...common,type:z.literal('rect'),x:finite,y:finite,width:finite.positive(),height:finite.positive(),radius:finite.nonnegative().optional(),color:hex}).strict(),
 z.object({...common,type:z.literal('image'),path:z.string().min(1),box:z.tuple([finite,finite,finite.positive(),finite.positive()]),crop:z.tuple([finite,finite,finite,finite]).optional(),tint:z.enum(['000000','FFFFFF']).optional(),subjectMask:z.boolean().optional(),anchor:z.enum(['center','bottom']).optional(),fit:z.enum(['contain','cover']).optional(),clip:z.object({x:finite,y:finite,width:finite.positive(),height:finite.positive(),radius:finite.nonnegative()}).strict().optional()}).strict()
]).refine(l=>!(l.type==='image'&&l.subjectMask&&l.gradientMask),'Choose a subject mask or a gradient mask, not both');
export const sliceSchema=z.object({name:z.string().min(1).max(150),x:finite.int().nonnegative(),y:finite.int().nonnegative(),width:finite.int().positive(),height:finite.int().positive(),png:z.string().min(1).optional(),jpg:z.string().min(1).optional()}).strict().refine(s=>Boolean(s.png||s.jpg),'Slice needs an output').refine(s=>(!s.png||extname(s.png).toLowerCase()==='.png')&&(!s.jpg||extname(s.jpg).toLowerCase()==='.jpg'),'Slice output extension must match format');
export const compositionSchema=z.object({kind:z.literal('compose'),name:z.string().min(1),width:finite.int().min(1).max(20000),height:finite.int().min(1).max(20000),psd:z.string().min(1),png:z.string().min(1),jpg:z.string().min(1).optional(),sourceCells:z.array(z.object({sheet:z.string(),cell:z.string()})),groupOrder:z.array(z.string().min(1)).max(300).optional(),layers:z.array(layerSchema).min(1).max(600),slices:z.array(sliceSchema).max(200).optional()}).strict().refine(p=>!p.groupOrder||(new Set(p.groupOrder).size===p.groupOrder.length&&p.layers.every(l=>p.groupOrder!.includes(l.group))),'groupOrder must contain every layer group exactly once').refine(p=>(p.slices||[]).every(s=>s.x+s.width<=p.width&&s.y+s.height<=p.height),'Slices must stay inside the canvas');
export type DesignLayer=z.infer<typeof layerSchema>;
export type Composition=z.infer<typeof compositionSchema>;
export const extractionSchema=z.object({kind:z.literal('extract'),name:z.string().min(1),source:z.string().min(1),output:z.string().min(1),hideIds:z.array(z.number().int().positive()).max(300).optional(),isolateLayerId:z.number().int().positive().optional(),trim:z.boolean().optional()}).strict().refine(p=>Boolean(p.hideIds)!==Boolean(p.isolateLayerId),'Choose hideIds OR isolateLayerId');
/** Canonical paths are checked in Node as well as the static Adobe dispatcher. */
export async function validateRenderPlan(planPath:string,workspace:string){
 const config=await loadConfig(workspace),runRoot=await realpath(resolve(workspace,config.outputRoot)),path=await realpath(planPath),parent=await realpath(dirname(path));
 if(!inside(runRoot,path)||extname(path)!=='.json'||!(await stat(path)).isFile()||(await stat(path)).size>1024*1024)throw Error('Invalid local design plan path');
 const raw=JSON.parse(await readFile(path,'utf8'));const plan=raw.kind==='compose'?compositionSchema.parse(raw):extractionSchema.parse(raw);
 const roots=(await Promise.all(config.allowedInputRoots.map(async r=>{try{return await realpath(resolve(workspace,r));}catch{return undefined;}}))).filter((r):r is string=>Boolean(r));
 const inputs=plan.kind==='compose'?plan.layers.filter(l=>l.type==='image').map(l=>(l as z.infer<typeof layerSchema>&{path:string}).path):[plan.source];
 for(const input of inputs){const p=await realpath(input);if(![...roots,runRoot].some(r=>inside(r,p))||!(await stat(p)).isFile()||!['.png','.jpg','.jpeg','.psd','.psb'].includes(extname(p).toLowerCase()))throw Error('Design asset outside allowed roots or invalid type');}
 const outputs=plan.kind==='compose'?[plan.psd,plan.png,...(plan.jpg?[plan.jpg]:[]),...(plan.slices||[]).flatMap(s=>[...(s.png?[s.png]:[]),...(s.jpg?[s.jpg]:[])])]:[plan.output];
 if(new Set(outputs.map(p=>resolve(p).toLowerCase())).size!==outputs.length)throw Error('Duplicate output path');
 for(const output of outputs){if(await realpath(dirname(output))!==parent||!['.psd','.png','.jpg'].includes(extname(output).toLowerCase()))throw Error('Output outside plan directory or invalid extension');try{await access(output);}catch(e:any){if(e.code==='ENOENT')continue;throw e;}throw Error('Output exists; no overwrite or replay');}
 return plan;
}
