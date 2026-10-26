import test from 'node:test';import assert from 'node:assert/strict';
import{spawnSync}from'node:child_process';import{mkdtemp,mkdir,writeFile,readFile,access}from'node:fs/promises';
import{resolve}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath,pathToFileURL}from'node:url';
const workspace=fileURLToPath(new URL('../',import.meta.url));
function run(script:string,args:string[]){return spawnSync(process.execPath,['--import','tsx',resolve(workspace,'scripts',script),...args],{cwd:workspace,encoding:'utf8',windowsHide:true,timeout:10000});}
test('portable COM CLI help and unknown-operation rejection do not call Photoshop',()=>{
 const help=run('com.ts',['--help']);assert.equal(help.status,0);assert.match(help.stdout,/render_design/);
 const bad=run('com.ts',['arbitrary-script']);assert.equal(bad.status,1);assert.match(bad.stderr,/Unknown static COM operation/);
});
test('an existing lock blocks COM before dispatch and remains unchanged',{skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'skill-lock-'));await mkdir(resolve(dir,'.studio'));const lock=resolve(dir,'.studio','skill-com.lock');await writeFile(lock,'prior-uncertain');
 const result=run('com.ts',['ping','--workspace',dir]);assert.equal(result.status,1);assert.match(result.stderr,/EEXIST/);assert.equal(await readFile(lock,'utf8'),'prior-uncertain');await assert.rejects(access(resolve(dir,'.studio','com-commands')));
});
test('plan CLI validates new output paths without Photoshop or generating artifacts',async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'skill-plan-')),page=resolve(dir,'runs','page');await mkdir(page,{recursive:true});await mkdir(resolve(dir,'assets-in'));
 await writeFile(resolve(dir,'studio.config.json'),JSON.stringify({port:57123,allowedInputRoots:['assets-in'],workbookRoots:['inputs'],outputRoot:'runs',commandTimeoutMs:90000}));
 const p={kind:'compose',name:'offline',width:100,height:100,psd:resolve(page,'out.psd'),png:resolve(page,'out.png'),sourceCells:[],layers:[{type:'rect',name:'bg',group:'bg',x:0,y:0,width:100,height:100,color:'FFFFFF'}]},file=resolve(page,'plan.json');await writeFile(file,JSON.stringify(p));
 const loader=pathToFileURL(resolve(workspace,'node_modules','tsx','dist','loader.mjs')).href;
 const result=spawnSync(process.execPath,['--import',loader,resolve(workspace,'scripts','validate-plan.ts'),file],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).photoshopCalled,false);await assert.rejects(access(p.psd));await assert.rejects(access(resolve(dir,'.studio')));
 await writeFile(p.psd,'existing');const again=spawnSync(process.execPath,['--import',loader,resolve(workspace,'scripts','validate-plan.ts'),file],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(again.status,1);assert.match(again.stderr,/no overwrite or replay/);
});
