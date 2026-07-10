import { describe, expect, it } from 'vitest';
import { classifyStoresWithGemini, type GeminiClient } from '../src/classify/gemini.js';
import type { DetectedStore, StoreRole } from '../src/types.js';
import type { UsageEvidence } from '../src/usage/harvester.js';

const store: DetectedStore = { id: 'redis:default', product: 'redis', category: ['cache', 'queue'], evidence: [{ kind: 'dependency', file: 'package.json', excerpt: '"ioredis": "x"' }] };
const unknown: StoreRole[] = [{ storeId: store.id, role: 'unknown', confidence: 'low', classifiedBy: 'rule', evidence: store.evidence }];
const usage: UsageEvidence[] = [{ storeId: store.id, command: 'get', kind: 'call-site', file: 'src/cache.ts', line: 8, excerpt: 'await redis.get(key)' }];

function clientWith(...responses: Array<string | Error>): { client: GeminiClient; calls: string[] } {
  const calls: string[] = [];
  return { calls, client: { models: { generateContent: async ({ model }) => {
    calls.push(model);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { text: response ?? '' };
  } } } };
}

describe('Gemini role disambiguation (Stage 3.3)', () => {
  it('replaces an unknown rule role with all valid Gemini roles', async () => {
    const { client } = clientWith('{"roles":[{"role":"cache","confidence":"high"},{"role":"queue","confidence":"medium"}],"rationale":"both call patterns are present"}');
    const roles = await classifyStoresWithGemini([store], unknown, usage, { noAi: false, client });
    expect(roles).toMatchObject([{ role: 'cache', confidence: 'high', classifiedBy: 'gemini' }, { role: 'queue', confidence: 'medium', classifiedBy: 'gemini' }]);
  });

  it('retries invalid JSON once then retains rule output', async () => {
    const { client, calls } = clientWith('not json', '{"roles":[],"rationale":"invalid"}');
    const roles = await classifyStoresWithGemini([store], unknown, usage, { noAi: false, client });
    expect(roles).toEqual(unknown);
    expect(calls).toHaveLength(2);
  });

  it('downgrades only on a rate limit and succeeds with the next model', async () => {
    const warnings: string[] = [];
    const { client, calls } = clientWith(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }), '{"roles":[{"role":"cache","confidence":"high"}],"rationale":"plain KV"}');
    const roles = await classifyStoresWithGemini([store], unknown, usage, { noAi: false, client, models: ['best', 'fallback'], addWarning: (warning) => warnings.push(warning) });
    expect(calls).toEqual(['best', 'fallback']);
    expect(roles[0]).toMatchObject({ role: 'cache', classifiedBy: 'gemini' });
    expect(warnings[0]).toContain('retrying role classification with fallback');
  });

  it('falls back to rules after every configured model is rate limited', async () => {
    const limited = () => Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 });
    const { client, calls } = clientWith(limited(), limited());
    const roles = await classifyStoresWithGemini([store], unknown, usage, { noAi: false, client, models: ['best', 'fallback'] });
    expect(roles).toEqual(unknown);
    expect(calls).toEqual(['best', 'fallback']);
  });

  it('does not call Gemini for --no-ai', async () => {
    const { client, calls } = clientWith(new Error('must not be used'));
    const roles = await classifyStoresWithGemini([store], unknown, usage, { noAi: true, client });
    expect(roles).toEqual(unknown);
    expect(calls).toEqual([]);
  });

  it('keeps a high-confidence rule role and replaces only the weak one', async () => {
    const mixed: StoreRole[] = [
      { storeId: store.id, role: 'cache', confidence: 'high', classifiedBy: 'rule', evidence: store.evidence },
      { storeId: store.id, role: 'unknown', confidence: 'low', classifiedBy: 'rule', evidence: store.evidence },
    ];
    const { client } = clientWith('{"roles":[{"role":"cache","confidence":"medium"},{"role":"queue","confidence":"high"}],"rationale":"queue usage seen"}');
    const roles = await classifyStoresWithGemini([store], mixed, usage, { noAi: false, client });
    // The deterministic cache/high survives; Gemini's duplicate cache role is
    // dropped; its new queue role replaces the weak unknown.
    expect(roles).toMatchObject([
      { role: 'cache', confidence: 'high', classifiedBy: 'rule' },
      { role: 'queue', confidence: 'high', classifiedBy: 'gemini' },
    ]);
  });

  const live = process.env.RUN_LIVE_TESTS === '1' ? it : it.skip;
  live('classifies a real prompt when live tests are enabled', async () => {
    expect(process.env.GEMINI_API_KEY).toBeTruthy();
    const roles = await classifyStoresWithGemini([store], unknown, usage, { noAi: false, apiKey: process.env.GEMINI_API_KEY });
    expect(roles[0]?.classifiedBy).toBe('gemini');
  });
});
