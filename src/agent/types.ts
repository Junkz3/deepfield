export type Phase = 'plan' | 'retrieve' | 'reason' | 'tools' | 'decide';
export type StepStatus = 'ok' | 'needs-input' | 'no-evidence' | 'error' | 'done';
export type PageKind = 'error-table' | 'schematic' | 'troubleshooting' | 'procedure' | 'parts' | 'safety' | 'coverage-table' | 'video-segment' | 'other';
export type DocFormat = 'pdf' | 'image' | 'text' | 'video';
export type DocType = 'service' | 'user' | 'schematic' | 'parts' | 'video';
export type Origin = 'corpus' | 'session';
export interface Region { x: number; y: number; w: number; h: number } // normalized [0,1]
export interface TextBlock extends Region { text: string; lines?: number } // exact layout block from the PDF text layer
export interface Page { docId: string; page: number; imageUrl: string; text?: string; title?: string; kind: PageKind; region?: Region; timestamp?: number; videoUrl?: string; textBlocks?: TextBlock[]; structuredText?: string }
export interface Document { id: string; filename: string; format: DocFormat; category: string; brand: string; model: string; docType: DocType; pages: Page[]; sourceRights: string; origin: Origin }
export interface Citation { docId: string; page: number; region?: Region; quote?: string; timestamp?: number; label: string; title?: string }
export interface ScoredPage { page: Page; score: number }
/** Symptom placeholder for free-form requests (no "device: symptom" split):
 *  the planner presents these as one user request, not as a device name. */
export const FREEFORM_SYMPTOM = 'as described by the technician';

export interface PlanAction { goal: string; queries: string[]; intent?: 'diagnose' | 'question' | 'scope'; agentId?: string }
export interface Diagnosis { component: string; cause: string; checks: string[]; instruction?: string; componentKey?: string; tools?: { id: string; args?: Record<string, string> }[]; followups?: string[] }
export interface PartLine { ref: string; name: string; inStock: boolean; price?: number; leadDays?: number }
export interface SafetyInfo { lines: string[]; citations: Citation[] }
export interface PhaseEvent { phase: Phase; summary: string; detail?: string; citations?: Citation[]; hitPages?: { docId: string; page: number }[] }
export interface ProposedAction { label: string; action: string }
export interface GuidedStep { index: number; phaseEvents: PhaseEvent[]; instruction: string; citations: Citation[]; proposedNext: ProposedAction[]; confidence: number; confidenceReason: string; status: StepStatus; diagnosis?: Diagnosis; parts?: PartLine[]; safety?: SafetyInfo; userInput?: string; answer?: string; agentLabel?: string; readPages?: { docId: string; page: number }[] }
export interface Attachment { kind: 'image'; dataUrl: string; name: string }
export interface Conversation { id: string; device: string; symptom: string; attachments: Attachment[]; steps: GuidedStep[]; userInputs: string[]; status: 'active' | 'closed' }
export interface WorkOrder { device: string; symptom: string; diagnosis: Diagnosis; procedure: string[]; parts: PartLine[]; safety: string[]; citations: Citation[]; missingDocs: string[]; confidence: number; confidenceReason: string }
export interface TaxonomyNode { id: string; label: string; type: 'category' | 'brand' | 'model' | 'document' | 'page'; children: TaxonomyNode[]; docId?: string; origin: Origin }
export interface ConfidenceInput { exactCodeMatch: boolean; corroboratingCitations: number; requiredPageMissing: boolean }
