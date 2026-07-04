// Workspace tool operations. The agent is not WIRED to any tool: the
// workspace exposes a registry of ops, the model READS the registry inside
// the diagnose call and REQUESTS the ops it needs (same zero-extra-call
// pattern as agent routing). Verticals differ only by which ops they load -
// and since ops reduce to two generic behaviors (lookup = a targeted search
// over the same corpus, capture = the user reports a real-world value), the
// calibration model can WRITE a vertical's ops instead of us shipping them.
import type { MeasurementVerdict, Page, PartLine, SafetyInfo } from './types';
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
 *  payloads the UI knows how to render (parts table, safety block, pages a
 *  lookup located - the loop turns those into timeline citations). */
export interface ToolRun { summary: string; part?: PartLine; safety?: SafetyInfo; pages?: Page[] }

/** The two behaviors every calibrated op reduces to; 'builtin' marks the
 *  shipped repair ops whose run() is hand-written against the demo catalog. */
export type OpKind = 'lookup' | 'capture' | 'builtin';

export interface WorkspaceTool {
  id: string;
  label: string;
  /** One line the USER reads in the Studio: what the op does. */
  hint: string;
  /** The clause the MODEL reads inside the verdict prompt, in the mold
   *  "with args.<name> when <situation>" - kept short on purpose: a verbose
   *  op section mid-prompt measurably degraded the diagnosis itself. */
  cue: string;
  kind: OpKind;
  /** lookup ops only: search keywords locating the pages this op reads. */
  query?: string;
  run(args: Record<string, string>, ctx: { device: string; component: string; pages?: Page[] }): Promise<ToolRun>;
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
    cue: 'with args.component when one replaceable component is the prime suspect',
    kind: 'builtin',
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
    cue: 'with args.operation before hands-on work',
    kind: 'builtin',
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
    cue: 'with args.component when a reading would decide',
    kind: 'capture',
    async run(args, ctx) {
      return { summary: `Waiting for the technician's ${args.component ?? ctx.component} reading` };
    },
  },
];

/** A calibrated op as the calibration model writes it - pure data. It
 *  becomes a real WorkspaceTool through opFromSpec. */
export interface OpSpec {
  id: string;
  label: string;
  kind: 'lookup' | 'capture';
  cue: string;
  query?: string;
}

/** Materialize a calibrated op. Two generic runners cover every vertical:
 *  lookup = keyword search over the workspace pages (text-side, an op is a
 *  side-quest and never pays the visual rerank), capture = the run only
 *  narrates that a real-world value is awaited from the user. */
export function opFromSpec(spec: OpSpec): WorkspaceTool {
  if (spec.kind === 'capture') {
    return {
      ...spec, hint: spec.cue,
      async run(args, ctx) {
        return { summary: `Waiting for the reported ${Object.values(args)[0] ?? ctx.component} value` };
      },
    };
  }
  return {
    ...spec, hint: spec.cue,
    async run(args, ctx) {
      const tokens = [...new Set(
        `${spec.query ?? ''} ${Object.values(args).join(' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2),
      )];
      const hits = (ctx.pages ?? [])
        .map((p) => ({ p, s: tokens.filter((t) => `${p.title ?? ''} ${p.text ?? ''}`.toLowerCase().includes(t)).length }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => x.p);
      return {
        summary: hits.length > 0
          ? `${hits.length} page(s) located: ${hits.map((p) => `${p.title ?? p.docId} p.${p.page}`).join('; ')}`
          : 'No matching page in this workspace',
        pages: hits,
      };
    },
  };
}

/** The op offer as the verdict prompt injects it. For the shipped registry
 *  this reproduces the historical sentence BYTE-IDENTICAL (locked by test):
 *  the repair prompt must not move when nothing about ops changed. */
export function opsPromptSection(ops: WorkspaceTool[]): string {
  if (ops.length === 0) return '';
  return ` After the diagnosis fields are set, request follow-up workspace operations in "tools" when they apply: ${ops.map((t) => `{"id":"${t.id}","args":{...}}`).join(', ')} (${ops.map((t) => `${t.id} ${t.cue}`).join('; ')}). Never let tool choice alter the diagnosis fields.`;
}

// Which ops this workspace exposes. Repair workspaces load the shipped
// registry by default; calibrated workspaces install what the calibration
// wrote; answer-mode workspaces load none. The Studio curates at creation.
let WORKSPACE_OPS: WorkspaceTool[] = TOOL_REGISTRY;
let ACTIVE_TOOL_IDS: string[] = TOOL_REGISTRY.map((t) => t.id);

/** Replace the workspace's op registry (all installed ops start active). */
export function installWorkspaceOps(ops: WorkspaceTool[]): void {
  WORKSPACE_OPS = ops;
  ACTIVE_TOOL_IDS = ops.map((t) => t.id);
}

/** Everything installed, active or not - the Studio lists this. */
export function workspaceOps(): WorkspaceTool[] {
  return WORKSPACE_OPS;
}

export function setWorkspaceTools(ids: string[]): void {
  ACTIVE_TOOL_IDS = ids;
}

export function activeTools(): WorkspaceTool[] {
  return WORKSPACE_OPS.filter((t) => ACTIVE_TOOL_IDS.includes(t.id));
}
