import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';import{compositionSchema}from'../src/design/plan.js';
import{layerSchema}from'../src/design/plan.js';
import{sliceSchema}from'../src/design/plan.js';
const parser=readFileSync(new URL('../src/legacy/design-com.jsxinc',import.meta.url),'utf8').split('function renderDesign')[0]!;

test('gradient mask input rejects degenerate geometry and injected operations',()=>{
 const image={type:'image',name:'photo',group:'assets',path:'C:/runs/photo.png',box:[0,0,750,384]};
 for(const gradientMask of [{from:[0,0],to:[0,0]},{from:[0,0],to:[Infinity,0]},{from:[0,0],to:[750,0],command:'eval'},{from:[0,0],to:[750,0],feather:1000}])assert.equal(layerSchema.safeParse({...image,gradientMask}).success,false);
 assert.equal(layerSchema.safeParse({...image,gradientMask:{from:[280,190],to:[570,190],feather:2}}).success,true);
 assert.equal(layerSchema.safeParse({...image,tint:'123456'}).success,false);
 assert.equal(layerSchema.safeParse({...image,subjectMask:true,gradientMask:{from:[0,0],to:[750,0]}}).success,false);
});
test('fresh design JSON parser treats hostile worksheet text as data and preserves Chinese',()=>{const input={title:'中文\n"; app.quit(); //',text:'${process.env.SECRET}',n:841,arr:[true,false,null]};const result=runInNewContext(parser+'\nparseDataJSON(payload)',{payload:JSON.stringify(input)});assert.deepEqual(JSON.parse(JSON.stringify(result)),input);});
test('fresh design JSON parser rejects executable input, prototype keys, duplicate keys and malformed numbers',()=>{for(const payload of ['({title:app.quit()})','{"__proto__":{}}','{"a":1,"a":2}','{"price":01}','{"price":NaN}'])assert.throws(()=>runInNewContext(parser+'\nparseDataJSON(payload)',{payload}));});
test('fresh composition schema rejects arbitrary commands and unbounded geometry',()=>{const base={kind:'compose',name:'test',width:1440,height:1440,psd:'C:/runs/test.psd',png:'C:/runs/test.png',sourceCells:[],layers:[{type:'text',name:'价格',group:'text',text:'841',font:'MiSans-Normal',size:72,x:0,y:100,color:'000000'}]};assert.equal(compositionSchema.parse(base).layers[0]!.type,'text');assert.throws(()=>compositionSchema.parse({...base,command:'eval'}));assert.throws(()=>compositionSchema.parse({...base,width:Infinity}));assert.throws(()=>compositionSchema.parse({...base,layers:[{type:'execute',code:'app.quit()'}]}));});


test('explicit group order cannot omit a layer group or duplicate it',()=>{
 const base={kind:'compose',name:'test',width:750,height:384,psd:'C:/runs/test.psd',png:'C:/runs/test.png',sourceCells:[],layers:[{type:'text',name:'title',group:'text',text:'title',font:'MiSans-Regular',size:40,x:40,y:100,color:'000000'}]};
 assert.equal(compositionSchema.safeParse({...base,groupOrder:['background','text']}).success,true);
 assert.equal(compositionSchema.safeParse({...base,groupOrder:['background']}).success,false);
 assert.equal(compositionSchema.safeParse({...base,groupOrder:['text','text']}).success,false);
});

test('slice export rejects traversal geometry, mismatched formats and commands',()=>{
 const valid={name:'row-1',x:0,y:0,width:1440,height:700,png:'C:/runs/row.png',jpg:'C:/runs/row.jpg'};
 assert.equal(sliceSchema.safeParse(valid).success,true);
 for(const extra of [{x:-1},{width:0},{png:'C:/runs/row.psd'},{jpg:'C:/runs/row.png'},{command:'eval'}])assert.equal(sliceSchema.safeParse({...valid,...extra}).success,false);
 const plan={kind:'compose',name:'test',width:1440,height:1440,psd:'C:/runs/test.psd',png:'C:/runs/test.png',sourceCells:[],layers:[{type:'text',name:'t',group:'text',text:'data',font:'MiSans-Regular',size:30,x:10,y:80,color:'000000'}]};
 assert.equal(compositionSchema.safeParse({...plan,slices:[{...valid,y:1000}]}).success,false);
});
