import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { DetectedStoreSchema, type DetectedStore } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const InventorySchema = z.array(DetectedStoreSchema);

function fixtureDirs(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function loadInventory(fixture: string): DetectedStore[] {
  const raw = readFileSync(join(FIXTURES_DIR, fixture, 'expected-inventory.json'), 'utf8');
  return InventorySchema.parse(JSON.parse(raw));
}

describe('fixtures (done-conditions for 1.2)', () => {
  const dirs = fixtureDirs();

  it('every fixture ships an expected-inventory.json', () => {
    for (const dir of dirs) {
      expect(existsSync(join(FIXTURES_DIR, dir, 'expected-inventory.json')), dir).toBe(true);
    }
  });

  it.each(dirs)('%s: expected-inventory.json is a schema-valid DetectedStore[]', (dir) => {
    expect(() => loadInventory(dir)).not.toThrow();
  });

  it.each(dirs)('%s: store ids are unique and no Postgres is inventoried', (dir) => {
    const stores = loadInventory(dir);
    const ids = stores.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(stores.some((s) => /postgres|postgresql/i.test(s.product))).toBe(false);
  });

  it.each(dirs)('%s: every store has a product and >=1 evidence entry', (dir) => {
    for (const store of loadInventory(dir)) {
      expect(store.product.length, `${dir}:${store.id}`).toBeGreaterThan(0);
      expect(store.evidence.length, `${dir}:${store.id}`).toBeGreaterThan(0);
    }
  });

  it('empty fixture inventories nothing', () => {
    expect(loadInventory('empty')).toEqual([]);
  });

  it('node-monolith has one Redis serving both cache and queue roles', () => {
    const redis = loadInventory('node-monolith').find((s) => s.product === 'redis');
    expect(redis).toBeDefined();
    expect(redis?.category).toEqual(expect.arrayContaining(['cache', 'queue']));
  });

  it('edge-cases detects kafka from env alone (single env evidence)', () => {
    const kafka = loadInventory('edge-cases').find((s) => s.product === 'kafka');
    expect(kafka).toBeDefined();
    expect(kafka?.evidence).toHaveLength(1);
    expect(kafka?.evidence[0]?.kind).toBe('env');
  });
});
