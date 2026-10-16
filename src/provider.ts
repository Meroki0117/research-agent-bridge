import type { Profile } from './config.js';
import { BridgeError } from './schema.js';
import { z } from 'zod';

export type WireItem = Record<string, unknown>;
export type ToolDefinition = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };
export type Completion = { status: 'completed' | 'incomplete' | 'failed'; output: WireItem[]; usage?: { input_tokens: number; output_tokens: number }; incomplete_details?: {reason?: string} };
export interface Provider {
  complete(profile: Profile, history: WireItem[], tools: ToolDefinition[], maxTokens: number, signal: AbortSignal, onProgress?: (progress:{visible_chars:number})=>void): Promise<Completion>;
}
export class UpstreamError extends BridgeError {
  constructor(public status: number, public retryAfterMs: number) { super('UPSTREAM_HTTP_' + status, `Provider returned HTTP ${status}. Check credentials, model availability or rate limits.`); }
}
const completionSchema = z.object({
  status: z.enum(['completed','incomplete','failed']), output: z.array(z.record(z.string(),z.unknown())).max(100),
  usage: z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative()}).optional(),
  incomplete_details:z.object({reason:z.string().optional()}).nullable().optional(),
});

export class ResponsesProvider implements Provider {
  async complete(profile: Profile, history: WireItem[], tools: ToolDefinition[], maxTokens: number, signal: AbortSignal, onProgress?: (progress:{visible_chars:number})=>void): Promise<Completion> {
    const key = process.env[profile.apiKeyEnv];
    if (!key) throw new BridgeError('MISSING_API_KEY', `Environment variable ${profile.apiKeyEnv} is missing.`);
    const response = await fetch(profile.endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: {'content-type':'application/json','authorization':`Bearer ${key}`},
      body: JSON.stringify({model:profile.model,input:history,tools,tool_choice:'auto',stream:true,store:false,
        reasoning:{effort:profile.reasoningEffort},max_output_tokens:maxTokens}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = Number(response.headers.get('retry-after'));
      throw new UpstreamError(response.status, Number.isFinite(retry) && retry>0 ? Math.min(retry*1000,10000) : 1000);
    }
    if (!response.body) throw new BridgeError('EMPTY_RESPONSE','Provider returned an empty body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer='', bytes=0, visibleChars=0, value: unknown;
    const streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4*1024*1024) throw new BridgeError('RESPONSE_TOO_LARGE','Provider response exceeded the 4 MiB limit.');
        buffer += decoder.decode(chunk.value,{stream:true});
        if (!streaming) continue;
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event=buffer.slice(0,match.index); buffer=buffer.slice(match.index+match[0].length);
          const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if (!data || data==='[DONE]') continue;
          let parsed: {type?:string; response?:unknown; delta?:unknown};
          try { parsed=JSON.parse(data); } catch { throw new BridgeError('INVALID_RESPONSE','Invalid provider SSE JSON.'); }
          if(parsed.type==='response.output_text.delta'&&typeof parsed.delta==='string'&&parsed.delta.length>0) {
            visibleChars+=Array.from(parsed.delta).length;onProgress?.({visible_chars:visibleChars});
          }
          if (['response.completed','response.incomplete','response.failed'].includes(parsed.type ?? '')) {value=parsed.response; break;}
          if (parsed.type==='error') throw new BridgeError('UPSTREAM_STREAM_ERROR','Provider reported a streaming error.');
        }
        if (value !== undefined) break;
      }
      if (!streaming) {
        try { value=JSON.parse(buffer + decoder.decode()); } catch { throw new BridgeError('INVALID_RESPONSE','Invalid provider JSON.'); }
      }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    const parsed=completionSchema.safeParse(value);
    if (!parsed.success) throw new BridgeError('INVALID_RESPONSE','Missing or invalid terminal provider response.');
    const {incomplete_details,...rest}=parsed.data;
    return incomplete_details?{...rest,incomplete_details}:rest;
  }
}

export function visibleText(output: WireItem[]): string {
  return output.filter(i=>i.type==='message').flatMap(i=>Array.isArray(i.content)?i.content:[])
    .filter(c=>c?.type==='output_text' && typeof c.text==='string').map(c=>c.text).join('\n');
}
