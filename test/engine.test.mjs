import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Engine} from '../dist/engine.js';
import {defaultConfig} from '../dist/config.js';
import {UpstreamError} from '../dist/provider.js';

process.env.BRIDGE_TEST_API_KEY='synthetic-test-key-only';
const completed=(text='ANSWER',tokens=2)=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:5,output_tokens:tokens}});
const call=(name,args={},call_id='call1')=>({type:'function_call',name,arguments:JSON.stringify(args),call_id});
function config(dir=mkdtempSync(join(tmpdir(),'bridge-unit-'))){const c=structuredClone(defaultConfig);c.dataDir=dir;c.profiles.deepseek.apiKeyEnv='BRIDGE_TEST_API_KEY';return c;}
const task=(key,extra={})=>({project_id:'p',role:'reviewer',objective:'Review synthetic evidence.',idempotency_key:key,...extra});
async function setup(t,provider,c=config()){const e=new Engine(c,provider);t.after(()=>e.close());return e;}

test('two same-model agents get distinct identities; global concurrency spans engines',async t=>{
  let active=0,peak=0,calls=0;
  const provider={async complete(){active++;peak=Math.max(peak,active);calls++;await sleep(120);active--;return completed();}};
  const c=config();const a=await setup(t,provider,c),b=await setup(t,provider,c);
  const tasks=Array.from({length:5},(_,i)=>a.submit(task('job'+i)));
  assert.equal(new Set(tasks.map(t=>t.id)).size,5);a.start();b.start();
  await Promise.all(tasks.map(t=>a.wait('p',t.id,10)));
  assert.equal(peak,2);assert.equal(calls,5);
  for(const row of tasks)assert.equal(a.store.task('p',row.id).state,'completed');
});
test('idempotency survives server instances and rejects conflicting inputs',async t=>{
  const c=config();const a=await setup(t,{complete:async()=>completed()},c),b=await setup(t,{complete:async()=>completed()},c);
  const first=a.submit(task('same'));assert.equal(b.submit(task('same')).id,first.id);
  assert.throws(()=>a.submit(task('same',{role:'changed'})),{code:'IDEMPOTENCY_CONFLICT'});
  assert.notEqual(a.submit(task('same',{project_id:'other'})).id,first.id);
});
test('context snapshots, project isolation, optimistic revisions and reviewed memory',async t=>{
  const e=await setup(t,{complete:async()=>completed()});
  e.setContext({project_id:'p',expected_revision:0,context:{summary:'v1'}});
  assert.throws(()=>e.setContext({project_id:'p',expected_revision:0,context:{summary:'stale'}}),{code:'REVISION_CONFLICT'});
  const memory=e.proposeMemory({project_id:'p',content:'Claim',source:'source-A'});
  assert.equal(e.submit(task('before')).snapshot.memories.length,0);
  e.store.reviewMemory('p',memory.id,1,'confirmed');
  const submitted=e.submit(task('after'));assert.equal(submitted.snapshot.memories.length,1);
  e.setContext({project_id:'p',expected_revision:1,context:{summary:'v2'}});
  assert.equal(e.store.task('p',submitted.id).snapshot.context.summary,'v1');
  assert.throws(()=>e.store.task('other',submitted.id),{code:'NOT_FOUND'});
  assert.throws(()=>e.store.reviewMemory('other',memory.id,2,'confirmed'),{code:'NOT_FOUND'});
  assert.throws(()=>e.store.reviewMemory('p',memory.id,1,'rejected'),{code:'REVISION_CONFLICT'});
  assert.equal(e.store.context('other').revision,0);
});
test('worker tools use only task snapshot and cannot confirm memory or read files',async t=>{
  let request=0,history;
  const e=await setup(t,{async complete(_p,h){history=h;request++;return request===1?{...completed(),output:[call('read_material',{id:'source'}),call('propose_memory',{content:'Candidate',source:'source'},'call2'),call('review_memory',{},'call3'),call('read_material',{path:'C:/secret'},'call4')]}:completed('Reviewed');}});
  e.setContext({project_id:'p',expected_revision:0,context:{summary:'hello',materials:[{id:'source',title:'Evidence',source:'user',content:'SYNTHETIC_MATERIAL'}]}});
  const row=e.submit(task('tools'));e.start();const done=await e.wait('p',row.id,5);
  assert.equal(done.state,'completed');assert.equal(done.requests,2);
  const outputs=history.filter(x=>x.type==='function_call_output').map(x=>JSON.parse(x.output));
  assert.equal(outputs[0].content,'SYNTHETIC_MATERIAL');assert.equal(outputs[1].status,'proposed');
  assert.equal(outputs[2].error,'UNKNOWN_TOOL');assert.equal(outputs[3].error,'INVALID_TOOL_ARGUMENTS');
  assert.equal(e.store.memories('p','confirmed').length,0);
});
test('queued cancellation never calls provider; running cancellation propagates between engines',async t=>{
  let calls=0,aborted=false;
  const c=config();const provider={async complete(_p,_h,_t,_n,signal){calls++;try{await sleep(10000,undefined,{signal});}catch(error){aborted=true;throw error;}return completed();}};
  const a=await setup(t,provider,c),b=await setup(t,provider,c);
  const queued=a.submit(task('queued'));a.cancel('p',queued.id);a.start();
  const running=a.submit(task('running'));await sleep(400);b.cancel('p',running.id);await sleep(400);
  assert.equal(calls,1);assert.equal(aborted,true);assert.equal(a.store.task('p',running.id).state,'cancelled');
});
test('timeout is terminal and stops the request',async t=>{
  const e=await setup(t,{async complete(_p,_h,_t,_n,signal){await sleep(20000,undefined,{signal});return completed();}});
  const row=e.submit(task('timeout',{timeout_seconds:5}));e.start();const done=await e.wait('p',row.id,8);
  assert.equal(done.state,'timed_out');assert.equal(done.usage_complete,false);
});
test('bounded retries only for 429/503; ambiguous network errors are not retried',async t=>{
  let attempts=0;const e=await setup(t,{async complete(){if(++attempts<3)throw new UpstreamError(429,1);return completed();}});
  const row=e.submit(task('retry'));e.start();assert.equal((await e.wait('p',row.id,5)).state,'completed');assert.equal(attempts,3);
  let failures=0;const f=await setup(t,{async complete(){failures++;throw new Error('DO_NOT_LOG_RAW_PROVIDER_SECRET');}});
  const failed=f.submit(task('network'));f.start();const result=await f.wait('p',failed.id,5);
  assert.equal(failures,1);assert.equal(result.state,'failed');assert.equal(result.usage_complete,false);assert.ok(!JSON.stringify(result).includes('DO_NOT_LOG'));
});
test('request budget and truncated provider outputs cannot be mistaken for success',async t=>{
  const e=await setup(t,{async complete(){return {...completed(),output:[call('read_context')]};}});
  const row=e.submit(task('loop',{max_requests:2}));e.start();const done=await e.wait('p',row.id,5);
  assert.equal(done.state,'budget_exceeded');assert.equal(done.requests,2);
  const f=await setup(t,{async complete(){return {...completed('partial'),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}};}});
  const truncated=f.submit(task('truncated'));f.start();const partial=await f.wait('p',truncated.id,5);
  assert.equal(partial.state,'budget_exceeded');assert.equal(partial.result,undefined);assert.equal(partial.partial_result,'partial');
});
test('output budget constrains requests; missing usage stops tool continuation',async t=>{
  const limits=[];const e=await setup(t,{async complete(_p,_h,_t,n){limits.push(n);return {...completed('',128),output:[call('read_context')]};}});
  const row=e.submit(task('budget',{output_token_budget:128}));e.start();const done=await e.wait('p',row.id,5);
  assert.equal(done.state,'budget_exceeded');assert.deepEqual(limits,[128]);
  const f=await setup(t,{async complete(){return {status:'completed',output:[call('read_context')]};}});
  const unknown=f.submit(task('unknown'));f.start();assert.equal((await f.wait('p',unknown.id,5)).error_code,'USAGE_MISSING');
});
test('stale running tasks become interrupted without replay; queued tasks resume',async t=>{
  let calls=0;const e=await setup(t,{async complete(){calls++;return completed();}});
  const first=e.submit(task('stale'));e.store.claim('dead-worker',2);
  e.store.db.prepare('UPDATE tasks SET lease=? WHERE id=?').run(Date.now()-70000,first.id);
  const second=e.submit(task('queued'));e.start();await e.wait('p',second.id,5);
  assert.equal(e.store.task('p',first.id).state,'interrupted');assert.equal(calls,1);
});
test('dependencies supply completed outputs and failures block dependents',async t=>{
  const packets=[];const e=await setup(t,{async complete(_p,h){packets.push(JSON.parse(h[1].content));return completed('prior-result');}});
  const a=e.submit(task('a')),b=e.submit(task('b',{depends_on:[a.id]}));e.start();assert.equal((await e.wait('p',b.id,5)).state,'completed');
  assert.equal(packets[1].dependency_results[0].result,'prior-result');
  const cancelled=e.submit(task('c'));e.cancel('p',cancelled.id);
  const blocked=e.submit(task('d',{depends_on:[cancelled.id]}));assert.equal((await e.wait('p',blocked.id,5)).state,'blocked');
  const follow=e.submit(task('follow',{previous_task_id:a.id}));assert.equal(follow.snapshot.previous_result,'prior-result');
});
test('size limits, queue capacity, credentials, duplicate materials and secret redaction',async t=>{
  const c=config();c.maxQueued=1;const e=await setup(t,{complete:async()=>completed('synthetic-test-key-only')},c);
  assert.throws(()=>e.submit(task('secret',{context:process.env.BRIDGE_TEST_API_KEY})),{code:'SECRET_IN_INPUT'});
  assert.throws(()=>e.setContext({project_id:'p',expected_revision:0,context:{summary:'',materials:[{id:'same',source:'',title:'',content:''},{id:'same',source:'',title:'',content:''}]}}),{code:'DUPLICATE_MATERIAL'});
  const row=e.submit(task('one'));assert.throws(()=>e.submit(task('two')),{code:'QUEUE_FULL'});
  e.start();assert.equal((await e.wait('p',row.id,5)).result,'[REDACTED]');
});
test('pagination does not skip tasks sharing the same creation timestamp',async t=>{
  const e=await setup(t,{complete:async()=>completed()});
  const tasks=Array.from({length:5},(_,i)=>e.submit(task('page'+i)));
  for(const row of tasks){row.created_at='2026-01-01T00:00:00.000Z';e.store.save(row);e.store.db.prepare('UPDATE tasks SET created=? WHERE id=?').run(row.created_at,row.id);}
  const first=e.store.list('p',2),second=e.store.list('p',2,first.at(-1).id),third=e.store.list('p',2,second.at(-1).id);
  assert.equal(new Set([...first,...second,...third].map(t=>t.id)).size,5);
  assert.throws(()=>e.store.list('other',2,first[0].id),{code:'NOT_FOUND'});
});
test('duplicate provider tool call IDs fail before any memory side effect',async t=>{
  const e=await setup(t,{complete:async()=>({...completed(),output:[call('propose_memory',{content:'claim',source:'s'}),call('propose_memory',{content:'claim',source:'s'})]})});
  const row=e.submit(task('duplicate'));e.start();assert.equal((await e.wait('p',row.id,5)).error_code,'INVALID_TOOL_CALL');assert.equal(e.store.memories('p').length,0);
});
test('graceful shutdown persists interruption and reopening does not replay it',async t=>{
  const c=config();let calls=0;
  const a=new Engine(c,{async complete(_p,_h,_t,_n,signal){calls++;await sleep(10000,undefined,{signal});return completed();}});
  const row=a.submit(task('shutdown'));a.start();await sleep(100);await a.close();
  const b=await setup(t,{async complete(){calls++;return completed();}},c);b.start();
  assert.equal(b.store.task('p',row.id).state,'interrupted');await sleep(350);assert.equal(calls,1);
});
