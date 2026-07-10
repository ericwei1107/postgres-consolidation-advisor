import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DetectorContext } from '../src/detectors/types.js';
import { olapPresenceSignals } from '../src/signals/olapPresenceSignals.js';
import { traversalShape } from '../src/signals/traversalShape.js';

function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctxFor(repoPath: string): DetectorContext {
  return { repoPath, config: DEFAULT_CONFIG, addWarning: () => {} };
}

describe('traversalShape (done-conditions for 4.3, §1.8 / [A6])', () => {
  it('detects the variable-length Cypher marker (*1..) in a matched file', () => {
    const repo = tempRepo('pa-traversal-signal-');
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'graph.ts'),
      "const q = 'MATCH (a)-[:KNOWS*1..]->(b) RETURN b';\n",
    );
    const usage = [
      { storeId: 'neo4j:x', command: 'run', kind: 'call-site' as const, file: 'src/graph.ts', line: 1, excerpt: 'session.run(q)' },
    ];
    const signal = traversalShape('neo4j:x', usage, ctxFor(repo));
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('variable-length-traversal-count');
    expect(signal!.observability).toBe('static');
    expect(signal!.value).toBe(1);
  });

  it('fixed-depth traversals (no *N.. marker) yield a real zero, not absence', () => {
    const repo = tempRepo('pa-traversal-signal-');
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'graph.ts'),
      "const q = 'MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN c';\n",
    );
    const usage = [
      { storeId: 'neo4j:x', command: 'run', kind: 'call-site' as const, file: 'src/graph.ts', line: 1, excerpt: 'session.run(q)' },
    ];
    const signal = traversalShape('neo4j:x', usage, ctxFor(repo));
    expect(signal!.value).toBe(0);
  });

  it('signal absent: no usage evidence for this store at all -> null', () => {
    const repo = tempRepo('pa-traversal-signal-');
    expect(traversalShape('neo4j:x', [], ctxFor(repo))).toBeNull();
  });

  it('a /*...*/ block comment does not count as a variable-length marker', () => {
    const repo = tempRepo('pa-traversal-signal-');
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'graph.ts'),
      ["/*...*/", "const q = 'MATCH (a)-[:KNOWS]->(b) RETURN b';"].join('\n'),
    );
    const usage = [
      { storeId: 'neo4j:x', command: 'run', kind: 'call-site' as const, file: 'src/graph.ts', line: 2, excerpt: 'session.run(q)' },
    ];
    const signal = traversalShape('neo4j:x', usage, ctxFor(repo));
    // Without comment stripping this reads 1 and wrongly fires the
    // variable-length keep gate (graph.variable-length-or-gds-gate).
    expect(signal!.value).toBe(0);
  });
});

describe('olapPresenceSignals (done-conditions for 4.3, §1.7)', () => {
  it('counts dbt model .sql files when dbt_project.yml is present', async () => {
    const repo = tempRepo('pa-olap-signal-');
    writeFileSync(join(repo, 'dbt_project.yml'), "name: 'analytics'\n");
    mkdirSync(join(repo, 'models', 'marts'), { recursive: true });
    writeFileSync(join(repo, 'models', 'marts', 'orders.sql'), 'select 1');
    writeFileSync(join(repo, 'models', 'marts', 'customers.sql'), 'select 1');

    const signal = await olapPresenceSignals(ctxFor(repo));
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('dbt-model-count');
    expect(signal!.observability).toBe('estimated');
    expect(signal!.value).toBe(2);
    expect(signal!.evidence.some((e) => e.excerpt.includes('dbt_project.yml'))).toBe(true);
  });

  it('a bigger dbt project reports a bigger count (400 models reads differently from 12)', async () => {
    const repo = tempRepo('pa-olap-signal-');
    writeFileSync(join(repo, 'dbt_project.yml'), "name: 'analytics'\n");
    mkdirSync(join(repo, 'models'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, 'models', `model_${i}.sql`), 'select 1');

    const signal = await olapPresenceSignals(ctxFor(repo));
    expect(signal!.value).toBe(5);
  });

  it('signal absent: no dbt_project.yml anywhere in the repo -> null', async () => {
    const repo = tempRepo('pa-olap-signal-');
    writeFileSync(join(repo, 'README.md'), '# nothing here\n');
    expect(await olapPresenceSignals(ctxFor(repo))).toBeNull();
  });
});
