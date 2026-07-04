// Workflow profiles: the ONE place where the agent's vertical lives.
// Everything else (retrieval, universe, citations, languages) is generic;
// a profile parameterizes the prompts, the decision mold and the tools.
// Deepfield workspaces pick a profile at creation time.

export interface WorkflowProfile {
  id: string;
  /** Injected into prompts: "a repair agent", "an insurance policy analyst" */
  agentRole: string;
  /** What the main entity is called in prompts and UI copy */
  subjectNoun: string;
  /** What the user's ask is called */
  issueNoun: string;
  /** Retrieval steering, e.g. which pages matter first */
  retrievalHint: string;
  /** 'diagnosis' = full fault pipeline with tools; 'answer' = grounded cited answers */
  decisionMode: 'diagnosis' | 'answer';
  /** Physical-world tool phases (parts stock, measurements, safety notes) */
  physicalTools: boolean;
  /** How ingestion should read category/brand/model for this vertical */
  classifyHint: string;
}

export const PROFILES: Record<string, WorkflowProfile> = {
  repair: {
    id: 'repair',
    agentRole: 'a repair agent',
    subjectNoun: 'device',
    issueNoun: 'symptom',
    retrievalHint: 'error code table / troubleshooting first',
    decisionMode: 'diagnosis',
    physicalTools: true,
    classifyHint: 'category = generic device type (e.g. "dishwasher"), brand = manufacturer, model = product reference',
  },
  insurance: {
    id: 'insurance',
    agentRole: 'an insurance policy analyst',
    subjectNoun: 'policy or contract',
    issueNoun: 'question or claim',
    retrievalHint: 'coverage tables, clauses, exclusions and warranty terms first',
    decisionMode: 'answer',
    physicalTools: false,
    classifyHint: 'category = document type (e.g. "auto policy", "home policy", "claim form", "rider"), brand = insurer name, model = contract or product reference',
  },
  legal: {
    id: 'legal',
    agentRole: 'a legal research assistant',
    subjectNoun: 'case or document set',
    issueNoun: 'question',
    retrievalHint: 'definitions, obligations, liability clauses and referenced annexes first',
    decisionMode: 'answer',
    physicalTools: false,
    classifyHint: 'category = document type (e.g. "contract", "judgment", "brief", "statute extract"), brand = issuing party or court, model = case or reference number',
  },
  generic: {
    id: 'generic',
    agentRole: 'a document analyst',
    subjectNoun: 'subject',
    issueNoun: 'question',
    retrievalHint: 'summary tables, procedures and reference sections first',
    decisionMode: 'answer',
    physicalTools: false,
    classifyHint: 'category = document family, brand = issuing organization, model = document reference or title',
  },
};

let ACTIVE: WorkflowProfile = PROFILES.repair;

export function setWorkflowProfile(idOrProfile: string | WorkflowProfile): void {
  ACTIVE = typeof idOrProfile === 'string' ? PROFILES[idOrProfile] ?? PROFILES.generic : idOrProfile;
}

export function workflowProfile(): WorkflowProfile {
  return ACTIVE;
}

/** A workspace agent: one specialist the router can hand a request to.
 *  The profile carries the vertical; the charter is the one line the
 *  router matches requests against. */
export interface AgentSpec {
  id: string;
  /** Display name ("Coverage advisor") */
  label: string;
  /** One line stating which requests belong to this agent */
  charter: string;
  profile: WorkflowProfile;
  /** User toggle: disabled agents are invisible to the router */
  active: boolean;
}

let TEAM: AgentSpec[] = [];

export function setWorkflowTeam(team: AgentSpec[]): void {
  TEAM = team;
}

export function workflowTeam(): AgentSpec[] {
  return TEAM;
}

/** Agents the user left enabled for the next request. With one, the plan
 *  prompt stays untouched; with several, plan() routes between them. */
export function activeAgents(): AgentSpec[] {
  return TEAM.filter((a) => a.active);
}
