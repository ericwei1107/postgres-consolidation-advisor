import { execFileSync, spawnSync, type ExecFileSyncOptions } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', 'src', 'cli.ts');
const FIXTURE_EMPTY = join(__dirname, '..', 'fixtures', 'empty');

function run(args: string[], options: ExecFileSyncOptions = {}) {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], {
      encoding: 'utf8',
      ...options,
    }) as string;
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { code: err.status ?? -1, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

function runCapture(args: string[]) {
  const result = spawnSync('npx', ['tsx', CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('cli smoke (done-conditions for 1.1)', () => {
  it('analyze fixtures/empty exits 0 with "0 data stores detected"', () => {
    const { code, stdout } = run(['analyze', FIXTURE_EMPTY]);
    expect(code).toBe(0);
    expect(stdout).toContain('0 data stores detected');
  });

  it('bare invocation (no subcommand) defaults to analyze .', () => {
    const { code, stdout } = run([], { cwd: FIXTURE_EMPTY });
    expect(code).toBe(0);
    expect(stdout).toContain('0 data stores detected');
  });

  it('--format json emits a schema-valid artifact on stdout with nothing else', () => {
    const { code, stdout } = run(['analyze', FIXTURE_EMPTY, '--format', 'json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.stores).toEqual([]);
  });

  it('--format md renders the empty win-state copy', () => {
    const { code, stdout } = run(['analyze', FIXTURE_EMPTY, '--format', 'md']);
    expect(code).toBe(0);
    expect(stdout).toContain('Nothing to consolidate');
  });

  it('--fail-on with an unknown condition exits 2 with problem+fix+docs', () => {
    const { code, stderr } = run(['analyze', FIXTURE_EMPTY, '--fail-on', 'bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain('invalid --fail-on condition');
    expect(stderr).toContain('fix:');
    expect(stderr).toContain('docs:');
  });

  it('--fail-on new-store without a lockfile exits 2 pointing at --write-lock', () => {
    const { code, stderr } = run(['analyze', FIXTURE_EMPTY, '--fail-on', 'new-store']);
    expect(code).toBe(2);
    expect(stderr).toContain('--write-lock');
  });

  it('--fail-on keep,borderline passes on an empty repo (comma list parses)', () => {
    const { code } = run(['analyze', FIXTURE_EMPTY, '--fail-on', 'keep,borderline']);
    expect(code).toBe(0);
  });

  it('--max-files rejects a non-integer limit', () => {
    const { code, stderr } = run(['analyze', FIXTURE_EMPTY, '--max-files', 'many']);
    expect(code).toBe(2);
    expect(stderr).toContain('invalid --max-files value');
  });

  it('--verbose renders harvester skip warnings on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-smoke-'));
    writeFileSync(join(dir, 'bundle.ts'), `import Redis from 'ioredis';\n${'x'.repeat(5_001)}`);
    const { code, stderr } = runCapture(['analyze', dir, '--verbose']);
    expect(code).toBe(0);
    expect(stderr).toContain('usage harvester skipped bundle.ts');
  });

  it('nonexistent path exits 2 with the error convention', () => {
    const { code, stderr } = run(['analyze', '/definitely/not/a/real/path']);
    expect(code).toBe(2);
    expect(stderr).toContain('error:');
    expect(stderr).toContain('fix:');
  });

  it('explain is a stub that exits 2 and names Stage 4.2', () => {
    const { code, stderr } = run(['explain', 'queue.est-peak-msgs-sec']);
    expect(code).toBe(2);
    expect(stderr).toContain('4.2');
  });

  it('invalid .postgres-advisor.yaml hard-fails with named field and shape example', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-config-'));
    writeFileSync(join(dir, '.postgres-advisor.yaml'), 'suppress: notalist\n');
    const { code, stderr } = run(['analyze', dir]);
    expect(code).toBe(2);
    expect(stderr).toContain('suppress');
    expect(stderr).toContain('Valid shape');
  });
});
