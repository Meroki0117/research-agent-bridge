import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/client/stdio';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {defaultConfig} from '../dist/config.js';

const appDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function runSmoke({live=false,modern=false}={}) {
  if(live&&!process.env.DEEPSEEK_API_KEY)throw new Error('DEEPSEEK_API_KEY is missing in this terminal.');
  mkdirSync(join(appDir,'test-results'),{recursive:true});
  const dir=mkdtempSync(join(appDir,'test-results',live?'live-':'mock-'));
  const config=structuredClone(defaultConfig);config.dataDir=join(dir,'data');
  config.defaults.maxRequests=3;config.defaults.outputTokenBudget=768;config.profiles.deepseek.maxOutputTokens=256;
  let mock,requests=0,active=0,peak=0;
  const env=getDefaultEnvironment();
  if(live) env.DEEPSEEK_API_KEY=process.env.DEEPSEEK_API_KEY;
  else {
    mock=createServer(async(req,res)=>{
      let text='';for await(const chunk of req)text+=chunk;
      const body=JSON.parse(text);requests++;active++;peak=Math.max(peak,active);
      await sleep(150);
      const packet=JSON.parse(body.input.find(i=>i.role==='user').content);
      const material=packet.role==='proof'?'alpha':'beta';
      const result=body.input.find(i=>i.type==='function_call_output');
      const output=result?[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.parse(result.output).content}]}]:[
        {type:'function_call',call_id:'call_'+packet.role,name:'read_material',arguments:JSON.stringify({id:material})}];
      const response={status:'completed',output,usage:{input_tokens:100,output_tokens:10}};
      res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response})+'\n\n');active--;
    });
    await new Promise(r=>mock.listen(0,'127.0.0.1',r));
    config.profiles.deepseek.provider='test';config.profiles.deepseek.endpoint=`http://127.0.0.1:${mock.address().port}/responses`;
    config.profiles.deepseek.apiKeyEnv='BRIDGE_TEST_API_KEY';env.BRIDGE_TEST_API_KEY='synthetic-smoke-key';env.BRIDGE_ALLOW_LOOPBACK='1';
  }
  const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify(config,null,2));
  const clients=[];
  const call=async(client,name,args={})=>{
    const response=await client.callTool({name,arguments:args});
    if(response.isError)throw new Error(`MCP ${name}: ${response.content?.[0]?.text}`);
    return JSON.parse(response.content[0].text);
  };
  try {
    // Two distinct stdio processes intentionally share one durable queue.
    for(let i=0;i<2;i++) {
      const client=new Client({name:'bridge-smoke',version:'0.1.0'});
      const transport=new StdioClientTransport({command:process.execPath,args:[join(appDir,'dist/cli.js'),'serve','--config',configPath],env,stderr:'pipe'});
      transport.stderr?.on('data',()=>{});
      await client.connect(transport,modern?{mode:'auto'}:undefined);clients.push(client);
    }
    const [a,b]=clients;
    const {tools}=await a.listTools();assert.ok(tools.some(t=>t.name==='submit_task'));
    const info=await call(a,'get_bridge_info');assert.equal(info.external_concurrency,2);
    assert.equal((await call(a,'get_progress_visibility')).enabled,false);
    await call(a,'set_progress_visibility',{enabled:true});
    assert.equal((await call(b,'get_progress_visibility')).enabled,true);
    await call(a,'set_project_context',{project_id:'smoke',expected_revision:0,context:{summary:'Synthetic concurrency and isolation test.',materials:[
      {id:'alpha',title:'Proof token',source:'synthetic test',content:'PROOF_TOKEN_173'},
      {id:'beta',title:'Review token',source:'synthetic test',content:'REVIEW_TOKEN_829'}]}});
    const inputs=['proof','review'].map((role,i)=>({project_id:'smoke',role,objective:`Call read_material with id ${i===0?'alpha':'beta'}. Your final answer must be exactly the material content, without formatting or commentary.`,idempotency_key:'smoke-'+role}));
    const jobs=await Promise.all([call(a,'submit_task',inputs[0]),call(b,'submit_task',inputs[1])]);
    assert.notEqual(jobs[0].task_id,jobs[1].task_id);
    assert.ok(jobs.every(j=>j.display_markdown.includes('外部 Agent')));
    assert.equal((await call(b,'submit_task',inputs[0])).task_id,jobs[0].task_id);
    const results=await Promise.all(jobs.map(async(job,i)=>{
      const ref={project_id:'smoke',task_id:job.task_id};let state=job;
      const deadline=Date.now()+190000;
      while(['queued','running'].includes(state.state)&&Date.now()<deadline)state=await call(clients[i],'wait_task',{...ref,seconds:20});
      assert.equal(state.state,'completed',JSON.stringify(state));
      assert.ok(state.tools_used.includes('read_material'));
      const artifact=await call(clients[i],'get_artifact',ref);
      assert.equal(artifact.content.trim(),i===0?'PROOF_TOKEN_173':'REVIEW_TOKEN_829');
      const timeline=await call(clients[i],'get_task_events',{...ref,limit:100});
      assert.equal(timeline.events[0].kind,'queued');assert.equal(timeline.events.at(-1).kind,'completed');
      assert.ok(timeline.events.some(e=>e.kind==='tool_completed'&&e.tool_name==='read_material'));
      assert.ok(state.elapsed_ms>=state.execution_ms);assert.ok(state.result_excerpt);
      return {task:state,artifact,timeline};
    }));
    const overlap=Math.max(...results.map(r=>Date.parse(r.task.started_at)))<Math.min(...results.map(r=>Date.parse(r.task.finished_at)));
    assert.equal(overlap,true);
    if(!live){assert.equal(requests,4);assert.equal(peak,2);}
    await call(a,'set_progress_visibility',{enabled:false});
    const hiddenResponse=await b.callTool({name:'get_task',arguments:{project_id:'smoke',task_id:jobs[0].task_id}});
    assert.equal(hiddenResponse.content.length,1);
    const hidden=JSON.parse(hiddenResponse.content[0].text);assert.equal(hidden.display_markdown,undefined);assert.equal(hidden.recent_events,undefined);assert.equal(hidden.result_excerpt,undefined);
    const proposal=await call(a,'propose_memory_update',{project_id:'smoke',content:'Smoke test completed.',source:'local synthetic test'});
    assert.equal((await call(b,'read_project_memory',{project_id:'smoke'})).entries.length,0);
    await call(b,'review_memory',{project_id:'smoke',memory_id:proposal.id,expected_revision:1,decision:'confirmed'});
    assert.equal((await call(a,'read_project_memory',{project_id:'smoke'})).entries.length,1);
    const report={ok:true,mode:live?'official-deepseek':'local-mock',protocol:modern?'auto-negotiated':'legacy-initialize',two_stdio_processes:true,requests:live?results.reduce((n,r)=>n+r.task.requests,0):requests,
      overlapping_tasks:overlap,total_tokens:results.reduce((n,r)=>n+r.task.usage.input_tokens+r.task.usage.output_tokens,0),results,
      scope:'Real MCP transport, durable queue and provider tool loop. Native GPT orchestration is a separate Codex-session acceptance check.'};
    writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));return {ok:true,report_path:join(dir,'report.json'),...report};
  } finally {
    await Promise.allSettled(clients.map(c=>c.close()));mock?.closeAllConnections();await new Promise(r=>mock?mock.close(r):r());
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const r=await runSmoke({live:process.argv.includes('--live'),modern:process.argv.includes('--modern')});console.log(JSON.stringify({ok:r.ok,mode:r.mode,requests:r.requests,total_tokens:r.total_tokens,report_path:r.report_path},null,2));}
  catch(error){console.error(error instanceof Error?error.message:'Smoke test failed.');process.exitCode=1;}
}
