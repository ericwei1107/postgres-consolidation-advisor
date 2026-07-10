import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';

/**
 * PLAN.md 4.2: "NO numeric literal related to thresholds may appear in
 * TypeScript — enforced by a lint-style test that greps src/scoring/ for
 * numeric literals > 10." src/scoring/ doesn't exist until Stage 5.1; this
 * test is written now so 5.1's verdict engine is built against an
 * already-enforced rule, not one added after the fact.
 *
 * Strips line/block comments and string literals first so citations like
 * "// see PLAN.md 5.1" or a source URL in a comment don't false-positive.
 */

const ROOT = join(__dirname, '..');

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ');
}

function findLargeLiterals(source: string): number[] {
  const stripped = stripCommentsAndStrings(source);
  const matches = stripped.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  return matches.map(Number).filter((n) => n > 10);
}

describe('no threshold-shaped numeric literals in src/scoring/ (done-condition for 4.2)', () => {
  it('every numeric literal in src/scoring/**/*.ts is <= 10 (or absent — the directory may not exist yet)', async () => {
    const files = await fg('src/scoring/**/*.ts', { cwd: ROOT, absolute: true });
    const offenders: { file: string; literals: number[] }[] = [];
    for (const file of files) {
      const literals = findLargeLiterals(readFileSync(file, 'utf8'));
      if (literals.length > 0) offenders.push({ file, literals });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });
});
