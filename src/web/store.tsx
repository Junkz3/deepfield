// Client-owned application state (spec: Cloudflare Functions stay stateless).
// Corpus docs come from build-time static assets; session docs + conversations
// live here, conversations persisted to localStorage.
import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { Attachment, Conversation, Document, GuidedStep } from '../agent/types';
import { mergeDocs } from '../agent/taxonomy';
import { presetTeam } from '../agent/team';
import type { WorkspaceTool } from '../agent/tools';
import { installWorkspaceOps, TOOL_REGISTRY } from '../agent/tools';
import type { AgentSpec } from '../agent/workflow';
import { setWorkflowTeam } from '../agent/workflow';
import { setAgentLanguage } from '../vultr/client';

export type DriverKind = 'fake' | 'vultr';

export type Lang = string; // ISO-ish code; translation covers far more than retrieval

/** Retrieval-grade languages (VultronRetriever official) first, then the long tail
 *  Nemotron/Kimi translate to. */
export const LANGS: { code: Lang; name: string; retrieval?: boolean }[] = [
  { code: 'en', name: 'English', retrieval: true },
  { code: 'fr', name: 'French', retrieval: true },
  { code: 'de', name: 'German', retrieval: true },
  { code: 'es', name: 'Spanish', retrieval: true },
  { code: 'it', name: 'Italian', retrieval: true },
  { code: 'pt', name: 'Portuguese', retrieval: true },
  { code: 'nl', name: 'Dutch' }, { code: 'pl', name: 'Polish' }, { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' }, { code: 'uk', name: 'Ukrainian' }, { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' }, { code: 'zh', name: 'Chinese' }, { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' }, { code: 'vi', name: 'Vietnamese' }, { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' }, { code: 'sv', name: 'Swedish' }, { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' }, { code: 'fi', name: 'Finnish' }, { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' }, { code: 'el', name: 'Greek' }, { code: 'he', name: 'Hebrew' },
];
export const langName = (code: Lang): string => LANGS.find((l) => l.code === code)?.name ?? 'English';

export type ActiveView = { kind: 'center' } | { kind: 'conversation'; id: string };

export interface AppState {
  booted: boolean;
  corpusDocs: Document[];
  sessionDocs: Document[];
  conversations: Conversation[];
  activeView: ActiveView;
  driverKind: DriverKind;
  highlight: { docId: string; page: number }[];
  scanning: boolean;
  lightbox: { docId: string; page: number } | null;
  /** live ingestion feedback: the embryo card near the core */
  ingesting: { name: string } | null;
  /** the doc that was just classified: its card flies from the core */
  lastBorn: string | null;
  /** technician language: retrieval is multilingual, the agent answers in it */
  lang: Lang;
  /** Deepfield Studio (?studio): workspace creation screen shown before boot */
  studioMode: boolean;
  /** docs fetched during studio mode, held until create-workspace */
  pendingDocs: Document[];
  workspaceName: string;
  /** the workspace agent team; the user toggles who is active per request */
  team: AgentSpec[];
  /** the workspace op registry: shipped repair ops or calibration-written */
  ops: WorkspaceTool[];
}

export type Action =
  | { type: 'boot'; docs: Document[] }
  | { type: 'add-session-doc'; doc: Document }
  | { type: 'open-center' }
  | { type: 'open-conversation'; id: string }
  | { type: 'new-conversation'; id: string; device: string; symptom: string; attachments: Attachment[] }
  | { type: 'append-step'; conversationId: string; step: GuidedStep }
  | { type: 'set-highlight'; pages: { docId: string; page: number }[] }
  | { type: 'add-highlight'; pages: { docId: string; page: number }[] }
  | { type: 'set-scanning'; scanning: boolean }
  | { type: 'set-driver'; kind: DriverKind }
  | { type: 'open-lightbox'; docId: string; page: number }
  | { type: 'close-lightbox' }
  | { type: 'ingest-start'; name: string }
  | { type: 'ingest-done'; docId: string | null }
  | { type: 'set-lang'; lang: Lang }
  | { type: 'create-workspace'; name: string; corpus: Document[]; team?: AgentSpec[] }
  | { type: 'set-team'; team: AgentSpec[] }
  | { type: 'set-ops'; ops: WorkspaceTool[] }
  | { type: 'toggle-agent'; id: string }
  | { type: 'studio-preview'; corpus: Document[] }
  | { type: 'demo-reset' };

const LS_KEY = 'rc.conversations';

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Conversation[]) : [];
  } catch {
    return [];
  }
}

export function initialDriverKind(): DriverKind {
  try {
    const p = new URLSearchParams(location.search).get('driver');
    return p === 'fake' || p === 'vultr' ? p : 'vultr';
  } catch {
    return 'vultr';
  }
}

function storedLang(): Lang {
  try {
    return (localStorage.getItem('rc.lang') as Lang) || 'en';
  } catch {
    return 'en';
  }
}

function isStudioMode(): boolean {
  try {
    return new URLSearchParams(location.search).has('studio');
  } catch {
    return false;
  }
}

export const initialState: AppState = {
  booted: false,
  corpusDocs: [],
  sessionDocs: [],
  conversations: [],
  activeView: { kind: 'center' },
  driverKind: 'fake',
  highlight: [],
  scanning: false,
  lightbox: null,
  ingesting: null,
  lastBorn: null,
  lang: storedLang(),
  studioMode: isStudioMode(),
  pendingDocs: [],
  workspaceName: 'RepairCenter',
  team: presetTeam('repair'),
  ops: TOOL_REGISTRY,
};

export function reducer(state: AppState, a: Action): AppState {
  switch (a.type) {
    case 'boot':
      // Late fetch after create-workspace must not overwrite the chosen corpus.
      if (state.booted) return state;
      // Studio mode: hold the corpus, the universe is born on create-workspace.
      if (state.studioMode) return { ...state, pendingDocs: a.docs };
      return { ...state, booted: true, corpusDocs: a.docs, conversations: loadConversations(), driverKind: initialDriverKind() };
    case 'studio-preview':
      // Live preview: the universe behind the Studio card mirrors the corpus
      // selection. Only meaningful before the workspace exists.
      if (!state.studioMode) return state;
      return { ...state, corpusDocs: a.corpus };
    case 'create-workspace':
      return {
        ...state,
        booted: true,
        studioMode: false,
        workspaceName: a.name.trim() || 'RepairCenter',
        corpusDocs: a.corpus,
        pendingDocs: [],
        conversations: loadConversations(),
        driverKind: initialDriverKind(),
        team: a.team ?? state.team,
      };
    case 'set-team':
      return { ...state, team: a.team };
    case 'set-ops':
      return { ...state, ops: a.ops };
    case 'toggle-agent': {
      // At least one agent must stay active: the router needs someone to
      // hand the request to.
      const next = state.team.map((t) => (t.id === a.id ? { ...t, active: !t.active } : t));
      return next.some((t) => t.active) ? { ...state, team: next } : state;
    }
    case 'add-session-doc':
      return { ...state, sessionDocs: mergeDocs(state.sessionDocs, [a.doc]) };
    case 'open-center':
      return { ...state, activeView: { kind: 'center' } };
    case 'open-conversation': {
      // Restore the citation fan of the last completed step: the universe
      // shows where the evidence lives without re-running anything.
      const conv = state.conversations.find((c) => c.id === a.id);
      const lastCited = conv ? [...conv.steps].reverse().find((st) => st.citations.length > 0) : undefined;
      const highlight = lastCited ? lastCited.citations.map((c) => ({ docId: c.docId, page: c.page })) : state.highlight;
      return { ...state, activeView: { kind: 'conversation', id: a.id }, highlight };
    }
    case 'new-conversation': {
      const conv: Conversation = {
        id: a.id, device: a.device, symptom: a.symptom,
        attachments: a.attachments, steps: [], userInputs: [], status: 'active',
      };
      return { ...state, conversations: [conv, ...state.conversations], activeView: { kind: 'conversation', id: conv.id } };
    }
    case 'append-step':
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === a.conversationId ? { ...c, steps: [...c.steps, a.step] } : c,
        ),
      };
    case 'set-highlight':
      return { ...state, highlight: a.pages };
    case 'add-highlight': {
      // Accumulate within a step so the universe expands as the agent digs.
      const fresh = a.pages.filter((p) => !state.highlight.some((h) => h.docId === p.docId && h.page === p.page));
      return fresh.length > 0 ? { ...state, highlight: [...state.highlight, ...fresh] } : state;
    }
    case 'set-scanning':
      return { ...state, scanning: a.scanning };
    case 'set-driver':
      return { ...state, driverKind: a.kind };
    case 'open-lightbox':
      return { ...state, lightbox: { docId: a.docId, page: a.page } };
    case 'close-lightbox':
      return { ...state, lightbox: null };
    case 'ingest-start':
      return { ...state, ingesting: { name: a.name } };
    case 'ingest-done':
      return { ...state, ingesting: null, lastBorn: a.docId };
    case 'set-lang':
      localStorage.setItem('rc.lang', a.lang);
      return { ...state, lang: a.lang };
    case 'demo-reset':
      localStorage.removeItem(LS_KEY);
      return {
        ...state,
        sessionDocs: [],
        conversations: [],
        activeView: { kind: 'center' },
        highlight: [],
        scanning: false,
        lightbox: null,
        ingesting: null,
        lastBorn: null,
        team: presetTeam('repair'),
        ops: TOOL_REGISTRY,
      };
    default:
      return state;
  }
}

interface Ctx {
  state: AppState;
  dispatch: (a: Action) => void;
  /** corpus + session, merged (idempotent) — the single doc list every view uses */
  docs: Document[];
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // The agent speaks the selected language from the very first call.
  useEffect(() => {
    setAgentLanguage(langName(state.lang));
  }, [state.lang]);

  // The engine routes between whatever agents the user left enabled.
  useEffect(() => {
    setWorkflowTeam(state.team);
  }, [state.team]);

  // The verdict call offers whatever ops the workspace installed.
  useEffect(() => {
    installWorkspaceOps(state.ops);
  }, [state.ops]);

  // Boot: load the build-time corpus (absent in early dev = empty galaxy, fine).
  useEffect(() => {
    fetch('/corpus/docs.json')
      .then((r) => (r.ok ? (r.json() as Promise<Document[]>) : Promise.resolve<Document[]>([])))
      .catch(() => [] as Document[])
      .then((docs) => dispatch({ type: 'boot', docs }));
  }, []);

  // Persist conversations.
  useEffect(() => {
    if (state.booted) localStorage.setItem(LS_KEY, JSON.stringify(state.conversations));
  }, [state.booted, state.conversations]);

  const docs = useMemo(() => mergeDocs(state.corpusDocs, state.sessionDocs), [state.corpusDocs, state.sessionDocs]);

  const value = useMemo(() => ({ state, dispatch, docs }), [state, docs]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp outside AppProvider');
  return ctx;
}

/** Category accent color — single source for galaxy, tree, badges.
 *  Core categories use the design tokens; the long tail gets a deterministic
 *  generated hue (same hash as the 3D scene). */
export function categoryColor(category: string): string {
  const key = category.toLowerCase().replace(/\s+/g, '-');
  const known = ['dishwasher', 'washing-machine', 'vehicle', 'smartphone', 'game-console', 'coffee-machine'];
  if (known.includes(key)) return `var(--cat-${key})`;
  const raw = category.toLowerCase();
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, ${62 + (h % 3) * 8}%, ${64 + (h % 4) * 4}%)`;
}
