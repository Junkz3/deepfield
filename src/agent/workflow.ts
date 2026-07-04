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
  },
  insurance: {
    id: 'insurance',
    agentRole: 'an insurance policy analyst',
    subjectNoun: 'policy or contract',
    issueNoun: 'question or claim',
    retrievalHint: 'coverage tables, clauses, exclusions and warranty terms first',
    decisionMode: 'answer',
    physicalTools: false,
  },
  legal: {
    id: 'legal',
    agentRole: 'a legal research assistant',
    subjectNoun: 'case or document set',
    issueNoun: 'question',
    retrievalHint: 'definitions, obligations, liability clauses and referenced annexes first',
    decisionMode: 'answer',
    physicalTools: false,
  },
  generic: {
    id: 'generic',
    agentRole: 'a document analyst',
    subjectNoun: 'subject',
    issueNoun: 'question',
    retrievalHint: 'summary tables, procedures and reference sections first',
    decisionMode: 'answer',
    physicalTools: false,
  },
};

let ACTIVE: WorkflowProfile = PROFILES.repair;

export function setWorkflowProfile(idOrProfile: string | WorkflowProfile): void {
  ACTIVE = typeof idOrProfile === 'string' ? PROFILES[idOrProfile] ?? PROFILES.generic : idOrProfile;
}

export function workflowProfile(): WorkflowProfile {
  return ACTIVE;
}
