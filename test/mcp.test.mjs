import test from 'node:test';
import assert from 'node:assert/strict';
import {runSmoke} from '../scripts/smoke.mjs';
test('MCP stdio: discovery, shared workers, tools, idempotency, artifacts and reviewed memory',async()=>{
  assert.equal((await runSmoke()).ok,true);
});
test('MCP modern negotiation uses the same tools and task lifecycle',async()=>{
  assert.equal((await runSmoke({modern:true})).ok,true);
});
