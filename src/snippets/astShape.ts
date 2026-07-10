import { loadLibpgQuery } from './validateSql.js';

/**
 * AST-shape equality guard (PLAN.md 6.2). Structurally defuses prompt
 * injection from repo content: a hostile repo can't get Gemini to smuggle
 * extra SQL into a snippet the user will copy-paste, because any parse tree
 * with a different statement count, a different statement type, or a
 * different sub-clause shape is rejected outright.
 *
 * The comparison strips every leaf scalar down to a shape marker instead of
 * its actual value:
 *  - booleans compare exactly (structural flags — `ifNotExists`, `unique`,
 *    `isLocal`, ... — are almost never identifiers or literals, so this
 *    catches accidental/malicious flag flips cheaply);
 *  - strings and numbers compare only by JS type, not content — this is
 *    what lets identifiers, type names, and literal values be freely
 *    tailored, and it also neutralizes `location`/`stmtLen` position
 *    bookkeeping, which shifts on every rename and would otherwise never
 *    match between two semantically-identical statements.
 *  - object key sets and array lengths must match exactly at every path —
 *    this is what catches an added/removed/reordered statement or clause.
 *
 * Known, accepted limitation: some structural facts are represented as
 * short enum-coded strings (e.g. `relpersistence: "u"` for UNLOGGED vs
 * `"p"` for permanent) that are indistinguishable, by type alone, from a
 * genuine identifier or literal. Catching those would need a per-field
 * classifier of the full Postgres grammar, which is exactly the kind of
 * fragile, easy-to-get-subtly-wrong machinery this guard is designed to
 * avoid. The guarantee this function actually provides — no statement was
 * added, removed, reordered, or changed in kind or sub-clause shape — is
 * the one PLAN.md 6.2 asks for ("new statements, changed statement types").
 */

function shapeOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (node !== null && typeof node === 'object') {
    const shape: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      shape[key] = shapeOf((node as Record<string, unknown>)[key]);
    }
    return shape;
  }
  if (typeof node === 'boolean') return node;
  if (node === null || node === undefined) return 'null';
  return typeof node;
}

/**
 * True when `a` and `b` parse to the same statement shape. Throws if either
 * fails to parse (a non-parsing tailored snippet is exactly the case the
 * caller must also treat as "discard, ship untailored").
 */
export async function astShapeEqual(a: string, b: string): Promise<boolean> {
  const { parse, ParseResult } = await loadLibpgQuery();
  const toObject = (sql: string): object => ParseResult.toObject(parse(sql), { enums: String, longs: String, defaults: false });
  return JSON.stringify(shapeOf(toObject(a))) === JSON.stringify(shapeOf(toObject(b)));
}
