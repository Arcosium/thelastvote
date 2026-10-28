import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {newGame} from '../server/engine.mjs';

test('시연 종료: 링크·API·기존 쿠키·비밀번호 로그인을 차단하고 일반 저장은 보존',{timeout:30000},async()=>{
 const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'retired-'));
 const store=new Store(dir),password=randomBytes(20).toString('hex'),normal=await store.createUser('normal',password),demo=await store.createUser('demo',password,'demo');
 const normalCookie='thelastvote_session='+store.session(normal),demoToken=store.session(demo),demoCookie='thelastvote_demo_session='+demoToken;
 const original=newGame({seed:'normal-save'});store.save(normal.id,original);store.db.close();
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATA_DIR:dir,AI_OFFLINE:'1',ENABLE_HACKATHON_DEMO:'0',LEGACY_SESSION_COOKIE:'previous_session',LEGACY_DEMO_COOKIE:'previous_demo_session'},stdio:'pipe'});let ready='';child.stdout.on('data',s=>ready+=s);child.stderr.on('data',()=>{});
 const request=async(path,body,cookie='')=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});return {status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};};
 try{
  for(let i=0;i<100&&!ready.includes('listening');i++)await new Promise(r=>setTimeout(r,50));assert.match(ready,/listening/);
  assert.equal((await request('/api/catalog')).data.demoEnabled,false);
  for(const path of ['/demo','/demo/entry.js','/api/demo','/api/demo/login'])assert.equal((await request(path,path.startsWith('/api/')?{}:undefined)).status,410,path);
  assert.equal((await request('/api/me',undefined,demoCookie)).data.user,null);
  assert.equal((await request('/api/game',undefined,'thelastvote_session='+demoToken)).status,401);
  assert.equal((await request('/api/login',{username:'demo',password})).status,410);
  const combined=normalCookie+'; '+demoCookie;
  assert.equal((await request('/api/me',undefined,combined)).data.user.username,'normal');
  assert.equal((await request('/api/game',undefined,combined)).data.game.id,original.id);
  // A renamed cookie must preserve the account/save without reviving demo access.
  const previousCookie=normalCookie.replace('thelastvote_session=','previous_session=');
  const migrated=await request('/api/game',undefined,previousCookie+'; previous_demo_session='+demoToken);
  assert.equal(migrated.status,200);assert.equal(migrated.data.game.id,original.id);
  const migratedHeaders=migrated.headers.getSetCookie();
  assert.ok(migratedHeaders.some(value=>value.startsWith(normalCookie+';')&&value.includes('HttpOnly')&&value.includes('SameSite=Strict')));
  assert.ok(migratedHeaders.some(value=>value.startsWith('previous_session=;')));
  assert.ok(migratedHeaders.some(value=>value.startsWith('previous_demo_session=;')));
  assert.ok(!migratedHeaders.some(value=>value.startsWith('thelastvote_demo_session=')));
  const invalid=await request('/api/me',undefined,'previous_session=invalid');
  assert.equal(invalid.data.user,null);assert.ok(!invalid.headers.getSetCookie().some(value=>value.startsWith('thelastvote_session=')));
  assert.equal((await request('/api/me',undefined,'previous_session='+demoToken)).data.user,null);
  assert.equal((await request('/api/me',undefined,'previous_demo_session='+demoToken)).data.user,null);
  const second=await request('/api/register',{username:'second_player',password});
  const secondCookie=second.headers.getSetCookie().find(value=>value.startsWith('thelastvote_session=')).split(';')[0];
  assert.equal((await request('/api/me',undefined,secondCookie+'; '+previousCookie)).data.user.username,'second_player');
  const signedOut=await request('/api/logout',{},secondCookie);assert.equal(signedOut.status,200);
  assert.equal((await request('/api/me',undefined,secondCookie.replace('thelastvote_session=','previous_session='))).data.user,null);
  const act=(body)=>request('/api/game/action',{runId:original.id,requestId:randomUUID(),...body},normalCookie);
  const first={action:'module',module:'noise',version:original.version};
  const parallel=await Promise.all([act(first),act(first)]);assert.deepEqual(parallel.map(r=>r.status).sort(),[200,409]);
  const after=(await request('/api/game',undefined,normalCookie)).data.game;assert.equal(after.version,1);assert.equal(after.usedModules.filter(id=>id==='noise').length,1);
  const before=JSON.stringify(after);assert.equal((await act({action:'module',module:'forge',target:'hound',version:after.version})).status,400);assert.equal(JSON.stringify((await request('/api/game',undefined,normalCookie)).data.game),before);
  assert.equal((await request('/api/login',{username:'normal',password})).status,200);
  assert.equal((await request('/api/logout',{},combined)).status,200);
  assert.equal((await request('/api/me',undefined,normalCookie)).data.user,null);
  assert.equal((await request('/api/me',undefined,previousCookie)).data.user,null);
 }finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}rmSync(dir,{recursive:true,force:true});}
});
