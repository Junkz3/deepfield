import type { MeasurementVerdict, PartLine, SafetyInfo } from './types';
import parts from './fixtures/parts.json';
import safety from './fixtures/safety.json';
import specs from './fixtures/specs.json';

const PARTS = parts as Record<string, Omit<PartLine, 'ref'>>;
const SAFETY = safety as Record<string, SafetyInfo>;
const SPECS = specs as Record<string, { minOhms: number; maxOhms: number; suggestNext: string }>;

export async function getPart(ref: string): Promise<PartLine> {
  const p = PARTS[ref];
  return p ? { ref, ...p } : { ref, name: 'Unknown part (not in catalog)', inStock: false };
}

export async function checkSafety(operation: string): Promise<SafetyInfo> {
  return operation.toLowerCase().includes('vehicle') ? SAFETY.vehicle : SAFETY.default;
}

export async function checkMeasurement(component: string, valueOhms: number): Promise<MeasurementVerdict> {
  const spec = SPECS[component.toLowerCase()];
  if (!spec) return { withinSpec: false, specRange: 'n/a', verdict: `No spec on file for "${component}".` };
  const specRange = `${spec.minOhms}-${spec.maxOhms} ohms`;
  if (valueOhms >= spec.minOhms && valueOhms <= spec.maxOhms) {
    return {
      withinSpec: true, specRange,
      verdict: `${valueOhms} ohms is within spec (${specRange}) - ${component} is likely OK.`,
      suggestedComponent: spec.suggestNext,
    };
  }
  return { withinSpec: false, specRange, verdict: `${valueOhms} ohms is out of spec (${specRange}) - ${component} is suspect.` };
}
