import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {ResponsesProvider} from '../dist/provider.js';
import {defaultConfig} from '../dist/config.js';
const result={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'中文结果'}]}],usage:{input_tokens:1,output_tokens:2}};
async function server(t,handler){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}/responses`;}
async function request(endpoint){process.env.BRIDGE_TEST_API_KEY='test-only';return new ResponsesProvider().complete({...defaultConfig.profiles.deepseek,endpoint,apiKeyEnv:'BRIDGE_TEST_API_KEY'},[{role:'user',content:'test'}],[],128,AbortSignal.timeout(3000));}
test('SSE supports byte-fragmented Unicode and CRLF',async t=>{
  const endpoint=await server(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});const bytes=Buffer.from('event: response.completed\r\ndata: '+JSON.stringify({type:'response.completed',response:result})+'\r\n\r\n');for(const b of bytes)res.write(Buffer.from([b]));res.end();});
  assert.deepEqual(await request(endpoint),result);
});
test('JSON fallback works and incomplete streams fail explicitly',async t=>{
  const json=await server(t,(_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(result));});assert.deepEqual(await request(json),result);
  const broken=await server(t,(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.end('data: {"type":"response.created"}\n\n');});await assert.rejects(()=>request(broken),{code:'INVALID_RESPONSE'});
});
test('does not follow redirects or expose raw HTTP error bodies',async t=>{
  let calls=0;const endpoint=await server(t,(q,r)=>{calls++;if(q.url==='/responses'){r.writeHead(302,{location:'/secret'});r.end();}else r.end('unexpected');});await assert.rejects(()=>request(endpoint));assert.equal(calls,1);
  const denied=await server(t,(_q,r)=>{r.writeHead(401);r.end('RAW_SECRET');});await assert.rejects(()=>request(denied),error=>error.code==='UPSTREAM_HTTP_401'&&!error.message.includes('RAW_SECRET'));
});
test('stream progress exposes only visible character counts, never reasoning or raw text',async t=>{
  const endpoint=await server(t,(_q,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.reasoning_text.delta',delta:'PRIVATE_REASONING'},{type:'response.output_text.delta',delta:''},{type:'response.output_text.delta',delta:'中😀'},{type:'response.completed',response:result}])
      res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end();
  });
  const progress=[];process.env.BRIDGE_TEST_API_KEY='test-only';
  await new ResponsesProvider().complete({...defaultConfig.profiles.deepseek,endpoint,apiKeyEnv:'BRIDGE_TEST_API_KEY'},[],[],128,AbortSignal.timeout(3000),p=>progress.push(p));
  assert.deepEqual(progress,[{visible_chars:2}]);
});
