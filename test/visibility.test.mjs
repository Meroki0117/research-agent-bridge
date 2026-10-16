import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {Engine} from '../dist/engine.js';
import {defaultConfig} from '../dist/config.js';
import {presentTask,timing} from '../dist/presentation.js';

process.env.BRIDGE_VISIBILITY_TEST_KEY='visibility-synthetic-key';
const config=()=>{const c=structuredClone(defaultConfig);c.dataDir=mkdtempSync(join(tmpdir(),'bridge-visibility-'));c.profiles.deepseek.apiKeyEnv='BRIDGE_VISIBILITY_TEST_KEY';return c;};
const request=(key)=>({project_id:'p',role:'独立审查',objective:'Check the synthetic task.',idempotency_key:key});
const completed=text=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:5,output_tokens:3}});
async function engine(t,provider,c=config()){const e=new Engine(c,provider);t.after(()=>e.close());return e;}

test('visibility defaults OFF, persists across engines, and OFF omits all added presentation fields',async t=>{
  const c=config(),a=await engine(t,{complete:async()=>completed('result')},c),b=await engine(t,{complete:async()=>completed('result')},c);
  const row=a.submit(request('toggle'));assert.equal(a.store.progressVisible(),false);
  const hidden=a.summary(row);assert.equal(hidden.display_markdown,undefined);assert.equal(hidden.recent_events,undefined);assert.equal(hidden.result_excerpt,undefined);assert.equal(hidden.event_cursor,undefined);
  a.store.setProgressVisible(true);assert.equal(b.store.progressVisible(),true);
  const shown=b.summary(row);assert.match(shown.display_markdown,/独立审查/);assert.match(shown.display_markdown,/deepseek-flash/);assert.equal(shown.phase,'queued');
  assert.equal(shown.recent_events.length,1);
  b.store.setProgressVisible(false);assert.equal(a.summary(row).display_markdown,undefined);assert.equal(a.store.events('p',row.id).length,1);
});
test('events preserve request/tool lifecycle without raw arguments and survive reopening',async t=>{
  const c=config();let attempts=0;
  const a=new Engine(c,{async complete(){if(++attempts===1)return {...completed(''),output:[{type:'function_call',call_id:'c1',name:'read_material',arguments:JSON.stringify({id:'source'})}]};return completed('Conclusion');}});
  a.setContext({project_id:'p',expected_revision:0,context:{summary:'context',materials:[{id:'source',title:'title',source:'source',content:'PRIVATE_MATERIAL_NOT_FOR_LOG'}]}});
  const row=a.submit(request('events'));a.start();await a.wait('p',row.id,3);
  const events=a.store.events('p',row.id);
  assert.deepEqual(events.map(e=>e.kind),['queued','started','request_started','response_received','tool_started','tool_completed','request_started','response_received','completed']);
  assert.equal(events.find(e=>e.kind==='tool_completed').tool_name,'read_material');
  assert.ok(events.find(e=>e.kind==='tool_completed').duration_ms>=0);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_MATERIAL_NOT_FOR_LOG'));
  const first=a.store.events('p',row.id,0,3),next=a.store.events('p',row.id,first.at(-1).event_id,100);
  assert.equal(first.length+next.length,events.length);assert.throws(()=>a.store.events('other',row.id),{code:'NOT_FOUND'});
  const total=a.store.events('p',row.id).length;a.submit(request('events'));assert.equal(a.store.events('p',row.id).length,total);
  await a.close();const b=await engine(t,{complete:async()=>completed('unused')},c);assert.deepEqual(b.store.events('p',row.id),events);
});
test('visible text generation wakes ON waits early; OFF ignores event wakeups',async t=>{
  const e=await engine(t,{async complete(_p,_h,_t,_n,signal,onProgress){await sleep(200,undefined,{signal});onProgress({visible_chars:12});await sleep(400,undefined,{signal});return completed('Done');}});
  e.store.setProgressVisible(true);const row=e.submit(request('stream'));e.start();
  const cursor=e.store.lastEventId('p',row.id);
  const update=await e.wait('p',row.id,2,cursor);assert.equal(update.state,'running');assert.equal(update.phase,'output_started');
  assert.match(e.summary(update).display_markdown,/12 字符/);
  const next=e.store.lastEventId('p',row.id);e.store.setProgressVisible(false);
  const started=Date.now();await e.wait('p',row.id,.15,0);assert.ok(Date.now()-started>=120);
  assert.equal(e.summary(e.store.task('p',row.id)).recent_events,undefined);
  await e.wait('p',row.id,2);assert.ok(e.store.lastEventId('p',row.id)>next);
});
test('terminal snapshots freeze elapsed time and sanitize result/role Markdown',async t=>{
  const e=await engine(t,{complete:async()=>completed('unused')});const row=e.submit(request('display'));
  row.created_at='2026-01-01T00:00:00.000Z';row.started_at='2026-01-01T00:00:02.000Z';row.finished_at='2026-01-01T00:00:05.000Z';row.state='completed';
  row.role='[click](https://untrusted.example)';row.result='[untrusted](https://untrusted.example)';
  assert.deepEqual(timing(row,Date.now()),{elapsed_ms:5000,queued_ms:2000,execution_ms:3000});
  const card=presentTask(row,[],0);assert.ok(card.display_markdown.includes('\\[untrusted\\]'));assert.match(card.display_markdown,/待总调度审查/);assert.match(card.display_markdown,/没有可用事件记录/);
});
test('cancelled and failed tasks keep one truthful terminal event without false completion',async t=>{
  const e=await engine(t,{complete:async()=>{throw new Error('PRIVATE_ERROR');}});
  const cancelled=e.submit(request('cancel'));e.cancel('p',cancelled.id);e.cancel('p',cancelled.id);
  assert.deepEqual(e.store.events('p',cancelled.id).map(e=>e.kind),['queued','cancelled']);
  const failed=e.submit(request('fail'));e.start();await e.wait('p',failed.id,2);
  const events=e.store.events('p',failed.id);assert.equal(events.at(-1).kind,'failed');assert.ok(!events.some(e=>e.kind==='completed'));assert.ok(!JSON.stringify(events).includes('PRIVATE_ERROR'));
});
test('new event table can coexist with historical tasks without inventing old steps',async t=>{
  const c=config(),old=new Engine(c,{complete:async()=>completed('old-result')});const row=old.submit(request('legacy'));old.start();await old.wait('p',row.id,2);
  old.store.db.exec('DROP TABLE task_events');await old.close();
  const fresh=await engine(t,{complete:async()=>completed('unused')},c);fresh.store.setProgressVisible(true);
  assert.equal(fresh.store.task('p',row.id).result,'old-result');assert.equal(fresh.store.events('p',row.id).length,0);assert.match(fresh.summary(row).display_markdown,/旧版本/);
});
