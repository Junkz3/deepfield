import { describe, expect, it } from 'vitest';
import { computeConfidence, workOrderConfidence } from './confidence';
import type { GuidedStep } from './types';

describe('computeConfidence (spec §6 rubric)', () => {
  it('hero case: exact code match + 2 corroborating citations = 0.9', () => {
    const r = computeConfidence({ exactCodeMatch: true, corroboratingCitations: 2, requiredPageMissing: false });
    expect(r.value).toBeCloseTo(0.9, 5);
    expect(r.reason).toMatch(/exact/i);
  });
  it('caps corroborating citations at 2', () => {
    expect(computeConfidence({ exactCodeMatch: true, corroboratingCitations: 5, requiredPageMissing: false }).value).toBeCloseTo(0.9, 5);
  });
  it('missing required page drops to 0.2 and says so', () => {
    const r = computeConfidence({ exactCodeMatch: false, corroboratingCitations: 0, requiredPageMissing: true });
    expect(r.value).toBeCloseTo(0.2, 5);
    expect(r.reason).toMatch(/missing/i);
  });
  it('clamps to [0.05, 0.95]', () => {
    expect(computeConfidence({ exactCodeMatch: true, corroboratingCitations: 2, requiredPageMissing: false }).value).toBeLessThanOrEqual(0.95);
    expect(computeConfidence({ exactCodeMatch: false, corroboratingCitations: 0, requiredPageMissing: true }).value).toBeGreaterThanOrEqual(0.05);
  });
});

describe('workOrderConfidence', () => {
  it('is the min of step confidences with its reason', () => {
    const steps = [
      { confidence: 0.9, confidenceReason: 'strong' },
      { confidence: 0.6, confidenceReason: 'wiring page missing' },
    ] as GuidedStep[];
    const r = workOrderConfidence(steps);
    expect(r.value).toBe(0.6);
    expect(r.reason).toBe('wiring page missing');
  });
});
