import { describe, expect, it } from 'vitest';
import { explainThreshold, listThresholds } from '../src/explain.js';
import { AdvisorError } from '../src/errors.js';

describe('explain (golden-file done-conditions for 4.2)', () => {
  it('explain --list golden file: groups every id by category', () => {
    expect(listThresholds()).toMatchSnapshot();
  });

  it('explain queue.est-peak-msgs-sec golden file: value, comparison, sources+grade, assumption, failure mode', () => {
    const rendered = explainThreshold('queue.est-peak-msgs-sec');
    expect(rendered).toMatchSnapshot();
    expect(rendered).toContain('**Category:** queue');
    expect(rendered).toContain('independent');
    expect(rendered).toContain('vendor');
    expect(rendered).toContain('**Failure mode (keep):**');
  });

  it('explain of a gate threshold golden file: qualitative gate rendering', () => {
    expect(explainThreshold('queue.streaming-semantics-gate')).toMatchSnapshot();
  });

  it('explain of a reference threshold golden file: value + unit, no bands/gate', () => {
    expect(explainThreshold('cache.postgres-unlogged-read-throughput')).toMatchSnapshot();
  });

  it('unknown threshold id raises AdvisorError pointing at --list', () => {
    expect(() => explainThreshold('nope.not-real')).toThrow(AdvisorError);
    try {
      explainThreshold('nope.not-real');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AdvisorError);
      expect((e as AdvisorError).format()).toContain('explain --list');
    }
  });

  it('threshold_overrides annotation: overridden value shows "(user-overridden; cited source no longer applies)"-style note', () => {
    const rendered = explainThreshold('queue.est-peak-msgs-sec', { 'queue.est-peak-msgs-sec': 2000 });
    expect(rendered).toContain('value < 2,000');
    expect(rendered).toContain('user-overridden to 2,000 (cited source no longer applies)');
    expect(rendered).not.toEqual(explainThreshold('queue.est-peak-msgs-sec'));
  });

  it('an override on a reference threshold replaces its value', () => {
    const rendered = explainThreshold('cache.postgres-unlogged-read-throughput', {
      'cache.postgres-unlogged-read-throughput': 20000,
    });
    expect(rendered).toContain('20,000');
    expect(rendered).toContain('user-overridden to 20,000');
  });

  it('an override on a gate threshold is a documented no-op (gates have no numeric value)', () => {
    const rendered = explainThreshold('queue.streaming-semantics-gate', {
      'queue.streaming-semantics-gate': 5,
    });
    expect(rendered).toContain('no single overridable value');
    expect(rendered).not.toContain('user-overridden');
  });

  it('an override for an unrelated id has no effect', () => {
    expect(explainThreshold('queue.est-peak-msgs-sec', { 'cache.est-ops-per-sec': 1 })).toEqual(
      explainThreshold('queue.est-peak-msgs-sec'),
    );
  });
});
