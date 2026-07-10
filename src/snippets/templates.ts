import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { AdvisorError } from '../errors.js';

/**
 * Snippet template library (PLAN.md 6.1). `templates/` ships next to `rules/`
 * at the package root (listed in package.json `files`), so it's resolved the
 * same way rules.ts resolves `rules/` — walking up from this module rather
 * than assuming a fixed relative depth between source and installed layouts.
 */

let cachedTemplatesDir: string | undefined;

export function templatesDir(): string {
  if (cachedTemplatesDir) return cachedTemplatesDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'templates'),
    join(here, '..', 'templates'),
    join(here, '..', '..', 'templates'),
    join(here, '..', '..', '..', 'templates'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) {
      cachedTemplatesDir = dir;
      return dir;
    }
  }
  throw new AdvisorError({
    problem: 'could not locate the bundled templates/ directory',
    cause: `looked in: ${candidates.join(', ')}`,
    fix: 'reinstall postgres-advisor; templates/ ships with the package',
    docsAnchor: 'troubleshooting',
  });
}

/** Stable template id -> filename. Ids are what mapping options / SnippetGen reference. */
export const TEMPLATE_FILES = {
  'redis-cache-to-unlogged-table': 'redis-cache-to-unlogged-table.sql.hbs',
  'redis-queue-to-pgmq': 'redis-queue-to-pgmq.sql.hbs',
  'bullmq-to-pgmq': 'bullmq-to-pgmq.ts.hbs',
  'mongo-collection-to-jsonb': 'mongo-collection-to-jsonb.sql.hbs',
  'es-index-to-tsvector': 'es-index-to-tsvector.sql.hbs',
  'es-index-to-paradedb': 'es-index-to-paradedb.sql.hbs',
  'pinecone-to-pgvector': 'pinecone-to-pgvector.sql.hbs',
  'influx-to-timescale': 'influx-to-timescale.sql.hbs',
  'cypher-to-recursive-cte': 'cypher-to-recursive-cte.sql.hbs',
} as const;

export type TemplateId = keyof typeof TEMPLATE_FILES;

const compiledCache = new Map<string, HandlebarsTemplateDelegate>();

function compile(file: string): HandlebarsTemplateDelegate {
  let compiled = compiledCache.get(file);
  if (compiled) return compiled;
  const raw = readFileSync(join(templatesDir(), file), 'utf8');
  // noEscape: this generates SQL/TypeScript, not HTML — Handlebars' default
  // HTML-escaping would corrupt quotes and comparison operators in the output.
  // strict: a missing context field throws here instead of silently rendering
  // an empty string, which would otherwise pass the "no unresolved {{...}}"
  // check while still shipping a broken snippet.
  try {
    compiled = Handlebars.compile(raw, { noEscape: true, strict: true });
  } catch (e) {
    throw new AdvisorError({
      problem: `template \`${file}\` failed to compile`,
      cause: e instanceof Error ? e.message : String(e),
      fix: 'this is a packaging bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
  compiledCache.set(file, compiled);
  return compiled;
}

/** Renders a template by its exact filename under templates/. */
export function renderTemplateFile(file: string, context: object): string {
  try {
    return compile(file)(context);
  } catch (e) {
    throw new AdvisorError({
      problem: `template \`${file}\` failed to render`,
      cause: e instanceof Error ? e.message : String(e),
      fix: 'the render context is missing a field this template requires',
      docsAnchor: 'troubleshooting',
    });
  }
}

/** Renders a template by its stable id (see TEMPLATE_FILES). */
export function renderTemplate(id: TemplateId, context: object): string {
  return renderTemplateFile(TEMPLATE_FILES[id], context);
}
