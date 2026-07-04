import type { ConfidenceInput, GuidedStep } from './types';

const clamp = (v: number) => Math.min(0.95, Math.max(0.05, v));

export function computeConfidence(i: ConfidenceInput): { value: number; reason: string } {
  let v = 0.5;
  const parts: string[] = [];
  if (i.exactCodeMatch) { v += 0.2; parts.push('exact error-code match'); }
  const corr = Math.min(i.corroboratingCitations, 2);
  if (corr > 0) { v += 0.1 * corr; parts.push(`${corr} corroborating citation${corr > 1 ? 's' : ''}`); }
  if (i.requiredPageMissing) { v -= 0.3; parts.push('a required page is missing'); }
  if (parts.length === 0) parts.push('baseline: no corroboration yet');
  return { value: clamp(v), reason: parts.join(', ') };
}

export function workOrderConfidence(steps: GuidedStep[]): { value: number; reason: string } {
  if (steps.length === 0) return { value: 0.05, reason: 'no steps completed' };
  const min = steps.reduce((a, s) => (s.confidence < a.confidence ? s : a));
  return { value: min.confidence, reason: min.confidenceReason };
}
