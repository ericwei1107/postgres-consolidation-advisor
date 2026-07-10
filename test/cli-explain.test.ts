import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

function run(args: string[], options: { cwd?: string } = {}) {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], { encoding: 'utf8', ...options }) as string;
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { code: err.status ?? -1, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

describe('postgres-advisor explain (CLI wiring, PLAN.md 4.2)', () => {
  it('explain --list exits 0 and lists ids by category', () => {
    const { code, stdout } = run(['explain', '--list']);
    expect(code).toBe(0);
    expect(stdout).toContain('## queue');
    expect(stdout).toContain('- queue.est-peak-msgs-sec');
  });

  it('explain <id> exits 0 with the threshold detail', () => {
    const { code, stdout } = run(['explain', 'queue.est-peak-msgs-sec']);
    expect(code).toBe(0);
    expect(stdout).toContain('## queue.est-peak-msgs-sec');
    expect(stdout).toContain('**Comparison:** range bands');
    expect(stdout).toContain('**Failure mode (keep):**');
  });

  it('explain with no id and no --list exits 2 with problem+fix+docs', () => {
    const { code, stderr } = run(['explain']);
    expect(code).toBe(2);
    expect(stderr).toContain('explain needs a threshold id');
    expect(stderr).toContain('fix:');
    expect(stderr).toContain('docs:');
  });

  it('explain <unknown-id> exits 2 pointing at --list', () => {
    const { code, stderr } = run(['explain', 'nope.not-real']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown threshold id');
    expect(stderr).toContain('explain --list');
  });

  it('threshold_overrides in .postgres-advisor.yaml renders the overridden annotation via --path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pa-explain-override-'));
    writeFileSync(
      join(repo, '.postgres-advisor.yaml'),
      'threshold_overrides:\n  queue.est-peak-msgs-sec: 2000\n',
    );
    const overridden = run(['explain', 'queue.est-peak-msgs-sec', '--path', repo]);
    expect(overridden.code).toBe(0);
    expect(overridden.stdout).toContain('user-overridden to 2,000 (cited source no longer applies)');

    const baseline = run(['explain', 'queue.est-peak-msgs-sec']);
    expect(baseline.stdout).not.toContain('user-overridden');
  });

  it('an invalid .postgres-advisor.yaml still hard-fails explain (same policy as analyze)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pa-explain-badconfig-'));
    writeFileSync(join(repo, '.postgres-advisor.yaml'), 'suppress: "not-an-array"\n');
    const { code, stderr } = run(['explain', 'queue.est-peak-msgs-sec', '--path', repo]);
    expect(code).toBe(2);
    expect(stderr).toContain('.postgres-advisor.yaml is invalid');
  });
});
