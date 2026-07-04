// Client-owned application state (spec: Cloudflare Functions stay stateless).
// Corpus docs come from build-time static assets; session docs + conversations
// live here, conversations persisted to localStorage.
import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { Attachment, Conversation, Document, GuidedStep } from '../agent/types';
import { mergeDocs } from '../agent/taxonomy';

export type DriverKind = 'fake' | 'vultr';

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
}

export type Action =
  | { type: 'boot'; docs: Document[] }
  | { type: 'add-session-doc'; doc: Document }
  | { type: 'open-center' }
  | { type: 'open-conversation'; id: string }
  | { type: 'new-conversation'; id: string; device: string; symptom: string; attachments: Attachment[] }
  | { type: 'append-step'; conversationId: string; step: GuidedStep }
  | { type: 'set-highlight'; pages: { docId: string; page: number }[] }
  | { type: 'set-scanning'; scanning: boolean }
  | { type: 'set-driver'; kind: DriverKind }
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

function initialDriverKind(): DriverKind {
  const p = new URLSearchParams(location.search).get('driver');
  return p === 'fake' || p === 'vultr' ? p : 'vultr';
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
};

export function reducer(state: AppState, a: Action): AppState {
  switch (a.type) {
    case 'boot':
      return { ...state, booted: true, corpusDocs: a.docs, conversations: loadConversations(), driverKind: initialDriverKind() };
    case 'add-session-doc':
      return { ...state, sessionDocs: mergeDocs(state.sessionDocs, [a.doc]) };
    case 'open-center':
      return { ...state, activeView: { kind: 'center' } };
    case 'open-conversation':
      return { ...state, activeView: { kind: 'conversation', id: a.id } };
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
    case 'set-scanning':
      return { ...state, scanning: a.scanning };
    case 'set-driver':
      return { ...state, driverKind: a.kind };
    case 'demo-reset':
      localStorage.removeItem(LS_KEY);
      return {
        ...state,
        sessionDocs: [],
        conversations: [],
        activeView: { kind: 'center' },
        highlight: [],
        scanning: false,
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

/** Category accent color — single source for galaxy, tree, badges. */
export function categoryColor(category: string): string {
  const key = category.toLowerCase().replace(/\s+/g, '-');
  const known = ['dishwasher', 'washing-machine', 'vehicle', 'smartphone', 'game-console', 'coffee-machine'];
  return `var(--cat-${known.includes(key) ? key : 'uncategorized'})`;
}
