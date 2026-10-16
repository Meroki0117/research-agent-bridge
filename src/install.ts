import { readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,renameSync,unlinkSync,constants } from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as TOML from '@iarna/toml';
import {BridgeError} from './schema.js';

/** Append one validated server table while preserving every existing byte. */
export function installCodex(target:string,snippet:string) {
  const original=existsSync(target)?readFileSync(target,'utf8'):'';
  let parsed:ReturnType<typeof TOML.parse>;
  try {parsed=TOML.parse(original.replace(/^\uFEFF/,''));TOML.parse(snippet);}
  catch {throw new BridgeError('INVALID_TOML','Existing Codex config is not valid TOML. No changes were made.');}
  const servers=parsed.mcp_servers as Record<string,unknown>|undefined;
  const desired=(TOML.parse(snippet).mcp_servers as Record<string,unknown>).research_bridge;
  if(servers&&Object.hasOwn(servers,'research_bridge')) {
    if(JSON.stringify(servers.research_bridge)===JSON.stringify(desired))return {changed:false,target};
    throw new BridgeError('SERVER_EXISTS','research_bridge already exists with different settings. Review it manually; nothing was overwritten.');
  }
  const next=original+(original.endsWith('\n')?'':'\n')+'\n'+snippet;
  TOML.parse(next.replace(/^\uFEFF/,''));
  mkdirSync(dirname(target),{recursive:true});
  const token=randomUUID();const staged=target+'.agent-bridge-'+token+'.tmp';
  let backup:string|undefined;
  try {
    writeFileSync(staged,next,{flag:'wx'});
    const current=existsSync(target)?readFileSync(target,'utf8'):'';
    if(current!==original)throw new BridgeError('CONFIG_CHANGED','Codex config changed during installation. Retry after other edits finish.');
    if(existsSync(target)){backup=target+'.agent-bridge-'+token+'.bak';copyFileSync(target,backup,constants.COPYFILE_EXCL);}
    renameSync(staged,target);
    return {changed:true,target,backup};
  } finally {if(existsSync(staged))unlinkSync(staged);}
}
