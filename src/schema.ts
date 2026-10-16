import { z } from 'zod';
import type { Profile } from './config.js';

export const projectId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).describe('Stable project ID; use a different ID for unrelated projects.');
export const id = z.string().uuid();
export const materialSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: z.string().max(300), source: z.string().max(2000), content: z.string().max(60000) }).strict();
export const contextSchema = z.object({
  summary: z.string().max(60000), materials: z.array(materialSchema).max(30).default([]),
}).strict();
export const contextInput = z.object({ project_id: projectId, expected_revision: z.number().int().min(0), context: contextSchema }).strict();
export const submitInput = z.object({
  project_id: projectId, role: z.string().min(1).max(300), objective: z.string().min(1).max(30000),
  context: z.string().max(30000).default(''), profile: z.string().max(64).optional(),
  acceptance: z.string().max(10000).default('State conclusions, assumptions, evidence, uncertainties and sources. Do not invent citations.'),
  idempotency_key: z.string().min(1).max(128).describe('Unique per intended task. Reuse after a lost tool response to avoid duplicate API spend.'),
  previous_task_id: id.optional(),
  depends_on: z.array(id).max(8).default([]),
  timeout_seconds: z.number().int().min(5).max(1800).optional(),
  max_requests: z.number().int().min(1).max(20).optional(),
  output_token_budget: z.number().int().min(128).max(100000).optional(),
}).strict();
export const memoryInput = z.object({ project_id: projectId, content: z.string().min(1).max(6000), source: z.string().min(1).max(2000) }).strict();
export type Submit = z.infer<typeof submitInput>;
export type Context = z.infer<typeof contextSchema>;
export type State = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'budget_exceeded' | 'interrupted' | 'blocked';
export const terminal = (s: State) => s !== 'queued' && s !== 'running';
export type Memory = { id: string; project_id: string; content: string; source: string; author: string; status: 'proposed' | 'confirmed' | 'rejected'; revision: number; created_at: string };
export type Snapshot = { revision: number; context: Context; memories: Memory[]; previous_result?: string };
export type EventKind = 'queued' | 'started' | 'request_started' | 'response_received' | 'output_started' | 'retry_scheduled' | 'tool_started' | 'tool_completed' | 'tool_failed' | Exclude<State,'queued'|'running'>;
export type EventInput = { kind: EventKind; tool_name?: string; duration_ms?: number; error_code?: string };
export type TaskEvent = EventInput & { event_id: number; task_id: string; at: string; state: State; request: number; elapsed_ms: number };
export type Task = {
  id: string; project_id: string; role: string; profile_name: string; profile: Profile;
  submission: Submit; fingerprint: string; snapshot: Snapshot;
  state: State; created_at: string; updated_at: string; started_at?: string; finished_at?: string;
  timeout_seconds: number; max_requests: number; output_token_budget: number;
  requests: number; input_tokens: number; output_tokens: number; usage_complete: boolean;
  progress: string; error_code?: string; result?: string; partial_result?: string;
  tools_used: string[]; owner?: string;
  phase?: EventKind; current_tool?: string; visible_output_chars?: number;
};

export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
