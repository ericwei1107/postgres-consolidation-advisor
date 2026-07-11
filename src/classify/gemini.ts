import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { DetectedStore, Evidence, StoreCategory, StoreRole } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { AI_KEY_REJECTED } from '../report/terminal.js';

/** Ordered from highest-capability to lowest-cost Gemini text model. */
export const DEFAULT_GEMINI_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
] as const;
const MAX_EXCERPTS = 30;

const GeminiResponseSchema = z.object({
  roles: z.array(z.object({
    role: z.enum(['cache', 'queue', 'search', 'document', 'vector', 'timeseries', 'olap', 'graph', 'geospatial', 'relational', 'unknown']),
    confidence: z.enum(['high', 'medium', 'low']),
  })).min(1),
  rationale: z.string().min(1),
});

type GeminiResponse = z.infer<typeof GeminiResponseSchema>;

/** Small SDK boundary so model fallback behavior is deterministic and inexpensive to test. */
export interface GeminiClient {
  models: {
    generateContent(request: {
      model: string;
      contents: string;
      config: { systemInstruction: string; responseMimeType: string; maxOutputTokens: number };
    }): Promise<{ text?: string }>;
  };
}

export interface GeminiClassificationOptions {
  noAi: boolean;
  apiKey?: string;
  /** Comma-separated `POSTGRES_ADVISOR_GEMINI_MODELS` value overrides the built-in order. */
  models?: string[];
  client?: GeminiClient;
  addWarning?: (warning: string) => void;
}

function evidenceFromUsage(usage: UsageEvidence[]): Evidence[] {
  return usage.map(({ kind, file, line, excerpt }) => ({ kind, file, ...(line ? { line } : {}), excerpt }));
}

/** Weak = the rule pass couldn't commit: unknown role or low confidence. */
function isWeak(role: StoreRole): boolean {
  return role.role === 'unknown' || role.confidence === 'low';
}

function needsGemini(roles: StoreRole[]): boolean {
  return roles.some(isWeak);
}

function prompt(store: DetectedStore, usage: UsageEvidence[]): string {
  const excerpts = usage.slice(0, MAX_EXCERPTS).map(({ file, line, command, excerpt }) => ({ file, ...(line ? { line } : {}), command, excerpt }));
  return [
    'Classify how this data store is used by the application.',
    'A store can have multiple roles; retain every distinct role supported by the evidence.',
    'Use `unknown` with low confidence when the excerpts do not establish a role.',
    'Return JSON only: {"roles":[{"role":"cache|queue|search|document|vector|timeseries|olap|graph|geospatial|relational|unknown","confidence":"high|medium|low"}],"rationale":"..."}',
    '',
    JSON.stringify({ product: store.product, usage: excerpts }),
  ].join('\n');
}

/** Shared with Stage 6.2's snippet tailoring — same model-fallback semantics. */
export function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== 'object') return /\b429\b|RESOURCE_EXHAUSTED/i.test(String(error));
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  return candidate.status === 429
    || candidate.code === 429
    || candidate.status === 'RESOURCE_EXHAUSTED'
    || candidate.code === 'RESOURCE_EXHAUSTED'
    || /\b429\b|RESOURCE_EXHAUSTED/i.test(String(candidate.message ?? ''));
}

/**
 * A set-but-rejected key (401/403) is a distinct failure from a transient API
 * error — the terminal surface reports it separately (PLAN.md 7.0) so the user
 * fixes the key instead of shrugging at a generic fallback.
 */
export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return /\b40[13]\b|PERMISSION_DENIED|UNAUTHENTICATED|API key/i.test(String(error));
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  return candidate.status === 401
    || candidate.status === 403
    || candidate.code === 401
    || candidate.code === 403
    || candidate.status === 'PERMISSION_DENIED'
    || candidate.status === 'UNAUTHENTICATED'
    || candidate.code === 'PERMISSION_DENIED'
    || candidate.code === 'UNAUTHENTICATED'
    || /\b40[13]\b|PERMISSION_DENIED|UNAUTHENTICATED|API key/i.test(String(candidate.message ?? ''));
}

/** Shared with Stage 6.2's snippet tailoring — same POSTGRES_ADVISOR_GEMINI_MODELS override. */
export function configuredModels(models?: string[]): string[] {
  const values = models ?? process.env.POSTGRES_ADVISOR_GEMINI_MODELS?.split(',');
  const normalized = (values ?? DEFAULT_GEMINI_MODELS).map((model) => model.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_GEMINI_MODELS];
}

async function classifyOne(
  client: GeminiClient,
  store: DetectedStore,
  usage: UsageEvidence[],
  models: string[],
  addWarning?: (warning: string) => void,
): Promise<GeminiResponse> {
  let lastRateLimit: unknown;
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex]!;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: prompt(store, usage),
          config: {
            systemInstruction: 'You are a precise source-code usage classifier. Do not infer capabilities that are not evidenced.',
            responseMimeType: 'application/json',
            maxOutputTokens: 500,
          },
        });
        return GeminiResponseSchema.parse(JSON.parse(response.text ?? ''));
      } catch (error) {
        if (isRateLimited(error)) {
          lastRateLimit = error;
          const next = models[modelIndex + 1];
          if (next) addWarning?.(`Gemini rate limited on ${model}; retrying role classification with ${next}`);
          break;
        }
        if (attempt === 1) throw error;
      }
    }
  }
  throw lastRateLimit ?? new Error('no Gemini models configured');
}

/**
 * Replaces only a store's WEAK rule roles (unknown/low) with Gemini roles —
 * a high/medium deterministic role always survives, and a Gemini role that
 * duplicates a kept role's name is dropped. All API failures retain rule output.
 */
export async function classifyStoresWithGemini(
  stores: DetectedStore[], ruleRoles: StoreRole[], usage: UsageEvidence[], options: GeminiClassificationOptions,
): Promise<StoreRole[]> {
  if (options.noAi) return ruleRoles;
  const candidates = stores.filter((store) => needsGemini(ruleRoles.filter((role) => role.storeId === store.id)));
  if (candidates.length === 0) return ruleRoles;

  const client = options.client ?? (options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey }) : undefined);
  if (!client) {
    options.addWarning?.('AI role classification skipped: GEMINI_API_KEY is not set; using rule results');
    return ruleRoles;
  }

  const usageByStore = new Map<string, UsageEvidence[]>();
  for (const hit of usage) usageByStore.set(hit.storeId, [...(usageByStore.get(hit.storeId) ?? []), hit]);
  const replacements = new Map<string, StoreRole[]>();
  const models = configuredModels(options.models);

  for (const store of candidates) {
    const storeUsage = usageByStore.get(store.id) ?? [];
    try {
      const result = await classifyOne(client, store, storeUsage, models, options.addWarning);
      const evidence = storeUsage.length > 0 ? evidenceFromUsage(storeUsage.slice(0, MAX_EXCERPTS)) : store.evidence;
      replacements.set(store.id, result.roles.map(({ role, confidence }) => ({
        storeId: store.id, role: role as StoreCategory, confidence, classifiedBy: 'gemini' as const, evidence,
      })));
    } catch (error) {
      // A rejected key fails identically for every store — report it once with
      // the distinct auth message and stop hammering the API (PLAN.md 7.0).
      if (isAuthError(error)) {
        options.addWarning?.(AI_KEY_REJECTED);
        break;
      }
      options.addWarning?.(`Gemini role classification failed for ${store.product} (${store.id}); using rule results: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return ruleRoles.flatMap((role, index) => {
    const replacement = replacements.get(role.storeId);
    if (!replacement || !isWeak(role)) return [role];
    const firstWeak = ruleRoles.findIndex((r) => r.storeId === role.storeId && isWeak(r));
    if (firstWeak !== index) return [];
    const kept = new Set(
      ruleRoles.filter((r) => r.storeId === role.storeId && !isWeak(r)).map((r) => r.role),
    );
    return replacement.filter((r) => !kept.has(r.role));
  });
}
