import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { renderTerminal } from '../src/report/terminal.js';
import type { AnalysisResult } from '../src/types.js';

const ROOT = join(__dirname, '..');
const FIXTURES = join(ROOT, 'fixtures');
const CLI = join(ROOT, 'src', 'cli.ts');

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;

async function analyzeFixture(name: string): Promise<AnalysisResult> {
  // --no-ai keeps the pipeline deterministic (no network) so snapshots are stable.
  return analyze({ repoPath: join(FIXTURES, name), config: DEFAULT_CONFIG, noAi: true });
}

describe('terminal report (PLAN.md 7.0)', () => {
  it('renders node-monolith for a pipe (badges, impact, next-action, no color)', async () => {
    const result = await analyzeFixture('node-monolith');
    expect(renderTerminal(result, { color: false })).toMatchSnapshot();
  });

  it('renders node-monolith for a TTY (same layout, ANSI-colored badges)', async () => {
    const result = await analyzeFixture('node-monolith');
    expect(renderTerminal(result, { color: true })).toMatchSnapshot();
  });

  it('renders the empty repo as a win state', async () => {
    const result = await analyzeFixture('empty');
    const out = renderTerminal(result, { color: false });
    expect(out).toContain('0 data stores detected');
    expect(out).toMatchSnapshot();
  });

  it('emits no ANSI codes when color is off', async () => {
    const result = await analyzeFixture('node-monolith');
    expect(renderTerminal(result, { color: false })).not.toMatch(ANSI);
  });

  it('emits ANSI codes when color is on, but the badge text is never color-only', async () => {
    const result = await analyzeFixture('node-monolith');
    const out = renderTerminal(result, { color: true });
    expect(out).toMatch(ANSI);
    expect(out).toContain('[CONSOLIDATE]');
  });

  // Done-condition: no ANSI on the wire when stdout is not a TTY. execFileSync
  // gives the child a piped (non-TTY) stdout, exercising the CLI's own color gate.
  it('CLI writes plain (ANSI-free) output to a piped stdout', () => {
    const stdout = execFileSync('npx', ['tsx', CLI, 'analyze', join(FIXTURES, 'node-monolith'), '--no-ai'], {
      encoding: 'utf8',
    });
    expect(stdout).not.toMatch(ANSI);
    expect(stdout).toContain('[CONSOLIDATE]');
    expect(stdout).toContain('into Postgres.');
  });
});
