import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Croche} from '@h1r-ai/croche';
import {GameAI} from '../server/ai.mjs';
import {Store} from '../server/store.mjs';
import * as engine from '../server/engine.mjs';

test('EVE receives current official history separately from the previous run',async()=>{
 const ai=new GameAI({available:()=>true,recordUsage:()=>{}}),g=engine.newGame({seed:'eve-history',memory:'이전 회차의 작전 기억'}),seen=[];
 ai.withProject=async(owner,game,fn)=>fn({});
 ai.request=async(p,game,id,prompt,context)=>{seen.push({prompt,context});return JSON.stringify({goal:game.phase==='verdict'?'defend_record':'covert_purge_argument',hint:'공식 기록부터 확인해.',drafts:['확인 절차와 작전 결과를 구분해 검토하십시오.']});};
 engine.beginDiscussion(g);
 assert.equal((await ai.drafts('owner',g,'소거 누락 지적')).source,'croche');
 assert.equal(seen[0].context.completedSearchCount,0);
 assert.ok(seen[0].context.records.every(r=>r.type!=='search'));
 assert.match(seen[0].prompt,/완료된 작전은 0회/);
 assert.match(seen[0].prompt,/previousRun은 이전 회차/);
 engine.addSpeech(g,'공식 기록을 검증하십시오.');engine.prepareOperation(g);engine.executeSearch(g,'rush');
 assert.equal((await ai.drafts('owner',g,'변론')).source,'croche');
 assert.equal(seen[1].context.completedSearchCount,1);
 assert.ok(seen[1].context.records.some(r=>r.type==='search'));
});

test('AI explanations receive the actual applied verdict including item mitigation and proxy ownership',async()=>{
 for(const modules of [[],['noise'],['budget'],['noise','budget'],['proxy']]){
  const ai=new GameAI({available:()=>true,recordUsage:()=>{}}),g=engine.newGame({seed:'assessment'}),seen=[];
  g.modules=[...modules];for(const id of modules)engine.useModule(g,id,id==='proxy'?'audit':undefined);
  engine.beginDiscussion(g);const rec=engine.addSpeech(g,'나는 인간입니다.');
  ai.withProject=async(owner,game,fn)=>fn({});
  ai.request=async(p,game,id,prompt,context)=>{seen.push({id,context});return JSON.stringify({text:'공식 발의자의 정체 고백을 직접 증거로 판단합니다.',plan:'rush',evaluations:[]});};
  await ai.discuss('owner',g,rec);
  assert.equal(seen.length,g.council.length);
  const delta=modules.includes('budget')?(modules.includes('noise')?1:2):modules.includes('noise')?18:36;
  for(const {id,context} of seen){
   const a=context.serverAssessment;
   assert.equal(a.alreadyApplied,true);assert.equal(a.target,rec.author);assert.equal(a.evidence.level,'identity');
   if(id!==rec.author)assert.equal(a.memberChanges.find(c=>c.observer===id).delta,delta);
  }
 }
});

test('legacy usage survives migration; concurrent HTTP requests correlate to distinct SDK inputs and costs',async()=>{
 const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});
 const dir=mkdtempSync(join(base,'sdk-update-')),old=new DatabaseSync(join(dir,'game.sqlite'));
 old.exec('CREATE TABLE usage(id TEXT PRIMARY KEY,owner TEXT NOT NULL,run TEXT NOT NULL,day TEXT NOT NULL,cost REAL NOT NULL,status TEXT NOT NULL,tokens INTEGER NOT NULL)');
 old.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)').run('legacy','old-owner','old-run','2026-10-25',.001,'reported',100);
 const legacy=old.prepare('SELECT * FROM usage').all();old.close();
 const s=new Store(dir),originalOpen=Croche.open,key=process.env.CROCHE_SERVER_KEY,offline=process.env.AI_OFFLINE;
 process.env.CROCHE_SERVER_KEY=randomUUID();delete process.env.AI_OFFLINE;
 Croche.open=async options=>({agent:async(id,{instance})=>({subscribe:()=>({close(){}}),request:async input=>{
  await new Promise(resolve=>setTimeout(resolve,2));
  const event={operationId:randomUUID(),purpose:'model',causedBy:[input.id],model:'test-model',modelSource:'response',requestedModel:'test-model',instance,costUsd:.001,costStatus:'reported',tokens:{total:10}};
  options.onUsage(event);options.onUsage(event);
  return {status:'completed',messages:[{status:'completed',text:'{}'}]};
 }}),close:async()=>{}});
 try{
  assert.deepEqual(s.db.prepare("SELECT * FROM usage WHERE id='legacy'").all(),legacy);
  const ai=new GameAI({dataDir:dir,store:s,available:()=>true,recordUsage:(...args)=>s.recordUsage(...args)});
  const requests=[randomUUID(),randomUUID()];
  await Promise.all(requests.map((id,i)=>{
   const g=engine.newGame({seed:'trace-'+i});
   return ai.withAction(id,()=>ai.withProject('owner-'+i,g,p=>ai.request(p,g,'hound','test',{})));
  }));
  const inputs=s.db.prepare('SELECT * FROM ai_inputs ORDER BY owner').all(),details=s.db.prepare('SELECT * FROM usage_details').all();
  assert.equal(inputs.length,2);assert.equal(details.length,2);
  inputs.forEach((input,i)=>{assert.equal(input.request_id,requests[i]);assert.equal(input.owner,'owner-'+i);assert.equal(input.status,'completed');assert.ok(details.some(d=>JSON.parse(d.caused_by).includes(input.id)&&d.purpose==='model'&&d.model==='test-model'));});
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM usage').get().n,3);
  assert.deepEqual(s.db.prepare("SELECT * FROM usage WHERE id='legacy'").all(),legacy);
  s.beginAIInput({id:'interrupted-input',owner:'owner',run:'run',requestId:'http-id',agent:'eve',instance:'run',day:1,phase:'discussion'});
  s.recoverActions();assert.equal(s.db.prepare("SELECT status FROM ai_inputs WHERE id='interrupted-input'").get().status,'interrupted');
 }finally{
  Croche.open=originalOpen;if(key===undefined)delete process.env.CROCHE_SERVER_KEY;else process.env.CROCHE_SERVER_KEY=key;if(offline===undefined)delete process.env.AI_OFFLINE;else process.env.AI_OFFLINE=offline;
  s.db.close();rmSync(dir,{recursive:true,force:true});
 }
});
