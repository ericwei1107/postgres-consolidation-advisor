import { describe, expect, it } from 'vitest';
import { MAPPED_CATEGORIES, loadMappings, mappingsFor, type MappingOption } from '../src/rules.js';
import type { StoreCategory } from '../src/types.js';

const DATA_MIGRATION_VALUES = new Set(['copy', 'dual-write', 'none']);

function assertComplete(category: StoreCategory, option: MappingOption): void {
  expect(option.name, `${category}: name`).toBeTruthy();
  expect(option.label, `${category}/${option.name}: label`).toBeTruthy();
  expect(option.extensionRequired, `${category}/${option.name}: extensionRequired`).toBeDefined();
  expect(typeof option.extensionRequired.required, `${category}/${option.name}: extensionRequired.required`).toBe(
    'boolean',
  );
  if (option.extensionRequired.required) {
    expect(option.extensionRequired.name, `${category}/${option.name}: extensionRequired.name`).toBeTruthy();
  }
  expect(option.maturity, `${category}/${option.name}: maturity`).toBeTruthy();
  expect(option.operationalCost, `${category}/${option.name}: operationalCost`).toBeTruthy();
  expect(DATA_MIGRATION_VALUES.has(option.dataMigration), `${category}/${option.name}: dataMigration`).toBe(true);
  expect(option.rollback, `${category}/${option.name}: rollback`).toBeTruthy();
}

describe('rules/mappings.yaml (done-conditions for 4.1)', () => {
  it('validates on load', () => {
    expect(() => loadMappings()).not.toThrow();
  });

  it.each(MAPPED_CATEGORIES)('%s has at least one complete mapping option', (category) => {
    const options = mappingsFor(category);
    expect(options.length, category).toBeGreaterThanOrEqual(1);
    for (const option of options) assertComplete(category, option);
  });

  it('option names are unique within a category', () => {
    for (const category of MAPPED_CATEGORIES) {
      const names = mappingsFor(category).map((o) => o.name);
      expect(new Set(names).size, category).toBe(names.length);
    }
  });

  it('relational and unknown carry no migration mapping (they are not consolidation targets)', () => {
    expect(mappingsFor('relational')).toEqual([]);
    expect(mappingsFor('unknown')).toEqual([]);
  });

  it('matches the exact option set named in PLAN.md 4.1', () => {
    const names = (category: StoreCategory) => mappingsFor(category).map((o) => o.name);
    expect(names('cache')).toEqual(['unlogged-table', 'materialized-views']);
    expect(names('queue')).toEqual(['pgmq', 'skip-locked', 'pgflow']);
    expect(names('search')).toEqual(['tsvector-pg-trgm', 'paradedb-pg-search']);
    expect(names('document')).toEqual(['jsonb', 'ferretdb']);
    expect(names('vector')).toEqual(['pgvector', 'pgvectorscale']);
    expect(names('timeseries')).toEqual(['timescaledb', 'pg-partman-brin']);
    expect(names('olap')).toEqual(['pg-analytics', 'duckdb-attached']);
    expect(names('graph')).toEqual(['recursive-ctes', 'apache-age']);
    expect(names('geospatial')).toEqual(['postgis']);
  });

  it('caches the parsed result across calls (same Map instance)', () => {
    expect(loadMappings()).toBe(loadMappings());
  });
});
