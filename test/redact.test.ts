import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactLine, redactValue, redactedAssignment } from '../src/redact.js';
import { runPipeline } from './helpers/pipeline.js';

describe('redaction (PLAN.md 2.3 rule — no raw secret ever reaches Evidence)', () => {
  it('strips credentials from a URL value, keeping host:port', () => {
    expect(redactValue('REDIS_URL', 'redis://admin:hunter2@prod:6379/0')).toBe(
      'redis://<redacted>@prod:6379/0',
    );
  });

  it('drops the whole value for secret-named variables', () => {
    expect(redactedAssignment('API_TOKEN', 'abc123')).toBe('API_TOKEN=<redacted>');
  });

  it('redactLine scrubs credentials inside URLs embedded anywhere in a source line', () => {
    expect(redactLine("const c = new Redis('redis://admin:SuperSecret@prod:6379');")).toBe(
      "const c = new Redis('redis://<redacted>@prod:6379');",
    );
    expect(redactLine("client.set('dsn', 'mongodb://u:p@h:27017'); other('amqp://x:y@q')")).toBe(
      "client.set('dsn', 'mongodb://<redacted>@h:27017'); other('amqp://<redacted>@q')",
    );
  });

  it('redactLine leaves credential-free lines untouched', () => {
    expect(redactLine("await redis.get('user:42');")).toBe("await redis.get('user:42');");
  });

  it('call-site Evidence excerpts never carry credentials from a hardcoded URL', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pa-redact-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { ioredis: '^5.4.1' } }),
    );
    writeFileSync(
      join(repo, 'src', 'app.js'),
      [
        "import Redis from 'ioredis';",
        'const client = new Redis();',
        "client.set('upstream-dsn', 'redis://admin:SuperSecret123@prod-redis:6379');",
      ].join('\n'),
    );

    const { stores, usage } = await runPipeline(repo);
    const everything = JSON.stringify({ stores, usage });
    expect(everything).not.toContain('SuperSecret123');
    expect(everything).toContain('redis://<redacted>@prod-redis:6379');
  });
});
