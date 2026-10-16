import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installCodex} from '../dist/install.js';
import {loadConfig,defaultConfig} from '../dist/config.js';
const snippet='[mcp_servers.research_bridge]\ncommand = "node"\nargs = ["bridge.js"]\nenv_vars = ["DEEPSEEK_API_KEY"]\n';
test('installer preserves existing config exactly, backs up and is idempotent',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'bridge-install-')),'config.toml');const original='# user comment\nmodel = "keep-me"\n[mcp_servers.existing]\ncommand = "existing"\n';writeFileSync(path,original);
  const result=installCodex(path,snippet);assert.equal(result.changed,true);assert.equal(readFileSync(result.backup,'utf8'),original);
  assert.ok(readFileSync(path,'utf8').startsWith(original));assert.equal(installCodex(path,snippet).changed,false);
  assert.throws(()=>installCodex(path,snippet.replace('bridge.js','other.js')),{code:'SERVER_EXISTS'});
});
test('invalid TOML and quoted existing server names cannot be overwritten',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'bridge-install-')),'config.toml');writeFileSync(path,'broken = [');
  assert.throws(()=>installCodex(path,snippet),{code:'INVALID_TOML'});assert.equal(readFileSync(path,'utf8'),'broken = [');
  writeFileSync(path,'[mcp_servers."research_bridge"]\ncommand="other"\n');assert.throws(()=>installCodex(path,snippet),{code:'SERVER_EXISTS'});
});
test('config rejects credential URLs, plaintext endpoints and misleading DeepSeek routes',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'bridge-config-')),'config.json');
  for(const endpoint of ['http://api.deepseek.com/responses','https://key:secret@api.deepseek.com/responses','https://example.org/responses','https://api.deepseek.com/responses?key=secret']){
    const c=structuredClone(defaultConfig);c.profiles.deepseek.endpoint=endpoint;writeFileSync(path,JSON.stringify(c));assert.throws(()=>loadConfig(path));
  }
});
