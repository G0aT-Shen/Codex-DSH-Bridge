import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startBridge} from '../worker.js';
import {atomicJson, validateTask} from '../protocol.js';

const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(read, predicate) {
  for(let i=0;i<150;i++) {try {const value=await read(); if(predicate(value)) return value;} catch{} await pause(20);}
  throw new Error('Timed out');
}
function fakeCtx({hang=false}={}) {
  const agents=new Map(), warnings=[]; let created=0, cancelled=0;
  const ctx={logger:{warn:e=>warnings.push(e)},workspaceRegistry:{create:async()=>({id:'workspace-test'})},agents:{get:id=>agents.get(id)},sessions:{flush:async()=>{}},sessionController:{
    rename:async()=>{},
    create:async request=>{
      assert.equal(request.workspaceId,'workspace-test');
      created++; const id='session-'+created, events=[]; let finish;
      const agent={session:{seq:0,eventAt:i=>events[i]},cancel(){cancelled++; push('turn/end',{reason:{kind:'cancelled'}}); finish?.();},whenIdle:()=>agent.idle};
      const push=(type,data)=>{events.push({type,data,seq:events.length}); agent.session.seq=events.length;};
      agent.push=push;agent.idle=Promise.resolve();agent.begin=()=>{agent.idle=new Promise(resolve=>{finish=resolve;});};agent.finish=()=>finish();
      agents.set(id,agent);return {sessionId:id};
    },
    prompt:async({sessionId,content}, signal)=>{
      signal.throwIfAborted();
      assert.match(content[0].text,/验收标准/);const agent=agents.get(sessionId);agent.begin();agent.push('turn/start',{});agent.push('step/start',{});
      if(!hang){agent.push('tool/call',{name:'write_file',arguments:'{}'});agent.push('tool/result',{message:{content:[{type:'text',text:'written'}]}});agent.push('assistant/message',{message:{content:[{type:'text',text:'artifact complete'}]}});agent.push('turn/end',{reason:{kind:'completed'}});agent.finish();}
    }
  }};
  return {ctx,counts:()=>({created,cancelled}),warnings};
}
async function fixture(t, options) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-bridge-test-')); const f=fakeCtx(options);const stop=await startBridge(f.ctx,root,20);
  t.after(async()=>{await stop();await fs.rm(root,{recursive:true,force:true});});
  const task={id:'test-one',cwd:root,goal:'create artifact',plan:['create'],acceptance:['artifact exists']};
  const submit=()=>atomicJson(path.join(root,'inbox',task.id+'.json'),task);
  const status=()=>fs.readFile(path.join(root,'jobs',task.id,'status.json'),'utf8').then(JSON.parse);
  return {root,f,task,submit,status};
}
test('execution returns evidence separately from pending review and duplicate is not replayed',async t=>{
  const {root,f,submit,status}=await fixture(t);await submit();
  const job=await until(status,j=>j.state==='completed');assert.equal(job.review.state,'pending');assert.equal(job.sessionId,'session-1');
  assert.equal((await fs.readFile(path.join(root,'jobs/test-one/result.md'),'utf8')).trim(),'artifact complete');
  const log=await fs.readFile(path.join(root,'jobs/test-one/events.jsonl'),'utf8');assert.match(log,/tool\/result/);
  await submit();await until(()=>fs.readdir(path.join(root,'inbox')),files=>files.some(v=>v.endsWith('.duplicate')));assert.equal(f.counts().created,1);
});
test('cancel stops only the bridge-owned agent',async t=>{
  const {root,f,submit,status}=await fixture(t,{hang:true});await submit();await until(status,j=>!!j.sessionId);
  await fs.writeFile(path.join(root,'jobs/test-one/cancel'),'');const job=await until(status,j=>j.state==='cancelled');assert.equal(f.counts().cancelled,1);assert.equal(job.review.state,'pending');
});
test('deadline cancels a stuck execution',async t=>{
  const {f,task,submit,status}=await fixture(t,{hang:true});task.timeoutSeconds=1;await submit();await until(status,j=>j.state==='timeout');assert.equal(f.counts().cancelled,1);
});
test('stale running job is interrupted and never replayed',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-bridge-recovery-'));await fs.mkdir(path.join(root,'jobs/old'),{recursive:true});await atomicJson(path.join(root,'jobs/old/status.json'),{id:'old',state:'running'});
  const f=fakeCtx();const stop=await startBridge(f.ctx,root,20);t.after(async()=>{await stop();await fs.rm(root,{recursive:true,force:true});});
  const job=JSON.parse(await fs.readFile(path.join(root,'jobs/old/status.json'),'utf8'));assert.equal(job.state,'interrupted');assert.equal(f.counts().created,0);
  await assert.rejects(startBridge(f.ctx,root,20),/already running/);
});
test('invalid paths and empty plan never execute',async t=>{
  assert.throws(()=>validateTask({id:'../escape'}),/Invalid/);
  const {root,f,task}=await fixture(t);task.plan=[];await atomicJson(path.join(root,'inbox',task.id+'.json'),task);
  await until(()=>fs.readdir(path.join(root,'inbox')),files=>files.some(v=>v.endsWith('.invalid')));assert.equal(f.counts().created,0);
});
