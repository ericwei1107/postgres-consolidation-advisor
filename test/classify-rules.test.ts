import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { classifyStores } from '../src/classify/rules.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DetectedStore, Evidence } from '../src/types.js';
import type { UsageEvidence } from '../src/usage/harvester.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function store(product: string, evidence: Evidence[] = []): DetectedStore {
  return { id: `${product}:default`, product, category: ['unknown'], evidence };
}

function calls(product: string, commands: string[]): UsageEvidence[] {
  return commands.map((command, index) => ({
    storeId: `${product}:default`,
    command,
    kind: 'call-site',
    file: 'app.ts',
    line: index + 1,
    excerpt: `client.${command}()`,
  }));
}

const dependency = (library: string): Evidence => ({
  kind: 'dependency',
  file: 'package.json',
  line: 1,
  excerpt: `"${library}": "1.0.0"`,
});

describe('rule-based role classifier (Stage 3.2)', () => {
  it.each([
    {
      name: 'Redis cache mix at the 90% threshold',
      product: 'redis',
      evidence: [],
      commands: ['get', 'get', 'get', 'set', 'set', 'expire', 'expire', 'del', 'zrange', 'publish'],
      expected: [['cache', 'high']],
    },
    {
      name: 'Redis below cache threshold without a queue signal',
      product: 'redis',
      evidence: [],
      commands: ['get', 'get', 'get', 'set', 'set', 'expire', 'expire', 'del', 'publish', 'publish'],
      expected: [['unknown', 'low']],
    },
    {
      name: 'BullMQ dependency is a high-confidence queue',
      product: 'redis',
      evidence: [dependency('bullmq')],
      commands: [],
      expected: [['queue', 'high']],
    },
    {
      name: 'Bull dependency is a high-confidence queue',
      product: 'redis',
      evidence: [dependency('bull')],
      commands: [],
      expected: [['queue', 'high']],
    },
    {
      name: 'Celery dependency is a high-confidence queue',
      product: 'redis',
      evidence: [dependency('celery')],
      commands: [],
      expected: [['queue', 'high']],
    },
    {
      name: 'mixed Redis cache and BullMQ queue gets both roles',
      product: 'redis',
      evidence: [dependency('bullmq')],
      commands: ['get', 'set', 'expire'],
      expected: [['cache', 'medium'], ['queue', 'high']],
    },
    {
      name: 'Queue constructor usage is a high-confidence queue',
      product: 'redis',
      evidence: [],
      commands: ['Queue'],
      expected: [['queue', 'high']],
    },
    { name: 'Pinecone is a vector store', product: 'pinecone', evidence: [], commands: ['query'], expected: [['vector', 'high']] },
    { name: 'Weaviate is a vector store', product: 'weaviate', evidence: [], commands: [], expected: [['vector', 'high']] },
    { name: 'MongoDB is a document store', product: 'mongodb', evidence: [], commands: ['find'], expected: [['document', 'high']] },
    { name: 'Elasticsearch is a search store', product: 'elasticsearch', evidence: [], commands: ['search'], expected: [['search', 'high']] },
    { name: 'unmapped products remain unknown', product: 'minio', evidence: [], commands: [], expected: [['unknown', 'low']] },
  ])('$name', ({ product, evidence, commands, expected }) => {
    const roles = classifyStores([store(product, evidence)], calls(product, commands));
    expect(roles.map((result) => [result.role, result.confidence])).toEqual(expected);
  });

  it('node-monolith Redis classifies as cache and queue with --no-ai', async () => {
    const result = await analyze({
      repoPath: join(FIXTURES_DIR, 'node-monolith'),
      config: DEFAULT_CONFIG,
      noAi: true,
    });
    expect(result.roles.filter((role) => role.storeId.startsWith('redis:')).map((role) => role.role).sort()).toEqual([
      'cache',
      'queue',
    ]);
  });

  it('python-service Redis classifies as a Celery queue with --no-ai', async () => {
    const result = await analyze({
      repoPath: join(FIXTURES_DIR, 'python-service'),
      config: DEFAULT_CONFIG,
      noAi: true,
    });
    expect(result.roles.filter((role) => role.storeId.startsWith('redis:'))).toMatchObject([
      { role: 'queue', confidence: 'high', classifiedBy: 'rule' },
    ]);
  });
});
