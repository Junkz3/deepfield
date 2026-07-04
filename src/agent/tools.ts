// Workspace tool operations. The agent is not WIRED to any tool: the
// workspace exposes a registry of ops, the model READS the registry inside
// the diagnose call and REQUESTS the ops it needs (same zero-extra-call
// pattern as agent routing). Every op reduces to two generic behaviors -
// lookup = a targeted search over the same corpus, capture = the user
// reports a real-world value - so the calibration model WRITES a vertical's
// ops, and the shipped repair preset is just data below. Nothing simulated:
// a lookup answers with real pages of the workspace, or says it found none.
import type { Page } from './types';

/** What one op execution hands back: a line for the timeline, plus the
 *  pages a lookup located - the loop turns those into timeline citations. */
export interface ToolRun { summary: string; pages?: Page[] }

export type OpKind = 'lookup' | 'capture';

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

/** A calibrated op as the calibration model writes it - pure data. It
 *  becomes a real WorkspaceTool through opFromSpec. */
export interface OpSpec {
  id: string;
  label: string;
  kind: OpKind;
  cue: string;
  query?: string;
}

/** Materialize an op spec. Two generic runners cover every vertical:
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

/** The repair preset: the same generic ops the calibration writes for any
 *  hands-on vertical, shipped as data so the default workspace boots with
 *  them without a calibration call. Ids and cues are load-bearing: the
 *  verdict prompt offer built from them is byte-identical to the tuned
 *  sentence the repair suite passed on (locked by test). */
export const TOOL_REGISTRY: WorkspaceTool[] = [
  opFromSpec({
    id: 'part_lookup',
    label: 'Parts pages lookup',
    kind: 'lookup',
    query: 'replacement parts list part number catalog',
    cue: 'with args.component when one replaceable component is the prime suspect',
  }),
  opFromSpec({
    id: 'safety_notes',
    label: 'Safety notes lookup',
    kind: 'lookup',
    query: 'safety warning caution notice',
    cue: 'with args.operation before hands-on work',
  }),
  opFromSpec({
    id: 'measurement_check',
    label: 'Measurement capture',
    kind: 'capture',
    cue: 'with args.component when a reading would decide',
  }),
];

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
