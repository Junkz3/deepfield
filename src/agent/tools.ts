// Workspace tool operations. The agent is not WIRED to any tool: the
// workspace exposes a registry of ops, the model READS the registry inside
// the diagnose call and REQUESTS the ops it needs (same zero-extra-call
// pattern as agent routing). Verticals differ only by which ops they load.
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

/** What one op execution hands back: a line for the timeline, plus typed
 *  payloads the UI knows how to render (parts table, safety block). */
export interface ToolRun { summary: string; part?: PartLine; safety?: SafetyInfo }

export interface WorkspaceTool {
  id: string;
  label: string;
  /** One line the MODEL reads: what the op does and when to request it. */
  hint: string;
  run(args: Record<string, string>, ctx: { device: string; component: string }): Promise<ToolRun>;
}

/** Known part refs by component key - demo catalog scope. */
const PART_FOR: Record<string, string> = {
  'heating element': 'W10518394',
  thermistor: 'WPW10352973',
};

export const TOOL_REGISTRY: WorkspaceTool[] = [
  {
    id: 'part_lookup',
    label: 'Parts stock lookup',
    hint: 'checks stock and lead time for a replacement part; request it whenever you conclude a specific replaceable component is faulty; args {"component": string}',
    async run(args, ctx) {
      const component = (args.component ?? ctx.component).toLowerCase();
      const ref = PART_FOR[component.trim()]
        ?? (component.includes('heat') ? PART_FOR['heating element'] : component.includes('therm') ? PART_FOR.thermistor : undefined);
      const part = ref
        ? await getPart(ref)
        : { ref: 'OEM', name: `${args.component ?? ctx.component} (source via OEM parts catalog)`, inStock: false, leadDays: undefined };
      return { summary: `${part.name}: ${part.inStock ? 'in stock' : part.leadDays ? `lead time ${part.leadDays}d` : 'order from OEM'}`, part };
    },
  },
  {
    id: 'safety_notes',
    label: 'Safety notes',
    hint: 'returns the safety notices for a hands-on operation; request it before any physical intervention; args {"operation": string}',
    async run(args, ctx) {
      const s = await checkSafety(
        `${ctx.device.toLowerCase().includes('hmmwv') || ctx.device.toLowerCase().includes('vehicle') ? 'vehicle: ' : ''}${args.operation ?? `replace ${ctx.component}`}`,
      );
      return { summary: `${s.lines.length} safety note(s) attached`, safety: s };
    },
  },
  {
    id: 'measurement_check',
    label: 'Measurement capture',
    hint: 'the technician measures a component and reports the value next turn; request it when a reading would confirm or clear your hypothesis; args {"component": string}',
    async run(args, ctx) {
      return { summary: `Waiting for the technician's ${args.component ?? ctx.component} reading` };
    },
  },
];

// Which ops this workspace exposes. Physical (repair) workspaces load the
// full registry by default; answer-mode workspaces load none. The Studio
// lets the user curate the list at creation time.
let ACTIVE_TOOL_IDS: string[] = TOOL_REGISTRY.map((t) => t.id);

export function setWorkspaceTools(ids: string[]): void {
  ACTIVE_TOOL_IDS = ids;
}

export function activeTools(): WorkspaceTool[] {
  return TOOL_REGISTRY.filter((t) => ACTIVE_TOOL_IDS.includes(t.id));
}
