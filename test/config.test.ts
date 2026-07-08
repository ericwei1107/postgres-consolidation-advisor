import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { AdvisorError } from '../src/errors.js';

function tempRepo(configYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-cfg-'));
  if (configYaml !== undefined) writeFileSync(join(dir, '.postgres-advisor.yaml'), configYaml);
  return dir;
}

describe('.postgres-advisor.yaml loader', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig(tempRepo())).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for an empty file', () => {
    expect(loadConfig(tempRepo(''))).toEqual(DEFAULT_CONFIG);
  });

  it('parses a full valid config', () => {
    const cfg = loadConfig(
      tempRepo(
        [
          'suppress: [redis-cache]',
          'ignore: ["examples/**"]',
          'paths: ["services/api/**"]',
          'threshold_overrides:',
          '  queue.est-peak-msgs-sec: 2000',
        ].join('\n'),
      ),
    );
    expect(cfg.suppress).toEqual(['redis-cache']);
    expect(cfg.ignore).toEqual(['examples/**']);
    expect(cfg.paths).toEqual(['services/api/**']);
    expect(cfg.threshold_overrides['queue.est-peak-msgs-sec']).toBe(2000);
  });

  it('hard-fails on a wrong-typed field, naming it', () => {
    expect(() => loadConfig(tempRepo('suppress: notalist'))).toThrowError(AdvisorError);
    try {
      loadConfig(tempRepo('suppress: notalist'));
    } catch (e) {
      const err = e as AdvisorError;
      expect(err.problem).toContain('suppress');
      expect(err.fix).toContain('Valid shape');
    }
  });

  it('hard-fails on unknown keys (strict schema — typos must not silently no-op)', () => {
    expect(() => loadConfig(tempRepo('supress: [redis]'))).toThrowError(AdvisorError);
  });

  it('hard-fails on invalid YAML syntax', () => {
    expect(() => loadConfig(tempRepo('suppress: [unclosed'))).toThrowError(AdvisorError);
  });
});
