import { AdvisorError } from '../errors.js';

/**
 * Syntax-validates rendered SQL against the real Postgres grammar (PLAN.md
 * 6.1). Uses the WASM build of libpg-query — native bindings brick `npx`
 * installs on Alpine/ARM/Node bumps, and Stage 6.2's AST-shape prompt-
 * injection guard depends on this module loading reliably.
 *
 * Loaded via a dynamic import, not a static one: libpg-query-wasm is
 * pure-ESM with internal top-level await, which a CJS `require()` cannot
 * load synchronously (Node throws `ERR_REQUIRE_ASYNC_MODULE`). A static
 * import gets compiled into a top-level `require()` in the CJS build, which
 * would break `require('postgres-advisor')` for every CJS consumer — not
 * just ones calling this function.
 */
type ParseFn = (sql: string) => unknown;

let parseFn: ParseFn | undefined;

async function loadParser(): Promise<ParseFn> {
  if (!parseFn) {
    const mod = (await import('libpg-query-wasm')) as { parse: ParseFn };
    parseFn = mod.parse;
  }
  return parseFn;
}

export async function validateSql(sql: string, templateName: string): Promise<void> {
  const parse = await loadParser();
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
