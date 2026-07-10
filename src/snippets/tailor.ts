import { GoogleGenAI } from '@google/genai';
import { configuredModels, isRateLimited, type GeminiClient } from '../classify/gemini.js';
import type { FieldSummary } from '../types.js';
import { astShapeEqual } from './astShape.js';
import { TEMPLATE_FILES, type TemplateId } from './templates.js';

/**
 * Gemini snippet tailoring (PLAN.md 6.2). Applies to `.sql` templates only —
 * `.ts` templates ship untailored (tsc verifies compilation, not intent;
 * there is no TS equivalent of the AST-shape guard in v1, so an unguarded
 * tailored TS snippet is never an option — untailored wins). Every failure
 * mode — `--no-ai`, no API key, every model rate-limited or erroring,
 * non-parsing output, or a failed AST-shape guard — falls back to the
 * untailored template; the guard itself is never skipped while tailoring
 * proceeds.
 */

export interface TailorOptions {
  noAi: boolean;
  apiKey?: string;
  /** Comma-separated `POSTGRES_ADVISOR_GEMINI_MODELS` value overrides the built-in order. */
  models?: string[];
  client?: GeminiClient;
  addWarning?: (warning: string) => void;
}

export interface TailorResult {
  sql: string;
  /** False whenever the untailored template was shipped instead of a Gemini-adapted one. */
  tailored: boolean;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1]! : trimmed).trim();
}

function describeField(field: FieldSummary['fields'][number]): string {
  return `${field.name} (${field.type}${field.nested ? ', nested' : ''})`;
}

function prompt(renderedSql: string, fieldSummary: FieldSummary | undefined): string {
  const schema = fieldSummary
    ? `Target schema (model \`${fieldSummary.model}\`): ${fieldSummary.fields.map(describeField).join(', ')}`
    : 'No target schema information is available — leave identifiers as they are.';
  return [
    'Adapt this Postgres migration snippet to match the target application below.',
    'You may ONLY rename identifiers (table/column/index/function names), adjust literal example values, and edit comments.',
    'You must NOT add, remove, or restructure any SQL statement, clause, or expression.',
    'Return ONLY the adapted SQL — no markdown code fences, no explanation.',
    '',
    schema,
    '',
    renderedSql,
  ].join('\n');
}

async function requestTailoredSql(
  client: GeminiClient,
  model: string,
  renderedSql: string,
  fieldSummary: FieldSummary | undefined,
): Promise<string> {
  const response = await client.models.generateContent({
    model,
    contents: prompt(renderedSql, fieldSummary),
    config: {
      systemInstruction: 'You are a precise SQL migration snippet adapter. Do not change SQL structure — only identifiers, literals, and comments.',
      responseMimeType: 'text/plain',
      maxOutputTokens: 2000,
    },
  });
  if (!response.text) throw new Error('empty Gemini response');
  return stripCodeFence(response.text);
}

export async function tailorSnippet(
  templateId: TemplateId,
  renderedSql: string,
  fieldSummary: FieldSummary | undefined,
  options: TailorOptions,
): Promise<TailorResult> {
  const untailored: TailorResult = { sql: renderedSql, tailored: false };

  if (!TEMPLATE_FILES[templateId].endsWith('.sql.hbs')) return untailored;
  if (options.noAi) return untailored;

  const client = options.client ?? (options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey }) : undefined);
  if (!client) {
    options.addWarning?.('AI snippet tailoring skipped: GEMINI_API_KEY is not set; shipping the untailored template');
    return untailored;
  }

  const models = configuredModels(options.models);
  let tailored: string | undefined;
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      tailored = await requestTailoredSql(client, model, renderedSql, fieldSummary);
      break;
    } catch (error) {
      if (isRateLimited(error)) {
        const next = models[i + 1];
        if (next) options.addWarning?.(`Gemini rate limited on ${model}; retrying snippet tailoring with ${next}`);
        continue;
      }
      options.addWarning?.(
        `Gemini snippet tailoring failed for ${templateId} (${model}): ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }
  if (tailored === undefined) return untailored;

  let guardPassed: boolean;
  try {
    guardPassed = await astShapeEqual(renderedSql, tailored);
  } catch (error) {
    // Covers both "the tailored SQL doesn't even parse" and "the validation
    // module failed to load" (PLAN.md 6.2: either way tailoring is disabled
    // for this snippet, never the guard).
    options.addWarning?.(
      `Snippet tailoring for ${templateId} produced unusable SQL or the validator was unavailable; shipping the untailored template (${error instanceof Error ? error.message : String(error)})`,
    );
    return untailored;
  }

  if (!guardPassed) {
    options.addWarning?.(`Gemini-tailored snippet for ${templateId} failed the AST-shape guard; shipping the untailored template`);
    return untailored;
  }

  return { sql: tailored, tailored: true };
}
