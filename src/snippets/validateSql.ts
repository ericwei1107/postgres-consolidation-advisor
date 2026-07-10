import { AdvisorError } from '../errors.js';

/**
 * Loads libpg-query-wasm's `parse`/`ParseResult` exports, shared by
 * validateSql (this file) and Stage 6.2's AST-shape guard (astShape.ts).
 *
 * Loaded via a dynamic import, not a static one: libpg-query-wasm is
 * pure-ESM with internal top-level await, which a CJS `require()` cannot
 * load synchronously (Node throws `ERR_REQUIRE_ASYNC_MODULE`). A static
 * import gets compiled into a top-level `require()` in the CJS build, which
 * would break `require('postgres-advisor')` for every CJS consumer — not
 * just ones calling one of these functions.
 */
export interface ParseResultType {
  toObject(message: unknown, options?: { enums?: unknown; longs?: unknown; defaults?: boolean }): object;
}

export interface LibpgQuery {
  parse: (sql: string) => unknown;
  ParseResult: ParseResultType;
}

let cached: LibpgQuery | undefined;

export async function loadLibpgQuery(): Promise<LibpgQuery> {
  if (!cached) {
    cached = (await import('libpg-query-wasm')) as unknown as LibpgQuery;
  }
  return cached;
}

/** Syntax-validates rendered SQL against the real Postgres grammar (PLAN.md 6.1). */
export async function validateSql(sql: string, templateName: string): Promise<void> {
  const { parse } = await loadLibpgQuery();
  try {
    parse(sql);
  } catch (e) {
    throw new AdvisorError({
      problem: `rendered SQL from template \`${templateName}\` failed to parse`,
      cause: e instanceof Error ? e.message : String(e),
      fix: 'this is a template bug — please file an issue',
      docsAnchor: 'troubleshooting',
    });
  }
}
