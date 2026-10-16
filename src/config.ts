import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const profileSchema = z.object({
  adapter: z.literal('responses'), provider: z.string().min(1).max(80),
  endpoint: z.string().url(), model: z.string().min(1).max(120),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).default('none'),
  maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
}).strict();
export type Profile = z.infer<typeof profileSchema>;
export const configSchema = z.object({
  version: z.literal(1), dataDir: z.string().min(1),
  concurrency: z.number().int().min(1).max(16).default(2),
  maxQueued: z.number().int().min(1).max(1000).default(100),
  maxInputChars: z.number().int().min(1000).max(500000).default(120000),
  routing: z.object({
    maxActiveChildren: z.number().int().min(1).max(16).default(2),
    rules: z.array(z.string().min(1).max(2000)).max(30).default([]),
  }).strict().default({maxActiveChildren:2,rules:[]}),
  profiles: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), profileSchema),
  defaults: z.object({
    profile: z.string(), timeoutSeconds: z.number().int().min(5).max(1800).default(180),
    maxRequests: z.number().int().min(1).max(20).default(6),
    outputTokenBudget: z.number().int().min(128).max(100000).default(12000),
  }).strict(),
}).strict();
export type Config = z.infer<typeof configSchema>;

export function loadConfig(path: string): Config {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Cannot read config JSON. Run init or check --config path.'); }
  const result = configSchema.safeParse(parsed);
  if (!result.success) throw new Error('Invalid config: ' + result.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; '));
  const config = result.data;
  if (!Object.hasOwn(config.profiles, config.defaults.profile)) throw new Error('Default profile does not exist.');
  for (const p of Object.values(config.profiles)) {
    const url = new URL(p.endpoint);
    const loopbackTest = process.env.BRIDGE_ALLOW_LOOPBACK === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((!loopbackTest && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash)
      throw new Error('Provider endpoint must be HTTPS without credentials, query or fragment.');
    if (p.provider === 'deepseek' && (url.origin !== 'https://api.deepseek.com' || url.pathname !== '/responses'))
      throw new Error('DeepSeek profile must use its official Responses endpoint.');
  }
  config.dataDir = resolve(dirname(resolve(path)), config.dataDir);
  return config;
}

export const defaultConfig: Config = {
  version: 1, dataDir: '.data', concurrency: 2, maxQueued: 100, maxInputChars: 120000,
  routing: {maxActiveChildren:2,rules:[
    'For substantial mathematics tasks, consider a derivation agent and an independent reviewer; choose GPT native or an external profile based on task needs.',
    'For paper writing, separate drafting from source/claim review. Do not present unverified references as real sources.',
    'Use the same model for multiple agents when appropriate; roles and agent instances must stay independent of model providers.'
  ]},
  profiles: { deepseek: { adapter: 'responses', provider: 'deepseek', endpoint: 'https://api.deepseek.com/responses', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', reasoningEffort: 'none', maxOutputTokens: 4096 } },
  defaults: { profile: 'deepseek', timeoutSeconds: 180, maxRequests: 6, outputTokenBudget: 12000 },
};
