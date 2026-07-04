import type { Diagnosis, DocType, Page, PageKind, PlanAction, ScoredPage } from './types';
import { E3_DIAGNOSIS, E3_FLIPPED_DIAGNOSIS, E3_PLAN, E3_SUFFICIENCY } from './fixtures/e3-case';

export interface ClassifyInput { filename: string; pageImages: string[]; pageTexts: (string | undefined)[] }
export interface DocMeta { category: string; brand: string; model: string; docType: DocType; pageKinds: PageKind[] }
export interface SufficiencyVerdict {
  sufficient: boolean;
  reason: string;
  followupQuery?: string;
  /** Pages the judge names as holding the actual answer. Similarity scores
   *  rank covers and TOC pages above value tables; the judge READS. */
  keyPages?: number[];
}

export interface ModelDriver {
  plan(q: { device: string; symptom: string; hasPhoto: boolean; userInput?: string }): Promise<PlanAction>;
  retrieve(query: string, candidates: Page[]): Promise<ScoredPage[]>;
  assessSufficiency(q: { device: string; symptom: string }, found: ScoredPage[]): Promise<SufficiencyVerdict>;
  diagnose(q: { device: string; symptom: string }, evidence: Page[], techPhoto?: string): Promise<Diagnosis>;
  classify(input: ClassifyInput): Promise<DocMeta>;
  /** Free-form grounded answer (questions and deep dives) - optional; the
   *  loop falls back to the diagnosis pipeline when a driver lacks it. */
  answer?(question: string, evidence: Page[], mode: 'qa' | 'deep'): Promise<string>;
}

const BASE_MS = { plan: 2000, retrieve: 4000, assessSufficiency: 1500, diagnose: 6000, classify: 3000 } as const;

export class FakeDriver implements ModelDriver {
  private scale: number;
  constructor(opts?: { delayScale?: number }) { this.scale = opts?.delayScale ?? 1; }
  private async pace(k: keyof typeof BASE_MS) {
    const jitter = 0.7 + Math.random() * 0.6;
    const ms = BASE_MS[k] * this.scale * jitter;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async plan(q: { device: string; symptom: string; hasPhoto: boolean; userInput?: string }): Promise<PlanAction> {
    await this.pace('plan');
    if (q.userInput?.startsWith('report-measurement:')) {
      const [, component, value] = q.userInput.split(':');
      return { goal: `Re-evaluate: ${component} measured ${value} ohms - verify against spec, pivot to thermistor if in spec`, queries: [] };
    }
    if (q.userInput === 'find-video') {
      return { goal: 'Find a visual walkthrough for the heating element replacement', queries: ['heating element replacement walkthrough'] };
    }
    return E3_PLAN;
  }

  async retrieve(query: string, candidates: Page[]): Promise<ScoredPage[]> {
    await this.pace('retrieve');
    const q = query.toLowerCase();
    const score = (p: Page): number => {
      if ((q.includes('walkthrough') || q.includes('replacement') || q.includes('how to')) && p.kind === 'video-segment') {
        // the key replacement moments rank highest
        return /detach|insert|shut off/.test(p.text ?? '') ? 5.8 : 3.2;
      }
      if ((q.includes('e3') || q.includes('error')) && p.kind === 'error-table') return 6.7;
      if ((q.includes('wiring') || q.includes('diagram') || q.includes('schematic')) && p.kind === 'schematic') return 4.2;
      if (p.kind === 'troubleshooting' && !q.includes('walkthrough')) return 2.4;
      return 0.8;
    };
    return candidates.map((page) => ({ page, score: score(page) })).sort((a, b) => b.score - a.score);
  }

  async assessSufficiency(_q: { device: string; symptom: string }, found: ScoredPage[]): Promise<SufficiencyVerdict> {
    await this.pace('assessSufficiency');
    if (found.some((f) => f.page.kind === 'video-segment')) {
      return { sufficient: true, reason: 'Official walkthrough segments found with exact timestamps.' };
    }
    const hasSchematic = found.some((f) => f.page.kind === 'schematic');
    return hasSchematic ? { sufficient: true, reason: 'Error table plus wiring diagram cover the fault path.' } : E3_SUFFICIENCY;
  }

  async diagnose(_q: { device: string; symptom: string }, evidence: Page[], _techPhoto?: string): Promise<Diagnosis> {
    await this.pace('diagnose');
    if (evidence.some((p) => p.kind === 'video-segment')) {
      return {
        component: 'Heating element - guided replacement',
        cause: 'Official manufacturer walkthrough found; key steps cited with exact video timestamps.',
        checks: [
          'Shut off the water supply valve (video 0:28)',
          'Detach the old heating element from the brackets (video 2:29)',
          'Insert the new element terminals through the tank bottom (video 2:46)',
        ],
      };
    }
    const flipped = evidence.length === 0; // loop passes [] after an in-spec measurement pivot
    return flipped ? E3_FLIPPED_DIAGNOSIS : E3_DIAGNOSIS;
  }

  async classify(input: ClassifyInput): Promise<DocMeta> {
    await this.pace('classify');
    const f = input.filename.toLowerCase();
    if (f.includes('whirlpool') || f.includes('dishwasher')) {
      return { category: 'dishwasher', brand: 'Whirlpool', model: 'W11187658', docType: 'service', pageKinds: input.pageImages.map(() => 'other' as PageKind) };
    }
    if (f.includes('hmmwv') || f.includes('tm-9')) {
      return { category: 'vehicle', brand: 'AM General', model: 'M1151', docType: 'service', pageKinds: input.pageImages.map(() => 'other' as PageKind) };
    }
    return { category: 'uncategorized', brand: 'Unknown', model: 'Unknown', docType: 'user', pageKinds: input.pageImages.map(() => 'other' as PageKind) };
  }
}
