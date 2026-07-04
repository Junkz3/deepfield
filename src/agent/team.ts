// Agent teams: a workspace can run SEVERAL specialists over one corpus, and
// plan() routes each request to the best one. This module owns how teams are
// born: shipped presets, the model-written calibration (from the corpus plus
// an optional one-line intent), and the deterministic fallback.
// Self-contained on purpose: it must build without the Studio calibration
// module, so the keyword table lives here too.
import type { AgentSpec, WorkflowProfile } from './workflow';
import { PROFILES } from './workflow';
import type { OpSpec, WorkspaceTool } from './tools';
import { TOOL_REGISTRY, opFromSpec } from './tools';

export interface TeamCalibrationInput {
  workspaceName: string;
  fileNames: string[];
  /** Optional user sentence: "Who will use this agent, and for what?" -
   *  documents say the domain, not the role; this says the role. */
  intent?: string;
}

/** The full calibration verdict: the agents AND the workspace operations
 *  they may request while diagnosing (already materialized into runnable
 *  tools). Ops stay empty for purely informational corpora - the diagnose
 *  path is their only consumer. */
export interface TeamCalibration {
  team: AgentSpec[];
  ops: WorkspaceTool[];
}

const spec = (id: string, label: string, charter: string, profile: WorkflowProfile): AgentSpec =>
  ({ id, label, charter, profile, active: true });

/** Teams shipped with the Studio presets. Insurance ships as a real team of
 *  two: the same corpus serves two distinct jobs (selling coverage and
 *  handling claims), which is exactly what the router exists for. */
export function presetTeam(presetId: string): AgentSpec[] {
  switch (presetId) {
    case 'repair':
      return [spec('repair-copilot', 'Repair copilot',
        'diagnostics, fault codes, procedures and parts for physical equipment', PROFILES.repair)];
    case 'insurance':
      return [
        spec('coverage-advisor', 'Coverage advisor',
          'what a policy covers: benefits, limits, premiums, eligibility and plan pricing', {
            ...PROFILES.insurance,
            id: 'coverage-advisor',
            agentRole: 'an insurance coverage advisor',
            retrievalHint: 'coverage tables, benefit limits, premium and pricing schedules first',
          }),
        spec('claims-analyst', 'Claims analyst',
          'claims handling: exclusions, conditions, notification deadlines, required documents and disputes', {
            ...PROFILES.insurance,
            id: 'claims-analyst',
            agentRole: 'an insurance claims analyst',
            retrievalHint: 'exclusion clauses, claim conditions, notification deadlines and required documentation first',
          }),
      ];
    case 'legal':
      return [spec('legal-researcher', 'Legal researcher',
        'definitions, obligations, liability and precedent questions over the document set', PROFILES.legal)];
    default:
      return [spec('document-analyst', 'Document analyst',
        'any grounded question over the workspace documents', PROFILES.generic)];
  }
}

const KEYWORDS: Record<'insurance' | 'legal' | 'repair', string[]> = {
  insurance: ['assur', 'police', 'policy', 'garantie', 'warranty', 'claim', 'sinistre', 'couverture', 'coverage', 'insur', 'rider'],
  legal: ['jugement', 'judgment', 'contrat', 'contract', 'nda', 'juridique', 'legal', 'tribunal', 'court', 'statute', 'brief'],
  repair: ['manual', 'manuel', 'service', 'repair', 'reparation', 'notice', 'troubleshoot', 'tm-', 'ifixit', 'schematic'],
};

function heuristicVertical(input: TeamCalibrationInput): keyof typeof KEYWORDS | null {
  const files = [input.workspaceName, ...input.fileNames].join(' ').toLowerCase();
  const intent = (input.intent ?? '').toLowerCase();
  let best: keyof typeof KEYWORDS | null = null;
  let bestScore = 0;
  for (const id of ['insurance', 'legal', 'repair'] as const) {
    const score = KEYWORDS[id].reduce((n, kw) => n + (files.includes(kw) ? 1 : 0) + (intent.includes(kw) ? 2 : 0), 0);
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best;
}

/** Deterministic team from workspace name, file names and intent. The intent
 *  sentence counts double: it names the JOB, the file names only hint it. */
export function heuristicTeam(input: TeamCalibrationInput): AgentSpec[] {
  return presetTeam(heuristicVertical(input) ?? 'generic');
}

/** Deterministic fallback for the full calibration: only the repair vertical
 *  ships hand-written ops; everything else diagnoses without any until the
 *  model writes some. */
export function heuristicCalibration(input: TeamCalibrationInput): TeamCalibration {
  const vertical = heuristicVertical(input);
  return {
    team: presetTeam(vertical ?? 'generic'),
    ops: vertical === 'repair' ? TOOL_REGISTRY : [],
  };
}

/** Prompt for the live driver: the model designs the team itself. Flat
 *  profile fields per agent - nested JSON multiplies parse failures. */
export function teamPrompt(input: TeamCalibrationInput): string {
  const files = input.fileNames.length > 0 ? input.fileNames.slice(0, 40).join(', ') : '(none yet)';
  return [
    `You are configuring a document-grounded agent workspace named "${input.workspaceName}".`,
    `Files dropped by the user: ${files}.`,
    input.intent ? `The user described who will use it: "${input.intent}". Weigh this ABOVE the file names.` : '',
    'Design the smallest team of specialized agents (1 to 3) covering the distinct JOBS users will bring to these documents.',
    'Split into several agents ONLY when the corpus itself clearly serves distinct jobs (e.g. policy wordings serve both coverage questions AND claims handling); NEVER invent a job the files do not support - a set of service manuals is ONE technician agent, not a technician plus an imagined warranty desk. When in doubt, return ONE agent.',
    'Return STRICT JSON: {"team": [{"id": string (short-kebab-slug), "label": string (short display name),',
    '"charter": string (ONE line stating which requests route to this agent),',
    '"agentRole": string (e.g. "an insurance claims analyst"), "subjectNoun": string (the main entity),',
    '"issueNoun": string (what a user ask is called), "retrievalHint": string (which page kinds matter first),',
    '"decisionMode": "diagnosis"|"answer" ("diagnosis" ONLY for physical equipment troubleshooting),',
    '"physicalTools": boolean (true only if technicians measure or replace parts),',
    '"classifyHint": string (how to read category / brand / model for these documents)}],',
    '"ops": [the workspace operations agents may REQUEST while working a case, e.g.',
    '{"id":"torque-spec-lookup","label":"Torque spec lookup","kind":"lookup","query":"torque specification chart","cue":"with args.fastener when tightening torque matters"}]}',
    '"lookup" = a targeted search across these same documents (a spec table, a parts list, a coverage limit); "capture" = the user reports a real-world value (a measurement, a reading) the agent then verifies. "query" (lookup only) = 3-6 plain search keywords; "cue" mold: "with args.<name> when <the situation that justifies it>".',
    'A purely informational corpus (every agent "answer") returns "ops": []. But when any agent has decisionMode "diagnosis", DO write the 2-3 ops its users will actually ask for - a parts availability lookup, a spec lookup, a measurement capture are typical.',
    'Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.',
  ].filter(Boolean).join(' ');
}

/** Strict validation of a model-written team; null when nothing usable. */
export function parseTeam(text: string): AgentSpec[] | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: { team?: unknown };
  try { raw = JSON.parse(m[0]) as { team?: unknown }; } catch { return null; }
  if (!Array.isArray(raw.team)) return null;
  const out: AgentSpec[] = [];
  for (const entry of raw.team.slice(0, 3)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const str = (k: string): string | null =>
      typeof e[k] === 'string' && (e[k] as string).trim().length > 0 ? (e[k] as string).trim() : null;
    const label = str('label');
    const charter = str('charter');
    const agentRole = str('agentRole');
    const subjectNoun = str('subjectNoun');
    const issueNoun = str('issueNoun');
    const retrievalHint = str('retrievalHint');
    const classifyHint = str('classifyHint');
    if (!label || !charter || !agentRole || !subjectNoun || !issueNoun || !retrievalHint || !classifyHint) continue;
    if (e.decisionMode !== 'diagnosis' && e.decisionMode !== 'answer') continue;
    const id = str('id') ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.some((a) => a.id === id)) continue;
    out.push(spec(id, label, charter, {
      id, agentRole, subjectNoun, issueNoun, retrievalHint,
      decisionMode: e.decisionMode,
      physicalTools: e.physicalTools === true,
      classifyHint,
    }));
  }
  return out.length > 0 ? out : null;
}

/** Strict validation of model-written ops; invalid entries drop silently
 *  (a bad op must never sink the team that came with it). */
export function parseOps(text: string): OpSpec[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let raw: { ops?: unknown };
  try { raw = JSON.parse(m[0]) as { ops?: unknown }; } catch { return []; }
  if (!Array.isArray(raw.ops)) return [];
  const out: OpSpec[] = [];
  for (const entry of raw.ops.slice(0, 3)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const str = (k: string): string | null =>
      typeof e[k] === 'string' && (e[k] as string).trim().length > 0 ? (e[k] as string).trim() : null;
    const label = str('label');
    const cue = str('cue');
    const query = str('query');
    if (!label || !cue) continue;
    if (e.kind !== 'lookup' && e.kind !== 'capture') continue;
    if (e.kind === 'lookup' && !query) continue;
    const id = str('id') ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, label, kind: e.kind, cue, query: e.kind === 'lookup' ? query ?? undefined : undefined });
  }
  return out;
}

/** Full calibration parse: no usable team means no usable calibration (the
 *  caller falls back to the heuristic); ops are best-effort on top. When no
 *  agent diagnoses, ops have no consumer - drop whatever the model wrote
 *  rather than shipping decorative operations. */
export function parseTeamCalibration(text: string): TeamCalibration | null {
  const team = parseTeam(text);
  if (!team) return null;
  const diagnosing = team.some((a) => a.profile.decisionMode === 'diagnosis');
  return { team, ops: diagnosing ? parseOps(text).map(opFromSpec) : [] };
}
