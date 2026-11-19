import {Croche,FileStorage,defineTool} from '@h1r-ai/croche';
import {randomUUID} from 'node:crypto';
const calls=[];const usage=[];
const records=defineTool({manifestVersion:1,name:'records',summary:'심의 기록 조회',commands:[{name:'lookup',key:'records.lookup',summary:'번호로 실제 기록 조회',reads:true,flags:[{name:'id',type:'string',required:true}]}]},inv=>{calls.push(inv.key);return {id:'R001',text:'첫날 소집. 비정상 회선 1건.'};});
const app=await Croche.open({projectKey:process.env.CROCHE_PROJECT_KEY,serverKey:process.env.CROCHE_SERVER_KEY,user:'thelastvote-connection-check',language:'ko',storage:new FileStorage(process.env.CROCHE_SMOKE_DIR||'data/croche-smoke'),tools:[records],
 bundledConfig:{schema:7,project:{defaults:{model:process.env.CROCHE_MODEL||'deepseek/deepseek-v4.1-flash',reasoning:'off',maxOutputTokens:300,maxIterations:3},languages:{default:'ko',supported:['ko']}},agents:{check:{instructions:'한국어로 답하세요. 연결 검사를 요청받으면 반드시 records 도구의 lookup 명령으로 R001을 조회한 뒤 그 기록의 문장을 짧게 답하세요.'}}}});
try{const agent=await app.agent('check',{tools:['records']});let ended=0,resolved=false,lateTurns=0;
 const subscription=agent.subscribe({initialMessages:0,onEvent:e=>{if(e.type==='message.end')ended++;if(e.type==='turn'){usage.push({model:e.model,cost:e.cost,costStatus:e.costStatus,usage:e.usage,purpose:e.purpose});if(resolved)lateTurns++;}}});
 const result=await agent.request({id:randomUUID(),input:[{type:'text',kind:'app_state',text:JSON.stringify({check:'R001'})},{type:'text',text:'R001 기록을 조회해서 연결 검사를 완료하세요.'}]},{wait:'idle',signal:AbortSignal.timeout(45000)});
 resolved=true;await new Promise(r=>setTimeout(r,1500));subscription.close();
 console.log(JSON.stringify({status:result.status,messages:result.messages.map(m=>({text:m.text,status:m.status,replyToRequest:!!m.inReplyTo?.includes(result.id),error:m.error?.code})),toolCalls:calls,usage,lateTurns,streamMessages:ended}));
 if(result.status!=='answered'||!calls.length||!result.messages.some(m=>m.text))process.exitCode=1;}finally{await app.close();}
