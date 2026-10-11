const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../../flutter/web/pmtiles_protocol.js'),'utf8');
function bridge(fetch){
 let handler;const archives=[];
 class Protocol{add(a){archives.push(a)}tile(r){return Promise.resolve(r.url)}}
 const scope={fetch,Map,Promise,Error,pmtiles:{Protocol,PMTiles:class{constructor(source){this.source=source}}},maplibregl:{addProtocol(name,fn){handler=fn}}};
 scope.window=scope;scope.globalThis=scope;vm.runInNewContext(code,scope);
 assert.equal(scope.registerProtomapsProtocol(),true);
 return {archives,tile:()=>handler({url:'pmtiles://http://localhost/taiwan.pmtiles/13/6862/3506'},new AbortController())};
}
test('range server never downloads or retains the entire archive',async()=>{
 let requests=0,canceled=0;
 const b=bridge(async(url,options)=>{requests++;assert.equal(options.headers.Range,'bytes=0-16383');return {status:206,headers:{get:()=> 'bytes 0-16383/300000000'},body:{cancel:async()=>canceled++},arrayBuffer(){throw Error('Must not buffer archive')}}});
 await Promise.all([b.tile(),b.tile()]);await b.tile();
 assert.equal(requests,1);assert.equal(canceled,1);assert.equal(b.archives.length,0);
});
test('Flutter server returning 200 buffers once and serves byte ranges',async()=>{
 let requests=0;
 const b=bridge(async()=>{requests++;return {status:200,ok:true,headers:{get:()=>null},arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer}});
 await Promise.all([b.tile(),b.tile()]);
 assert.equal(requests,1);assert.equal(b.archives.length,1);
 const bytes=await b.archives[0].source.getBytes(1,2);
 assert.deepEqual([...new Uint8Array(bytes.data)],[2,3]);
});
test('failed archive request can be retried',async()=>{
 let requests=0;
 const b=bridge(async()=>{requests++;return {status:requests===1?503:206,ok:requests!==1,headers:{get:()=>requests===1?null:'bytes 0-16383/300000000'}}});
 await assert.rejects(b.tile(),/503/);await b.tile();assert.equal(requests,2);
});
