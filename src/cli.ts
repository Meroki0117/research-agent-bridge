#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname,resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig,defaultConfig } from './config.js';
import { Engine } from './engine.js';
import { createServer } from './server.js';
import { BridgeError } from './schema.js';
import { installCodex } from './install.js';

const appDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},output:{type:'string'},'codex-config':{type:'string'},help:{type:'boolean'}}});
const configPath=resolve(values.config??resolve(appDir,'bridge.config.json'));
const command=positionals[0]??'help';
const print=(value:unknown)=>console.log(typeof value==='string'?value:JSON.stringify(value,null,2));

async function main() {
  if(command==='help'||values.help) {
    print(`agent-bridge (Node.js 24+)\n  init [--config PATH]          Create config, never overwrite\n  doctor [--config PATH]        Check local setup; no API request\n  codex-config [--output PATH]  Generate Codex TOML snippet; no secrets\n  install-codex --codex-config PATH  Append server entry with backup\n  serve [--config PATH]         Run stdio MCP server\n\nDefault config: ${configPath}`);return;
  }
  if(command==='init') {
    mkdirSync(dirname(configPath),{recursive:true});writeFileSync(configPath,JSON.stringify(defaultConfig,null,2)+'\n',{flag:'wx'});
    print({created:configPath,next:'Run doctor, then codex-config.'});return;
  }
  const config=loadConfig(configPath);
  if(command==='doctor') {
    const engine=new Engine(config);
    const profiles=Object.entries(config.profiles).map(([name,p])=>({name,model:p.model,provider:p.provider,api_key_env:p.apiKeyEnv,key_present:!!process.env[p.apiKeyEnv]}));
    print({ok:profiles.every(p=>p.key_present),node:process.version,config:configPath,data_dir:config.dataDir,concurrency:config.concurrency,profiles,
      note:'Local configuration and SQLite checked; no paid requests made. GPT uses Codex native collaboration.'});
    await engine.close();if(profiles.some(p=>!p.key_present))process.exitCode=1;return;
  }
  if(command==='codex-config'||command==='install-codex') {
    const quote=(s:string)=>JSON.stringify(s.replaceAll('\\','/'));
    const vars=[...new Set(Object.values(config.profiles).map(p=>p.apiKeyEnv))];
    const text=`# BEGIN agent-bridge (generated; API keys stay in environment variables)\n[mcp_servers.research_bridge]\ncommand = ${quote(process.execPath)}\nargs = [${quote(resolve(appDir,'dist/cli.js'))}, "serve", "--config", ${quote(configPath)}]\nenv_vars = ${JSON.stringify(vars)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 40\n# END agent-bridge\n`;
    if(command==='install-codex') {
      if(!values['codex-config'])throw new BridgeError('MISSING_PATH','Specify --codex-config with the intended Codex config.toml path.');
      print(installCodex(resolve(values['codex-config']),text));return;
    }
    if(values.output) {writeFileSync(resolve(values.output),text,{flag:'wx'});print({created:resolve(values.output)});}else print(text);return;
  }
  if(command==='serve') {
    const engine=new Engine(config);
    const handle=serveStdio(()=>createServer(engine),{onerror:()=>console.error('[agent-bridge] MCP transport error.')});
    engine.start();let closing=false;
    async function close() {if(closing)return;closing=true;await engine.close();await handle.close();}
    process.stdin.on('end',()=>void close());
    process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
    return;
  }
  throw new BridgeError('UNKNOWN_COMMAND','Unknown command. Use help.');
}
main().catch(error=>{
  // Never echo arbitrary provider bodies, input JSON or environment values.
  const message=error instanceof BridgeError?error.message:error?.code==='EEXIST'?'Output already exists; refusing to overwrite.':error instanceof Error&&['Cannot read config','Invalid config','Default profile','Provider endpoint','DeepSeek profile'].some(p=>error.message.startsWith(p))?error.message:'Startup failed. Check configuration, Node version and file permissions.';
  console.error('[agent-bridge] '+message);process.exitCode=1;
});
