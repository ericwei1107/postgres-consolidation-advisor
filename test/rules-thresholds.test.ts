import { describe, expect, it } from 'vitest';
import { MAPPED_CATEGORIES } from '../src/rules.js';
import {
  loadConstants,
  loadScoringConfig,
  loadThresholds,
  thresholdByCategoryVariable,
  thresholdById,
  thresholdsByCategory,
} from '../src/rules.js';
import type { ThresholdRule } from '../src/rules.js';

const SOURCE_GRADES = new Set(['vendor', 'independent', 'reproduced']);
const OBSERVABILITY_VALUES = new Set(['static', 'estimated', 'live-only']);
const LIVE_SOURCE_VALUES = new Set(['pg-stats', 'incumbent-only', 'none']);

function assertCommon(rule: ThresholdRule): void {
  expect(rule.id, 'id').toBeTruthy();
  expect(rule.id, 'id format').toBe(`${rule.category}.${rule.variable}`);
  expect(OBSERVABILITY_VALUES.has(rule.observability), `${rule.id}: observability`).toBe(true);
  expect(LIVE_SOURCE_VALUES.has(rule.liveSource), `${rule.id}: liveSource`).toBe(true);
  for (const source of rule.sources) {
    expect(SOURCE_GRADES.has(source.grade), `${rule.id}: source grade`).toBe(true);
    expect(source.url, `${rule.id}: source url`).toBeTruthy();
  }
  if (rule.assumptionId) expect(rule.assumptionId, `${rule.id}: assumptionId`).toMatch(/^A\d+$/);
}

describe('rules/thresholds.yaml (done-conditions for 4.2)', () => {
  it('validates on load', () => {
    expect(() => loadThresholds()).not.toThrow();
  });

  it('every threshold is reachable by id AND by (category, variable)', () => {
    for (const rule of loadThresholds().values()) {
      expect(thresholdById(rule.id), rule.id).toEqual(rule);
      expect(thresholdByCategoryVariable(rule.category, rule.variable), rule.id).toEqual(rule);
    }
  });

  it('thresholdsByCategory returns exactly the entries for that category', () => {
    for (const category of MAPPED_CATEGORIES) {
      const byCategory = thresholdsByCategory(category);
      for (const rule of byCategory) expect(rule.category).toBe(category);
      const expectedCount = [...loadThresholds().values()].filter((r) => r.category === category).length;
      expect(byCategory.length).toBe(expectedCount);
    }
  });

  it('every mapped category has at least one threshold', () => {
    for (const category of MAPPED_CATEGORIES) {
      expect(thresholdsByCategory(category).length, category).toBeGreaterThanOrEqual(1);
    }
  });

  it('relational and unknown have no thresholds (not consolidation targets)', () => {
    expect(thresholdsByCategory('relational')).toEqual([]);
    expect(thresholdsByCategory('unknown')).toEqual([]);
  });

  it('every threshold entry is well-formed', () => {
    for (const rule of loadThresholds().values()) assertCommon(rule);
  });

  it('bands thresholds have >=1 band with a valid decision and a bounded range', () => {
    for (const rule of loadThresholds().values()) {
      if (rule.comparison !== 'bands') continue;
      expect(rule.bands.length, rule.id).toBeGreaterThanOrEqual(1);
      for (const band of rule.bands) {
        expect(['consolidate', 'keep', 'borderline'], `${rule.id} band decision`).toContain(band.decision);
        expect(band.min !== undefined || band.max !== undefined, `${rule.id} band has a bound`).toBe(true);
      }
    }
  });

  it('gate thresholds have >=1 signal and a valid gate_decision', () => {
    for (const rule of loadThresholds().values()) {
      if (rule.comparison !== 'gate') continue;
      expect(rule.gateSignals.length, rule.id).toBeGreaterThanOrEqual(1);
      expect(['consolidate', 'keep'], rule.id).toContain(rule.gateDecision);
    }
  });

  it('mapping_option references (on bands/gate entries) name a real 4.1 mapping option', async () => {
    const { mappingsFor } = await import('../src/rules.js');
    for (const rule of loadThresholds().values()) {
      const optionNames =
        rule.comparison === 'bands'
          ? rule.bands.map((b) => b.mappingOption).filter((v): v is string => v !== undefined)
          : rule.comparison === 'gate' && rule.mappingOption
            ? [rule.mappingOption]
            : [];
      for (const optionName of optionNames) {
        const names = mappingsFor(rule.category).map((o) => o.name);
        expect(names, `${rule.id} mapping_option \`${optionName}\``).toContain(optionName);
      }
    }
  });

  it('every A1-A9 assumption from PLAN.md is referenced at least once', () => {
    const referenced = new Set<string>();
    for (const rule of loadThresholds().values()) if (rule.assumptionId) referenced.add(rule.assumptionId);
    for (const constant of loadConstants().values()) if (constant.assumptionId) referenced.add(constant.assumptionId);
    for (let n = 1; n <= 9; n++) {
      expect(referenced.has(`A${n}`), `A${n} referenced`).toBe(true);
    }
  });

  it('loads scoring constants (fitScore base/gate/weight) as data, not TS literals', () => {
    const scoring = loadScoringConfig();
    expect(scoring.baseScore).toBe(100);
    expect(scoring.qualitativeGateMaxFitScore).toBe(30);
    expect(scoring.defaultWeight).toBe(1);
  });

  it('loads general-estimation-model constants (A1, A8)', () => {
    const constants = loadConstants();
    const jobsPerSlot = constants.get('general.est-peak-jobs-per-worker-slot');
    expect(jobsPerSlot?.value).toEqual({ min: 0.1, max: 10 });
    expect(jobsPerSlot?.assumptionId).toBe('A1');

    const bytesPerField = constants.get('document.avg-bytes-per-field');
    expect(bytesPerField?.value).toBe(30);
    expect(bytesPerField?.assumptionId).toBe('A8');
  });

  it('caches the parsed result across calls (same Map instance)', () => {
    expect(loadThresholds()).toBe(loadThresholds());
  });
});
