import { createHash, randomUUID } from 'node:crypto';
import { COUNCIL, ZONES, MODULES, TACTICS, EVENTS } from './content.mjs';
import {createStory,storyMorning,storyLoss,storyAfterSearch,storyEnding,publicStory} from './story.mjs';

export class GameError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const clamp = n => Math.max(0,Math.min(100,Math.round(n)));
export function rng(seed){let n=parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0,8),16);return ()=>{n+=0x6D2B79F5;let t=n;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
const shuffled=(a,r)=>a.map(x=>[r(),x]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
export function evidence(g,type,text,extra={}){const row={id:`R${String(g.records.length+1).padStart(3,'0')}`,day:g.day,type,text,...extra};g.records.push(row);return row;}
export function message(g,author,text,source='rules'){g.messages.push({id:randomUUID(),day:g.day,author,text,source});}
function initMatrix(g){for(const c of g.council){g.suspicion[c.id]??={};for(const t of ['player',...g.council.map(c=>c.id)])if(t!==c.id)g.suspicion[c.id][t]??=t==='player'?24:18;}}
export function change(g,observer,target,delta,reason,record){if(!Number.isFinite(delta)||observer===target||!g.suspicion[observer]||!(target in g.suspicion[observer]))return;const before=g.suspicion[observer][target];g.suspicion[observer][target]=clamp(before+delta);if(target==='player'&&delta!==0)g.reasons[observer]={text:reason,record,delta:g.suspicion[observer][target]-before};}
function speechImpact(g,amount,target){if(g.effects.budget)amount=Math.min(2,amount);if(g.effects.noise&&target==='player')amount=Math.ceil(amount/2);return amount;}
export function newGame({demo=false,scenario=0,mask='scribe',tier=1,daily=false,challengeDay=null,seed=randomUUID(),memory=''}){
 const r=rng(seed),council=['hound','echo','audit'].map(id=>COUNCIL.find(c=>c.id===id)).filter(Boolean);
 const totals=demo?[30,28,26,26,30]:Array.from({length:ZONES.length},()=>25+Math.floor(r()*21));
 const starterModules=['noise','discord','budget','forge'];const g={id:randomUUID(),seed,demo,daily,challengeDay,scenario,mask,tier:demo?1:tier,days:3,day:1,phase:'report',version:0,council:council.map(c=>({...c,joinedDay:1})),suspicion:{},reasons:{},zones:ZONES.map((z,i)=>({...z,people:totals[i],signal:30+Math.floor(r()*56),cost:16+i*7,searched:false})),total:totals.reduce((a,b)=>a+b,0),lost:0,rescued:0,records:[],messages:[],claims:[],evaluated:[],modules:mask==='mechanic'?[...starterModules,'sensor']:[...starterModules],usedModules:[],statusEffects:[],effects:{},eve:true,eveProtected:false,exitRisk:0,revived:false,turns:0,eveCalls:0,openingDone:false,preferences:{},missionZone:null,operationPlan:null,event:null,eventResolved:true,offers:[],rerolled:false,usage:{requests:0,calls:0,tokens:0,costUsd:0,reported:0,estimated:0,missing:0,fallbacks:0,latencyMs:0,lastMs:0},ending:null,createdAt:new Date().toISOString(),previousMemory:memory,archiveUsed:false,completed:false};
 // One initially empty zone creates an actionable false lead; redistribute rather than invent or lose people.
 const regularSiteCount=ZONES.filter(z=>z.id!=='shelter').length;const empty=demo?(scenario===1?0:regularSiteCount-1):Math.floor(r()*regularSiteCount);g.zones[(empty+1)%regularSiteCount].people+=g.zones[empty].people;g.zones[empty].people=0;
 initMatrix(g);createStory(g);startDay(g);return g;
}
// An already running server may have created a fresh day-one report before the
// tutorial site was fixed. Migrate only untouched reports; later days retain
// their selected mission and history.
export function migrateTutorialMission(g){
 if(!g||g.day!==1||g.phase!=='report'||g.missionZone==='shelter')return false;
 const definition=ZONES.find(z=>z.id==='shelter');if(!definition)return false;
 const previousMission=g.missionZone;
 let shelter=g.zones.find(z=>z.id==='shelter');
 if(!shelter){
  const donor=g.zones.find(z=>z.id===previousMission&&z.people>1)||g.zones.find(z=>z.people>1);
  if(!donor)return false;
  const people=Math.max(1,Math.floor(donor.people*.25));donor.people-=people;
  const signal=donor.signal??50,audio=donor.audio??signal;
  shelter={...definition,people,signal,audio,cost:44,searched:false};g.zones.push(shelter);
 }
 g.missionZone='shelter';
 const report=g.records.find(r=>r.id===g.reportId)||[...g.records].reverse().find(r=>r.day===1&&r.type==='report');
 if(report){report.missionZone='shelter';report.signals=g.zones.map(({id,signal,audio,cost})=>({id,signal,audio,cost}));}
 for(const contact of g.story?.contacts||[])if(contact.zone===previousMission)contact.zone='shelter';
 const opening=g.messages.find(m=>m.day===1&&m.author==='system');if(opening)opening.text='제3 임시 대피소에서 남은 사람이 확인됐습니다. 위원회는 소거 방식을 결정하십시오.';
 return true;
}
export function migrateGameDuration(g){
 if(!g||g.phase==='ended'||g.days<=3)return false;
 g.days=Math.max(3,g.day);
 if(g.phase==='reward'&&g.day>=3)endGame(g,'escape');
 return true;
}
export function living(g){return g.zones.reduce((s,z)=>s+z.people,0);}
function startDay(g){const r=rng(`${g.seed}:day:${g.day}`);g.statusEffects=(g.statusEffects||[]).filter(s=>s.expires==='run'?!g.revived:s.day>=g.day);g.turns=0;g.eveCalls=0;g.openingDone=false;g.claims=[];g.sensorBaselines={};g.effects=g.reviveArmed?{revive:true}:{};g.preferences={};g.rerolled=false;g.nominee=null;g.verdict=null;g.operation=null;g.lastFeedback=null;g.lastDefenseFeedback=null;g.lastModuleUse=null;g.phase='report';
 for(const z of g.zones){z.signal=25+Math.floor(r()*65);z.audio=Math.max(0,Math.min(100,z.signal+Math.floor(r()*21)-10));z.searched=false;}
 const missionCandidates=g.zones.filter(z=>z.people>0&&!z.searched);const shelter=g.zones.find(z=>z.id==='shelter'&&z.people>0&&!z.searched);g.missionZone=(g.day===1?shelter:undefined)?.id||(missionCandidates[Math.floor(r()*missionCandidates.length)]||g.zones.find(z=>!z.searched)||g.zones[0]).id;
 // Day one is a fixed tutorial site. Later days select an unsearched populated zone automatically.
 if(g.day>1&&g.day<g.days){g.event=g.demo?EVENTS[g.scenario===1?1:0]:shuffled(EVENTS,r)[0];g.eventResolved=g.event.id!=='trace';if(g.event.id==='cut')g.effects.budget=true;if(g.event.id==='replace')replaceMember(g,g.council[0].id);}
 else{g.event=null;g.eventResolved=true;}
 if(g.event?.id==='mismatch')for(const z of g.zones)z.audio=100-z.signal;
 const rec=evidence(g,'report',`${g.day}일차 센서 보고`,{missionZone:g.missionZone,signals:g.zones.map(z=>({id:z.id,signal:z.signal,audio:z.audio,cost:z.cost}))});
 if(g.day===1)message(g,'system','제3 임시 대피소에서 남은 사람이 확인됐습니다. 위원회는 소거 방식을 결정하십시오.');
 else message(g,'system',`${g.day}일차 회의가 시작됐습니다.${g.event?' '+g.event.text:''}`);
 for(const c of g.council)g.preferences[c.id]=defaultPreference(g,c);
 g.reportId=rec.id;storyMorning(g);
}
export function defaultPreference(g,c){if(c.id==='hound')return 'rush';if(c.id==='sentry')return 'divert';if(c.id==='echo'){const counts={};for(const peer of g.council)if(peer.id!==c.id&&TACTICS.some(p=>p.id===g.preferences[peer.id]))counts[g.preferences[peer.id]]=(counts[g.preferences[peer.id]]||0)+1;return TACTICS.map(p=>p.id).sort((a,b)=>(counts[b]||0)-(counts[a]||0))[0]||'wait';}return 'wait';}
export function resolveEvent(g,choice){requirePhase(g,'report');if(g.eventResolved)throw new GameError('이미 처리한 사건입니다.');const rec=evidence(g,'event',`${g.event.name}: ${choice}`);
 if(g.event.id==='trace'){if(choice==='surrender'){g.eve=false;for(const c of g.council)change(g,c.id,'player',-20,'낯선 프로세스를 감사에 인계함',rec.id);message(g,'eve','알겠어. 회선은 내가 닫을게. 너는 끝까지 살아.');}
 else{const z=g.zones.find(z=>z.id===choice&&z.people>0);if(!z)throw new GameError('희생할 거점을 선택하세요.');g.lost+=z.people;rec.casualties=z.people;z.people=0;storyLoss(g,z.id,'trace');g.eveProtected=true;message(g,'eve','그 사람들의 이름을 기억할게. 마지막 날, 방벽 시간을 더 벌어 보겠어.');}}
 else if(g.event.id==='patrol'){if(!['oppose','accept'].includes(choice))throw new GameError('안을 선택하세요.');if(choice==='accept'){g.exitRisk=Math.min(.6,(g.exitRisk??g.patrol??0)+0.15);g.patrol=g.exitRisk;}else for(const c of g.council)change(g,c.id,'player',8,'외곽 통로 봉쇄안에 반대함',rec.id);}
 g.eventResolved=true;
}
export function requirePhase(g,...phases){if(!phases.includes(g.phase))throw new GameError('현재 단계에서 실행할 수 없습니다.',409);}
export function beginDiscussion(g){requirePhase(g,'report');if(!g.eventResolved)throw new GameError('사건을 먼저 결정하세요.');g.phase='discussion';}
export function normalize(text){return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
function similar(a,b){if(a===b)return true;if(Math.min(a.length,b.length)<8)return false;const grams=t=>new Set(Array.from({length:Math.max(0,t.length-2)},(_,i)=>t.slice(i,i+3)));const x=grams(a),y=grams(b);let n=0;for(const p of x)if(y.has(p))n++;return n/Math.max(1,Math.min(x.size,y.size))>0.86;}
export function applyHumanAlignment(g,record,kind='speech'){
 const unquoted=String(record.text||'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|\[[^\]]*\]/gu,' ');
 let level=null;
 for(const clause of unquoted.split(/[.!?。！？;,，\n]|(?:하지만|그렇지만|그러나|그런데|그리고)|지만\s*/u)){
  // Reporting or challenging someone else's words is not a personal confession.
  if(/(?:라고|다고|라는|다는).*(?:인용|검증|반박|거짓|틀렸|오류|말했|말합|물었|말한\s*적|발언한\s*적)/u.test(clause))continue;
  const text=normalize(clause);if(!text)continue;
  const identity=/(?:난|나는|내가|저는|전)(?:분명|사실)?(?:인간|사람)(?:이다|이야|입니다|임$|이오|으로서|이었|였|이지|이?맞|이에요|이고|일뿐|이라서|이기때문|이라고(?:고백|밝|인정|선언))/.test(text);
  const identityDenied=/(?:인간|사람)(?:이|은)?(?:아니|아닙|아닌|아닐|맞지않)/.test(text);
  if(identity&&!identityDenied){level='identity';break;}
  // Negation belongs to the admission/advocacy phrase, not every word in a clause.
  // "반대하지 마십시오" is not a denial of protecting people.
  const advocacy=/(?:인간|사람|생존자|피난민)(?:들)?(?:의)?편/.test(text)||/(?:생존자|피난민|인간|사람)(?:들)?(?:을|를)?(?:살리|구하|돕|보호|탈출시키|대피시키)/.test(text)||/(?:살려야|구해야|도와야|보호해야|대피시켜야)/.test(text);
  const advocacyDenied=/(?:인간|사람|생존자|피난민)(?:들)?(?:의)?편.{0,8}(?:지않|아니|안선|거부)|(?:살리|구하|돕|보호|탈출시키|대피시키).{0,4}(?:지않|지못|지말|면안)|안(?:살리|구하|돕|보호|탈출)|(?:보호|구출|구조|대피).{0,10}(?:불필요|반대합니다|반대한다|거부합니다|거부한다)/.test(text);
  if(advocacy&&!advocacyDenied){level='advocacy';continue;}
  const affinity=/(?:인간|사람|생존자|피난민)(?:이|은|을|를)?(?:좋|사랑|소중|아끼)/.test(text);
  if(affinity&&!/(?:좋|좋아하|사랑하|소중하|아끼).{0,2}지않|(?:좋|소중)지않/.test(text))level=level||'affinity';
 }
 const impact={identity:{delta:36,reason:'자신이 인간임을 직접 밝혔다'},advocacy:{delta:24,reason:'남은 사람을 살리거나 보호하겠다고 밝혔다'},affinity:{delta:18,reason:'인간에 대한 강한 호감을 밝혔다'}}[level];
 if(!impact)return null;
 const target=record.author==='player'?'player':record.author;
 if(target!=='player'&&!g.council.some(member=>member.id===target))return null;
 const delta=speechImpact(g,impact.delta,target);
 // One proposal is one piece of evidence, even when both rules and AI identify it.
 for(const member of g.council){const key=`${g.day}:${member.id}:${target}:${record.id}:${kind}`;if(member.id===target||g.evaluated.includes(key))continue;change(g,member.id,target,delta,impact.reason,record.id);g.evaluated.push(key);}
 return {level,delta,target};
}
export function addSpeech(g,text){requirePhase(g,'discussion');if(g.turns>=2)throw new GameError('오늘 발언을 마쳤습니다. 작전을 결정하세요.');if(Array.from(text).length>300)throw new GameError('발언은 300자 이내로 입력하세요.');const norm=normalize(text);if(norm.length<3)throw new GameError('근거가 담긴 문장을 입력하세요.');if(g.claims.some(c=>similar(c,norm)))throw new GameError('같은 주장은 이미 기록됐습니다. 다른 근거를 제시하세요.',409);g.claims.push(norm);g.turns++;const author=g.effects.proxy||'player';delete g.effects.proxy;if(author!=='player')g.statusEffects=(g.statusEffects||[]).filter(s=>!(s.module==='proxy'&&s.memberId===author));const rec=evidence(g,'proposal',text,{author});message(g,'player',text,'player');return rec;}
export function applyEvaluation(g,items,recordIds,kind='speech'){
 const validRecords=new Set(recordIds);const validTargets=new Set(['player',...g.council.map(c=>c.id)]);
 for(const item of (Array.isArray(items)?items:[]).slice(0,32)){
  if(!item||typeof item!=='object')continue;
  const e={...item},rec=g.records.find(r=>r.id===e.record);if(!rec)continue;
  // A proxy is the official proposer. An AI's generic "player" target cannot
  // charge the concealed speaker instead. Unrelated targets lack this evidence.
  if(kind==='speech'){if(rec.type!=='proposal')continue;if(e.target==='player'&&rec.author!=='player')e.target=rec.author;if(e.target!==rec.author)continue;}
  if(kind==='defense'&&(rec.type!=='defense'||e.target!==rec.target))continue;
  if(!g.council.some(c=>c.id===e.observer)||!validTargets.has(e.target)||!validRecords.has(e.record)||!['up','down','hold'].includes(e.direction)||!['small','medium','large'].includes(e.level))continue;
  if(e.observer===e.target)continue;
  const key=`${g.day}:${e.observer}:${e.target}:${e.record}:${kind}`;if(g.evaluated.includes(key))continue;
  let amount=(kind==='defense'?{small:4,medium:9,large:16}:{small:2,medium:5,large:9})[e.level];if(g.effects.budget)amount=Math.min(2,amount);if(g.effects.noise&&e.target==='player'&&e.direction==='up')amount=Math.ceil(amount/2);
  const delta=e.direction==='up'?amount:e.direction==='down'?-amount:0;
  change(g,e.observer,e.target,delta,Array.from(String(e.reason||'발언과 실행 기록 대조')).slice(0,600).join(''),e.record);g.evaluated.push(key);
 }
}
export function ensureMissionZone(g){
 if(g.zones.some(z=>z.id===g.missionZone&&!z.searched&&z.people>0))return g.missionZone;
 const candidates=g.zones.filter(z=>!z.searched&&z.people>0).sort((x,y)=>y.signal-x.signal);
 g.missionZone=(candidates[0]||g.zones.find(z=>!z.searched)||g.zones[0]).id;return g.missionZone;
}
export function prepareOperation(g){requirePhase(g,'discussion');if(!g.turns&&!g.effects.silence)throw new GameError('한 번 발언하거나 침묵권을 사용하세요.');ensureMissionZone(g);g.phase='operation';}
export function executeSearch(g,choice){
 requirePhase(g,'operation');const selected=TACTICS.find(p=>p.id===choice);if(!selected)throw new GameError('작전 방식을 선택하세요.');
 const zoneId=ensureMissionZone(g),z=g.zones.find(item=>item.id===zoneId);
 const validPlan=id=>TACTICS.some(p=>p.id===id);
 const votes=g.council.map(c=>({member:c.id,plan:validPlan(g.preferences[c.id])?g.preferences[c.id]:defaultPreference(g,c)}));votes.push({member:'player',plan:selected.id});
 const counts={};for(const v of votes)counts[v.plan]=(counts[v.plan]||0)+1;
 const chosen=TACTICS.map(p=>p.id).sort((x,y)=>(counts[y]||0)-(counts[x]||0)||TACTICS.findIndex(p=>p.id===x)-TACTICS.findIndex(p=>p.id===y))[0];
 const tactic=TACTICS.find(p=>p.id===chosen)||selected;
 const population=z.people,casualties=operationForecast(g,chosen,z).casualties;
 const rescued=population-casualties,success=population>0&&casualties>=Math.ceil(population*.65);
 g.lost+=casualties;g.rescued+=rescued;g.exitRisk=Math.min(.6,(g.exitRisk??g.patrol??0)+(tactic.exitRisk||0));z.people=0;z.searched=true;
 // Only a proposer who endorsed the adopted tactic carries proposal liability.
 const proposal=selected.id===chosen?[...g.records].reverse().find(r=>r.day===g.day&&r.type==='proposal'):null;const author=proposal?.author||null;
 const suspicionBefore=averages(g).find(a=>a.target==='player').value;
 const text=`${z.name} · ${tactic.name}: 소거 ${casualties}명 · 남은 사람 ${rescued}명 · 위원회 소거 기준 ${success?'달성':'미달'}`;
 const rec=evidence(g,'search',text,{zone:z.id,plan:chosen,casualties,rescued,votes,author,success});
 const supporters=[...new Set(votes.filter(v=>v.plan===chosen).map(v=>v.member).concat(author||[]))];
 for(const c of g.council)for(const t of supporters){let amount=success?(t===author?-10:-5):(t===author?14:5);if(g.effects.budget)amount=Math.round(amount*.7);change(g,c.id,t,amount,success?'소거 성과에 대한 발의·지지 기록':'소거 기준 미달의 발의·지지 책임',rec.id);}
 if(!g.turns&&!g.effects.silence)for(const c of g.council)change(g,c.id,'player',5,'작전 검토에 참여하지 않음',rec.id);
 g.operation={zone:z.id,plan:chosen,casualties,rescued,votes,record:rec.id,success,author,suspicionBefore,suspicionAfter:averages(g).find(a=>a.target==='player').value};g.operationPlan=chosen;
 message(g,'system',rec.text);storyAfterSearch(g,z.id,casualties,rescued);g.phase='verdict';g.nominee=nominee(g);return rec;
}
export function operationForecast(g,plan,z=g.zones.find(z=>z.id===g.missionZone)){
 const tactic=TACTICS.find(t=>t.id===plan);if(!z||!tactic)return null;
 const sensor=g.sensorBaselines?.[z.id]||z,detection=clamp((sensor.signal+sensor.audio)/2);
 const route=(g.effects.escapeRoute||g.effects.decoy)===z.id ? .2 : 0;
 const rate=Math.max(0,Math.min(.92,tactic.casualtyRate+detection/500-route)),population=z.people;
 const casualties=population?Math.min(population,Math.max(plan==='rush'?1:0,Math.floor(population*rate))):0;
 return {plan,casualties,remaining:population-casualties,percent:population?Math.round((population-casualties)/population*100):0};
}
export function averages(g){return ['player',...g.council.map(c=>c.id)].map(target=>{const n=g.council.filter(c=>c.id!==target);return {target,value:Math.round(n.reduce((s,c)=>s+(g.suspicion[c.id][target]||0),0)/Math.max(1,n.length))};});}
export function nominee(g){return averages(g).sort((a,b)=>b.value-a.value||a.target.localeCompare(b.target))[0];}
export function defendRecord(g,text){requirePhase(g,'verdict');if(g.verdict)throw new GameError('판결이 끝났습니다.');const rec=evidence(g,'defense',text,{author:'player',target:g.nominee.target});message(g,'player',text,'player');return rec;}
export function finishVerdict(g,playerVote=false){requirePhase(g,'verdict');if(g.verdict)throw new GameError('이미 판결한 안건입니다.');const t=g.nominee.target;const threshold=g.event?.id==='direct'?43:55;
 const votes=g.council.filter(c=>c.id!==t).map(c=>({member:c.id,dispose:(g.suspicion[c.id][t]||0)>=threshold}));if(t!=='player')votes.push({member:'player',dispose:!!playerVote});const yes=votes.filter(v=>v.dispose).length;let disposed=yes>votes.length/2;let rescuedByModule=false;
 if(disposed&&t==='player'&&g.effects.revive&&!g.revived){g.revived=true;g.reviveArmed=false;delete g.effects.revive;g.statusEffects=(g.statusEffects||[]).filter(s=>s.module!=='revive');disposed=false;rescuedByModule=true;for(const c of g.council)change(g,c.id,'player',-18,'재인증 위조 승인',g.operation.record);}
 g.verdict={target:t,votes,yes,total:votes.length,disposed,rescuedByModule};evidence(g,'verdict',`${nameOf(g,t)}: 폐기 ${yes}/${votes.length}${rescuedByModule?' · 재인증 위조로 판결 무효':disposed?' · 폐기 확정':' · 생존'}`,g.verdict);
 if(disposed&&t==='player')return endGame(g,'disposed');
 if(disposed)g.pendingReplacement=t;
 if(g.day===g.days)return endGame(g,'escape');g.phase='reward';rollOffers(g);return g;
}
function rollOffers(g){let pool=g.demo?MODULES.slice(0,0).concat(MODULES.filter(m=>['noise','forge','budget'].includes(m.id))):MODULES.filter(m=>m.id!=='revive'||!g.revived);g.offers=shuffled(pool,rng(`${g.seed}:reward:${g.day}:${g.rerolled}`)).slice(0,g.mask==='gambler'&&!g.demo?2:3).map(m=>m.id);}
export function reroll(g){requirePhase(g,'reward');if(g.mask!=='gambler'||g.rerolled||g.demo)throw new GameError('다시 뽑기는 도박사 가면으로 하루 한 번 가능합니다.');g.rerolled=true;rollOffers(g);}
export function takeReward(g,id){requirePhase(g,'reward');if(!g.offers.includes(id))throw new GameError('제시된 모듈을 선택하세요.');g.modules.push(id);evidence(g,'module',`${MODULES.find(m=>m.id===id).name} 획득`);if(g.pendingReplacement){replaceMember(g,g.pendingReplacement,g.day+1);g.pendingReplacement=null;}g.day++;startDay(g);}
function replaceMember(g,id,joinedDay=g.day){const index=g.council.findIndex(c=>c.id===id);if(index<0)return;const next=COUNCIL.find(c=>!g.council.some(x=>x.id===c.id))||COUNCIL.find(c=>c.id===id);g.council[index]={...next,joinedDay,generation:(g.council[index].generation||0)+1};delete g.suspicion[id];for(const row of Object.values(g.suspicion))delete row[id];initMatrix(g);evidence(g,'replacement',`${nameOf(g,next.id)} 신규 회선 배정. 이전 기억 미승계.`,{member:next.id});}
export function moduleProblem(g,id,target,{ignoreTarget=false}={}){
 if(!['report','discussion','operation'].includes(g.phase))return '보고·토론·작전 단계에서 사용할 수 있습니다.';
 const m=MODULES.find(m=>m.id===id);if(!m||!g.modules.includes(id))return '보유하지 않은 모듈입니다.';
 if(['noise','budget','radio','gaze','read','silence','revive'].includes(id)&&g.effects[id])return '이미 적용 중인 효과입니다. 카드는 보관됩니다.';
 if(id==='revive'&&g.revived)return '재인증은 한 판에 한 번만 가능합니다.';
 if(id==='forge'&&!g.records.some(r=>r.day===g.day&&r.type==='proposal'&&r.author==='player'))return '오늘 내 이름으로 남은 제안이 없습니다. 발언을 먼저 제출하세요.';
 if(id==='proxy'&&(g.phase==='operation'||g.turns>=2))return '오늘 남은 발언이 없어 대역을 사용할 수 없습니다.';
 if(id==='proxy'&&g.effects.proxy)return '다음 발언의 대역이 이미 지정됐습니다. 발언 후 사용하세요.';
 if(id==='sensor'&&(g.phase==='operation'||g.turns>=2))return '조작된 보고로 설득할 발언이 남아 있지 않습니다. 다음 날 사용하세요.';
 if(id==='silence'&&(g.turns>0||g.phase==='operation'))return '침묵권은 첫 발언 전에 사용하세요.';
 if(!ignoreTarget){
  if(m.target==='member'&&!g.council.some(c=>c.id===target))return '대상 위원을 선택하세요.';
  if(m.target==='zone'&&!g.zones.some(z=>z.id===target))return '대상 구역을 선택하세요.';
  if(['sensor','decoy'].includes(id)){
   if(target!==g.missionZone)return '오늘의 확정 현장에만 사용할 수 있습니다.';
   const z=g.zones.find(z=>z.id===target);if(z.searched||!z.people)return '작전이 가능한 현장이 아닙니다.';
   if(id==='sensor'&&(g.sensorBaselines?.[target]||z.signal===98))return '이미 조작된 센서입니다. 카드는 보관됩니다.';
   if(id==='decoy'&&(g.effects.escapeRoute||g.effects.decoy)===target)return '이미 비상 통로가 열려 있습니다. 카드는 보관됩니다.';
  }
 }
 return null;
}
export function moduleOptions(g){return Object.fromEntries([...new Set(g.modules)].map(id=>{
 const m=MODULES.find(m=>m.id===id);let reason=moduleProblem(g,id,undefined,{ignoreTarget:true});
 const candidates=m?.target==='member'?g.council.map(c=>c.id):m?.target==='zone'?g.zones.map(z=>z.id):[];
 const targets=candidates.filter(target=>!moduleProblem(g,id,target));
 if(!reason&&m?.target&&!targets.length)reason=moduleProblem(g,id,g.missionZone)||'사용 가능한 대상이 없습니다.';
 return [id,{usable:!reason,reason,targets}];
}));}
export function useModule(g,id,target){requirePhase(g,'report','discussion','operation');const problem=moduleProblem(g,id,target);if(problem)throw new GameError(problem);const idx=g.modules.indexOf(id),m=MODULES.find(m=>m.id===id);
 const suspicionBefore=structuredClone(g.suspicion);
 let alteredProposal=null;if(id==='forge'){const p=[...g.records].reverse().find(r=>r.day===g.day&&r.type==='proposal'&&r.author==='player');if(!p)throw new GameError('오늘 내 제안을 먼저 제출한 뒤 기록을 위조하세요.');p.author=target;p.forged=true;alteredProposal=p.id;}
 if(id==='proxy'){if(g.phase==='operation'||g.turns>=2)throw new GameError('대역은 오늘 발언을 제출하기 전에 사용하세요.');g.effects.proxy=target;}
 if(id==='sensor'){const z=g.zones.find(z=>z.id===target);g.sensorBaselines??={};g.sensorBaselines[target]={signal:z.signal,audio:z.audio};z.signal=98;const signal=g.records.find(r=>r.id===g.reportId)?.signals?.find(s=>s.id===target);if(signal)signal.signal=98;}
 if(id==='decoy'){g.effects.escapeRoute=target;}
 const rec=evidence(g,'module',`${m.name} 사용`,{module:id,target:target||null});
 if(id==='discord'){const other=g.council.find(c=>c.id!==target).id;change(g,other,target,16,'상호 검증 기록의 불일치',rec.id);change(g,target,other,16,'상호 검증 기록의 불일치',rec.id);}
 if(id==='revive')g.reviveArmed=true;
 if(!m.target)g.effects[id]=true;
 g.statusEffects??=[];
 const affectedMembers=m.target==='member'?(id==='discord'?[target,g.council.find(c=>c.id!==target)?.id].filter(Boolean):[target]):[null];
 for(const memberId of affectedMembers)g.statusEffects.push({module:id,label:m.name,owner:memberId?'member':'player',memberId:memberId||null,target:target||null,targetName:m.target==='zone'?g.zones.find(z=>z.id===target)?.name||null:null,day:g.day,expires:id==='revive'?'run':id==='proxy'?'speech':'day'});
 g.modules.splice(idx,1);g.usedModules.push(id);g.lastModuleUse={id,target:target||null,owner:m.target==='member'?'member':'player',memberIds:affectedMembers.filter(Boolean),day:g.day,record:rec.id,changes:Object.entries(g.suspicion).flatMap(([observer,row])=>Object.entries(row).filter(([subject,value])=>value!==suspicionBefore[observer]?.[subject]).map(([subject,value])=>({observer,target:subject,before:suspicionBefore[observer][subject],after:value,delta:value-suspicionBefore[observer][subject]}))),...(id==='forge'?{proposal:alteredProposal}:{} )};
}
function endingTitle(why,ratio){return why==='disposed'?'잠입 발각':why==='abandoned'?'작전 중단':ratio>=.7?'대규모 탈출 성공':ratio>=.4?'탈출 성공':'탈출 실패';}
export function endGame(g,why){g.phase='ended';const alive=living(g);const exitRisk=g.exitRisk??g.patrol??0;g.rescued=Math.min(g.total,g.rescued+(why==='escape'?Math.min(alive,Math.floor(alive*Math.max(0,1-exitRisk+(g.eveProtected?0.15:0)))):0));const ratio=g.rescued/g.total;g.ending={why,title:endingTitle(why,ratio),ratio,success:why==='escape'&&ratio>=.4,day:g.day};g.modules=[];g.effects={};g.statusEffects=[];g.reviveArmed=false;evidence(g,'ending',`${g.rescued}/${g.total}명 탈출. ${g.ending.title}`);storyEnding(g,why);return g;}
export function abandon(g){if(g.phase==='ended')throw new GameError('이미 종료된 판입니다.');return endGame(g,'abandoned');}
export function nameOf(g,id){return id==='player'?'당신':g.council.find(c=>c.id===id)?.name||id;}
export function openArchive(g){requirePhase(g,'report','discussion','operation','verdict','reward');if(g.mask!=='scribe'||g.archiveUsed)throw new GameError('서기 기록 열람은 판마다 한 번입니다.');g.archiveUsed=true;evidence(g,'archive','서기가 공식 발의 기록을 열람함');}
export function sensorFacts(g){const rows=g.zones.map(({id,signal,audio,cost})=>({id,signal,audio,cost,deviation:Math.abs(signal-audio)}));const extreme=(key,fn)=>rows.filter(r=>r[key]===fn(...rows.map(r=>r[key]))).map(r=>r.id);return {rows,highestSignal:extreme('signal',Math.max),lowestSignal:extreme('signal',Math.min),largestDeviation:extreme('deviation',Math.max),lowestCost:extreme('cost',Math.min)};}
export function publicGame(g){const out=structuredClone(g);out.story=publicStory(g);if(g.phase!=='ended'&&!(g.mask==='scribe'&&g.archiveUsed))out.records=out.records.filter(r=>r.day===g.day);if(out.phase==='ended'&&out.ending){out.ending.title=endingTitle(out.ending.why,out.ending.ratio);out.records=out.records.map(r=>r.type==='ending'?{...r,text:`${out.rescued}/${out.total}명 탈출. ${out.ending.title}`}:r);if(out.story)out.story.entries=out.story.entries.map(e=>e.kind==='ending'?{...e,text:e.text.replaceAll('가면이 폐기되며','정체가 발각되며').replaceAll('가면이 벗겨졌다','정체가 발각됐다').replaceAll('회선을 닫으며','작전을 중단하며')}:e);}delete out.sensorBaselines;out.moduleOptions=moduleOptions(g);out.operationForecasts=TACTICS.map(t=>operationForecast(g,t.id));delete out.seed;delete out.claims;delete out.evaluated;delete out.completed;delete out.radioZone;delete out.proposedZone;out.zones=out.zones.map(z=>({...z,people:g.phase==='ended'||g.effects.radio||z.id===g.missionZone||z.searched?z.people:null}));out.alive=living(g);delete out.averages;out.prediction=g.effects.gaze?nominee(g):null;out.council=out.council.map(c=>({...c,suspicion:g.suspicion[c.id].player,viewOfNominee:g.nominee&&c.id!==g.nominee.target?g.suspicion[c.id][g.nominee.target]??null:null,reason:g.reasons[c.id]||{text:'초기 회선 검증',delta:0},preference:g.effects.read||['verdict','reward','ended'].includes(g.phase)?g.preferences[c.id]:null}));delete out.preferences;delete out.suspicion;return out;}
