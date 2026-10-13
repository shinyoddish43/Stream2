import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer,ROOT} from './helpers.mjs';
import {validGardenMessage,createGardenEmbed,GARDEN_ORIGIN,PROTOCOL} from '../public/garden-embed.js';
test('only exact Garden mode can frame the full owner-gated studio',async()=>{
 const server=await startServer({GARDEN_ORIGIN,AUTH_HEADER:'X-Authentik-Username',AUTH_USERS:'owner'},{password:false});
 try {
  for(const [path,frame] of [['/','none'],['/?garden=1',GARDEN_ORIGIN],['/?garden=evil','none'],['/login?garden=1','none']]){
   const r=await fetch(server.url+path,{headers:{'X-Authentik-Username':'owner'},redirect:'manual'});
   assert.match(r.headers.get('content-security-policy'),new RegExp('frame-ancestors '+(frame==='none'?"'none'":frame)));
   assert.match(r.headers.get('permissions-policy'),/camera=\(self/);
  }
  assert.equal((await fetch(server.url+'/?garden=1',{redirect:'manual'})).status,303);
  assert.equal((await fetch(server.url+'/api/state',{headers:{'X-Authentik-Username':'guest'}})).status,401);
  assert.equal((await fetch(server.url+'/api/state',{headers:{'X-Authentik-Username':'owner'}})).status,200);
 } finally {server.stop();}
 for(const value of ['https://evil.test','https://mognet.six7.pw/path','https://mognet.six7.pw/','*']){
  const r=spawnSync('node',[join(ROOT,'server.js')],{env:{...process.env,GARDEN_ORIGIN:value,DATA_DIR:mkdtempSync(join(tmpdir(),'garden-origin-'))},encoding:'utf8',timeout:10000});
  assert.notEqual(r.status,0);assert.match(r.stderr,/GARDEN_ORIGIN/);
 }
});
test('handshake binds one parent, exact origin, shape and random session; never starts a stream',()=>{
 const parent={},session='1234567890abcdef',event={origin:GARDEN_ORIGIN,source:parent,data:{type:PROTOCOL,kind:'hello',session}};
 assert.equal(validGardenMessage(event,parent,GARDEN_ORIGIN,''),true);
 for(const changed of [{origin:'https://evil.test'},{source:{}},{data:{...event.data,kind:'start'}},{data:{...event.data,session:'wrong-session-value'}},{data:{...event.data,extra:true}}])assert.equal(validGardenMessage({...event,...changed},parent,GARDEN_ORIGIN,session),false);
 let listener,interval,statusCalls=0,visible;const sent=[];
 const win={parent:{postMessage:(m,o)=>sent.push([m,o])},location:{search:'?garden=1'},addEventListener:(t,fn)=>listener=fn,removeEventListener:()=>{},setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{}};
 createGardenEmbed({origin:GARDEN_ORIGIN,win,onVisibility:v=>visible=v,getStatus:()=>{statusCalls++;return {broadcast:true,capture:true,audio:true,state:'live',seconds:10,kbps:500,streamKey:'secret'};}});
 listener({...event,source:win.parent});interval();assert.equal(statusCalls,2);listener({...event,source:win.parent,data:{...event.data,kind:'visibility',visible:false}});assert.equal(visible,false);assert.doesNotMatch(JSON.stringify(sent),/streamKey|secret/);
 const n=sent.length;listener({...event,source:win.parent,data:{...event.data,kind:'start'}});assert.equal(sent.length,n);
});
