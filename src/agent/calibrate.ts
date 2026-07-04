// Deepfield calibration: shape a WorkflowProfile from the corpus the user
// actually dropped. The live driver asks the model; the offline driver and
// every failure path fall back to the keyword heuristic, so the Studio flow
// never blocks on calibration.
import type { WorkflowProfile } from './workflow';
import { PROFILES } from './workflow';

export interface CalibrationInput { workspaceName: string; fileNames: string[] }

const KEYWORDS: Record<'insurance' | 'legal' | 'repair', string[]> = {
  insurance: ['assur', 'police', 'policy', 'garantie', 'warranty', 'claim', 'sinistre', 'couverture', 'coverage', 'insur', 'rider'],
  legal: ['jugement', 'judgment', 'contrat', 'contract', 'nda', 'juridique', 'legal', 'tribunal', 'court', 'statute', 'brief'],
  repair: ['manual', 'manuel', 'service', 'repair', 'reparation', 'notice', 'troubleshoot', 'tm-', 'ifixit', 'schematic'],
};

/** Deterministic profile pick from workspace name + file names. */
export function heuristicProfile(input: CalibrationInput): WorkflowProfile {
  const hay = [input.workspaceName, ...input.fileNames].join(' ').toLowerCase();
  let best: keyof typeof KEYWORDS | null = null;
  let bestScore = 0;
  for (const id of ['insurance', 'legal', 'repair'] as const) {
    const score = KEYWORDS[id].reduce((n, kw) => n + (hay.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best ? PROFILES[best] : PROFILES.generic;
}

/** Prompt for the live driver: the model reads the corpus signal and writes
 *  the agent's own configuration. Same output discipline as classify. */
export function calibrationPrompt(input: CalibrationInput): string {
  const files = input.fileNames.length > 0 ? input.fileNames.slice(0, 40).join(', ') : '(none yet)';
  return [
    `You are configuring a document-grounded agent for a new workspace named "${input.workspaceName}".`,
    `Files dropped by the user: ${files}.`,
    'Infer the professional domain and write the agent profile. Return STRICT JSON:',
    '{"id": string (short-kebab-slug), "agentRole": string (e.g. "an insurance policy analyst"),',
    '"subjectNoun": string (the main entity: "policy or contract", "case", "device"),',
    '"issueNoun": string (what a user ask is called), "retrievalHint": string (which page kinds matter first),',
    '"decisionMode": "diagnosis"|"answer" ("diagnosis" ONLY for physical equipment troubleshooting),',
    '"physicalTools": boolean (true only if technicians measure or replace parts),',
    '"classifyHint": string (how to read category / brand / model for these documents)}',
    'Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.',
  ].join(' ');
}

/** Strict validation of a model-written profile; null when unusable. */
export function parseProfile(text: string): WorkflowProfile | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const str = (k: string): string | null =>
    typeof raw[k] === 'string' && (raw[k] as string).trim().length > 0 ? (raw[k] as string).trim() : null;
  const agentRole = str('agentRole');
  const subjectNoun = str('subjectNoun');
  const issueNoun = str('issueNoun');
  const retrievalHint = str('retrievalHint');
  const classifyHint = str('classifyHint');
  const decisionMode = raw.decisionMode;
  if (!agentRole || !subjectNoun || !issueNoun || !retrievalHint || !classifyHint) return null;
  if (decisionMode !== 'diagnosis' && decisionMode !== 'answer') return null;
  return {
    id: str('id') ?? 'calibrated',
    agentRole,
    subjectNoun,
    issueNoun,
    retrievalHint,
    decisionMode,
    physicalTools: raw.physicalTools === true,
    classifyHint,
  };
}
