import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context, EventInput, Memory, State, Task, TaskEvent } from './schema.js';
import { BridgeError } from './schema.js';
import { timing } from './presentation.js';

type Row = { body: string };
export class Store {
  db: DatabaseSync;
  private transactionDepth=0;
  constructor(dataDir: string, concurrency: number) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'bridge.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, project TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, idem TEXT NOT NULL, state TEXT NOT NULL,
        owner TEXT, lease INTEGER, created TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project, idem));
      CREATE INDEX IF NOT EXISTS task_queue ON tasks(state,created);
      CREATE INDEX IF NOT EXISTS memory_project ON memories(project,status);
      CREATE TABLE IF NOT EXISTS task_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, project TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_event_lookup ON task_events(project,task,seq);`);
    this.transaction(() => {
      const existing = this.db.prepare('SELECT value FROM settings WHERE key=?').get('concurrency') as {value: string} | undefined;
      if (existing && Number(existing.value) !== concurrency) throw new BridgeError('CONFIG_MISMATCH', 'All processes sharing this data directory must use the same concurrency. Use a new dataDir to change it.');
      this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('concurrency', String(concurrency));
    });
  }
  transaction<T>(fn: () => T): T {
    if(this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally {this.transactionDepth--;}
  }
  close() { this.db.close(); }
  progressVisible():boolean {
    const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get('progress_visibility') as {value:string}|undefined;
    return row?.value==='true';
  }
  setProgressVisible(enabled:boolean) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('progress_visibility',String(enabled));
    return {enabled,scope:'bridge_data_directory',persistent:true};
  }
  context(project: string): {revision: number; context: Context} {
    const row = this.db.prepare('SELECT revision,body FROM projects WHERE id=?').get(project) as {revision: number; body: string} | undefined;
    return row ? { revision: row.revision, context: JSON.parse(row.body) } : {revision: 0, context: { summary: '', materials: [] }};
  }
  setContext(project: string, expected: number, context: Context) {
    return this.transaction(() => {
      const current = this.context(project);
      if (current.revision !== expected) throw new BridgeError('REVISION_CONFLICT', 'Read current context and retry with its revision.');
      const revision = current.revision + 1;
      this.db.prepare('INSERT INTO projects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(project, revision, JSON.stringify(context));
      return { project_id: project, revision };
    });
  }
  memories(project: string, status?: string): Memory[] {
    const rows = status ? this.db.prepare('SELECT body FROM memories WHERE project=? AND status=? ORDER BY rowid').all(project,status) : this.db.prepare('SELECT body FROM memories WHERE project=? ORDER BY rowid').all(project);
    return (rows as Row[]).map(r => JSON.parse(r.body));
  }
  propose(project: string, content: string, source: string, author: string): Memory {
    const memory: Memory = {id: randomUUID(), project_id: project, content, source, author, status: 'proposed', revision: 1, created_at: new Date().toISOString()};
    this.db.prepare('INSERT INTO memories VALUES (?,?,?,?)').run(memory.id, project, memory.status, JSON.stringify(memory));
    return memory;
  }
  reviewMemory(project: string, id: string, revision: number, status: 'confirmed' | 'rejected'): Memory {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT body FROM memories WHERE project=? AND id=?').get(project,id) as Row | undefined;
      if (!row) throw new BridgeError('NOT_FOUND','Memory not found in this project.');
      const memory: Memory = JSON.parse(row.body);
      if (memory.revision !== revision) throw new BridgeError('REVISION_CONFLICT','Memory was changed; read it again.');
      memory.status = status; memory.revision++;
      this.db.prepare('UPDATE memories SET status=?,body=? WHERE id=?').run(status,JSON.stringify(memory),id);
      return memory;
    });
  }
  task(project: string, id: string): Task {
    const row = this.db.prepare('SELECT body FROM tasks WHERE project=? AND id=?').get(project,id) as Row | undefined;
    if (!row) throw new BridgeError('NOT_FOUND','Task not found in this project.');
    return JSON.parse(row.body);
  }
  idempotent(project: string, key: string): Task | undefined {
    const row = this.db.prepare('SELECT body FROM tasks WHERE project=? AND idem=?').get(project,key) as Row | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  insert(task: Task, maxQueued: number): Task {
    return this.transaction(() => {
      const prior = this.idempotent(task.project_id,task.submission.idempotency_key);
      if (prior) {
        if (prior.fingerprint !== task.fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT','This key belongs to a different task request.');
        return prior;
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE state='queued'").get() as { n: number };
      if (count.n >= maxQueued) throw new BridgeError('QUEUE_FULL','Queue is full; wait or cancel a queued task.');
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)').run(task.id,task.project_id,task.submission.idempotency_key,task.state,null,null,task.created_at,JSON.stringify(task));
      this.record(task,{kind:'queued'});
      return task;
    });
  }
  list(project: string, limit = 30, beforeId?: string): Task[] {
    const before=beforeId?this.task(project,beforeId):undefined;
    const rows = this.db.prepare('SELECT body FROM tasks WHERE project=? AND (? IS NULL OR created < ? OR (created = ? AND id < ?)) ORDER BY created DESC,id DESC LIMIT ?')
      .all(project,before?.created_at??null,before?.created_at??null,before?.created_at??null,before?.id??null,limit) as Row[];
    return rows.map(r => JSON.parse(r.body));
  }
  private record(task:Task,event:EventInput) {
    const body={...event,task_id:task.id,at:task.updated_at,state:task.state,request:task.requests,elapsed_ms:timing(task,Date.parse(task.updated_at)).elapsed_ms};
    this.db.prepare('INSERT INTO task_events(task,project,body) VALUES (?,?,?)').run(task.id,task.project_id,JSON.stringify(body));
  }
  events(project:string,id:string,after=0,limit=50):TaskEvent[] {
    this.task(project,id);
    const rows=this.db.prepare('SELECT seq,body FROM task_events WHERE project=? AND task=? AND seq>? ORDER BY seq LIMIT ?').all(project,id,after,limit) as {seq:number;body:string}[];
    return rows.map(r=>({...JSON.parse(r.body),event_id:r.seq}));
  }
  recentEvents(project:string,id:string,limit=6):TaskEvent[] {
    this.task(project,id);
    const rows=this.db.prepare('SELECT seq,body FROM task_events WHERE project=? AND task=? ORDER BY seq DESC LIMIT ?').all(project,id,limit) as {seq:number;body:string}[];
    return rows.reverse().map(r=>({...JSON.parse(r.body),event_id:r.seq}));
  }
  lastEventId(project:string,id:string):number {
    const row=this.db.prepare('SELECT max(seq) AS seq FROM task_events WHERE project=? AND task=?').get(project,id) as {seq:number|null};
    return row.seq??0;
  }
  save(task: Task, expected?: State, event?:EventInput): boolean {
    return this.transaction(()=>{
      const old=this.task(task.project_id,task.id);
      if(expected&&old.state!==expected) return false;
      const change=event??(old.state!==task.state?{kind:task.state==='running'?'started':task.state,error_code:task.error_code}:undefined);
      if(change) {
        task.phase=change.kind;
        task.current_tool=change.kind==='tool_started'?change.tool_name:undefined;
      }
      this.db.prepare('UPDATE tasks SET state=?,owner=?,body=? WHERE id=?').run(task.state,task.owner??null,JSON.stringify(task),task.id);
      if(change)this.record(task,change);
      return true;
    });
  }
  claim(owner: string, concurrency: number): Task | undefined {
    return this.transaction(() => {
      // Expired requests may have reached the provider. Never replay them automatically.
      const stale = this.db.prepare("SELECT body FROM tasks WHERE state='running' AND lease < ?").all(Date.now()-60000) as Row[];
      for (const r of stale) {
        const task: Task = JSON.parse(r.body);
        task.state='interrupted'; task.error_code='WORKER_LOST'; task.progress='Worker stopped; upstream billing status may be unknown.';
        task.usage_complete=false; task.finished_at=task.updated_at=new Date().toISOString(); this.save(task,'running');
      }
      const n = this.db.prepare("SELECT count(*) AS n FROM tasks WHERE state='running'").get() as {n: number};
      if (n.n >= concurrency) return;
      const rows = this.db.prepare("SELECT body FROM tasks WHERE state='queued' ORDER BY created").all() as Row[];
      for (const row of rows) {
        const task: Task = JSON.parse(row.body);
        const deps = task.submission.depends_on.map(id => this.task(task.project_id,id));
        if (deps.some(d => d.state !== 'queued' && d.state !== 'running' && d.state !== 'completed')) {
          task.state='blocked'; task.error_code='DEPENDENCY_FAILED'; task.finished_at=task.updated_at=new Date().toISOString(); this.save(task,'queued'); continue;
        }
        if (deps.some(d => d.state !== 'completed')) continue;
        task.owner=owner; task.state='running'; task.started_at=task.updated_at=new Date().toISOString(); task.progress='Preparing context';
        this.save(task,'queued'); this.db.prepare('UPDATE tasks SET lease=? WHERE id=?').run(Date.now(),task.id);
        return task;
      }
    });
  }
  heartbeat(owner: string, taskIds: string[]) {
    const update=this.db.prepare("UPDATE tasks SET lease=? WHERE owner=? AND id=? AND state='running'");
    for(const id of taskIds) update.run(Date.now(),owner,id);
  }
}
