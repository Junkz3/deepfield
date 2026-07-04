// Client-owned application state (spec: Cloudflare Functions stay stateless).
// Corpus docs come from build-time static assets; session docs + conversations
// live here, conversations persisted to localStorage.
import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Attachment, Conversation, Document, GuidedStep, Page, Phase } from '../agent/types';
import { mergeDocs } from '../agent/taxonomy';
import { presetTeam } from '../agent/team';
import type { OpSpec, WorkspaceTool } from '../agent/tools';
import { installWorkspaceOps, opFromSpec, TOOL_REGISTRY } from '../agent/tools';
import type { AgentSpec } from '../agent/workflow';
import { setWorkflowProfile, setWorkflowTeam } from '../agent/workflow';
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

/** A dormant workspace, parked while another one is active. The flat state
 *  below IS the active workspace; switching swaps the flat fields against a
 *  snapshot. Session-only: corpora are far too heavy for localStorage. */
export interface WorkspaceSnapshot {
  id: string;
  name: string;
  corpusDocs: Document[];
  sessionDocs: Document[];
  conversations: Conversation[];
  team: AgentSpec[];
  ops: WorkspaceTool[];
}

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
  /** message typed from the VR bar, consumed by the active ConversationView */
  vrOutbox: string | null;
  /** live agent feed mirrored for the VR side panel (capped, latest last) */
  vrLog: { phase: Phase; summary: string }[];
  /** the workspace agent team; the user toggles who is active per request */
  team: AgentSpec[];
  /** the workspace op registry: shipped repair ops or calibration-written */
  ops: WorkspaceTool[];
  /** the OTHER workspaces, parked; the flat fields are the active one */
  workspaces: WorkspaceSnapshot[];
  activeWorkspaceId: string;
  /** the Studio opened as an in-app panel (sidebar stays), not boot mode */
  studioOpen: boolean;
  /** active workspace docs saved while the in-app Studio previews its
   *  corpus selection in the universe; restored on close, never parked */
  previewBackup: { corpusDocs: Document[]; sessionDocs: Document[] } | null;
}

export type Action =
  | { type: 'boot'; docs: Document[] }
  | { type: 'add-session-doc'; doc: Document }
  | { type: 'extend-session-doc'; docId: string; pages: Page[] }
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
  | { type: 'create-workspace'; name: string; corpus: Document[]; team?: AgentSpec[]; ops?: WorkspaceTool[] }
  | { type: 'add-workspace'; id: string; name: string; corpus: Document[]; team: AgentSpec[]; ops: WorkspaceTool[] }
  | { type: 'switch-workspace'; id: string }
  | { type: 'hydrate-workspaces'; list: WorkspaceSnapshot[] }
  | { type: 'open-studio' }
  | { type: 'close-studio' }
  | { type: 'set-team'; team: AgentSpec[] }
  | { type: 'set-ops'; ops: WorkspaceTool[] }
  | { type: 'toggle-agent'; id: string }
  | { type: 'studio-preview'; corpus: Document[] }
  | { type: 'vr-outbox'; text: string | null }
  | { type: 'vr-log-push'; entry: { phase: Phase; summary: string } }
  | { type: 'vr-log-clear' }
  | { type: 'demo-reset' };

const LS_KEY = 'rc.conversations';
const WS_KEY = 'rc.workspaces';

/** Light manifest persisted across reloads: no corpora (way too heavy),
 *  only what it takes to rebuild seed-backed workspaces at boot. */
interface PersistedWorkspace {
  id: string;
  name: string;
  /** which static corpus backs it; 'session' = dropped files, not rebuildable */
  corpusSource: string;
  team: AgentSpec[];
  opSpecs: OpSpec[];
}

const SEED_SOURCES = new Set(['corpus', 'corpus-insurance']);

function corpusSourceOf(docs: Document[]): string {
  const url = docs[0]?.pages[0]?.imageUrl ?? '';
  if (url.startsWith('/corpus-insurance/')) return 'corpus-insurance';
  if (url.startsWith('/corpus/')) return 'corpus';
  return 'session';
}

/** Per-workspace conversation key; the boot workspace keeps the historic key. */
export const convKey = (workspaceId: string): string =>
  workspaceId === 'default' ? LS_KEY : `${LS_KEY}.${workspaceId}`;

function loadConversations(workspaceId = 'default'): Conversation[] {
  try {
    const raw = localStorage.getItem(convKey(workspaceId));
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
  vrOutbox: null,
  vrLog: [],
  team: presetTeam('repair'),
  ops: TOOL_REGISTRY,
  workspaces: [],
  activeWorkspaceId: 'default',
  studioOpen: false,
  previewBackup: null,
};

/** The active workspace's flat fields, frozen for parking. A live Studio
 *  preview must never be parked as if it were the workspace's corpus. */
function snapshotActive(s: AppState): WorkspaceSnapshot {
  return {
    id: s.activeWorkspaceId, name: s.workspaceName,
    corpusDocs: s.previewBackup?.corpusDocs ?? s.corpusDocs,
    sessionDocs: s.previewBackup?.sessionDocs ?? s.sessionDocs,
    conversations: s.conversations, team: s.team, ops: s.ops,
  };
}

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
      // selection. Boot mode swaps freely (no workspace exists yet); the
      // in-app panel backs the active workspace's docs up first.
      if (state.studioMode) return { ...state, corpusDocs: a.corpus };
      if (!state.studioOpen) return state;
      return {
        ...state,
        previewBackup: state.previewBackup ?? { corpusDocs: state.corpusDocs, sessionDocs: state.sessionDocs },
        corpusDocs: a.corpus,
        sessionDocs: [],
        highlight: [],
      };
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
        ops: a.ops ?? state.ops,
      };
    case 'add-workspace':
      // Park the active workspace, start fresh in the new one. Hard cap of
      // 4 workspaces per session (the sidebar disables the button first).
      if (state.workspaces.length >= 3) return state;
      return {
        ...state,
        previewBackup: null,
        workspaces: [...state.workspaces, snapshotActive(state)],
        activeWorkspaceId: a.id,
        workspaceName: a.name.trim() || 'Workspace',
        corpusDocs: a.corpus,
        sessionDocs: [],
        conversations: loadConversations(a.id),
        team: a.team,
        ops: a.ops,
        activeView: { kind: 'center' },
        highlight: [], scanning: false, lightbox: null, ingesting: null, lastBorn: null,
        studioOpen: false,
      };
    case 'switch-workspace': {
      const target = state.workspaces.find((w) => w.id === a.id);
      if (!target) return state;
      return {
        ...state,
        previewBackup: null,
        workspaces: [...state.workspaces.filter((w) => w.id !== a.id), snapshotActive(state)],
        activeWorkspaceId: target.id,
        workspaceName: target.name,
        corpusDocs: target.corpusDocs,
        sessionDocs: target.sessionDocs,
        conversations: target.conversations,
        team: target.team,
        ops: target.ops,
        activeView: { kind: 'center' },
        highlight: [], lightbox: null, studioOpen: false,
      };
    }
    case 'hydrate-workspaces': {
      // Reload: seed-backed workspaces rebuilt from the persisted manifest
      // join the parked list (never displacing anything already live).
      const fresh = a.list.filter(
        (w) => w.id !== state.activeWorkspaceId && !state.workspaces.some((x) => x.id === w.id),
      );
      if (fresh.length === 0) return state;
      return { ...state, workspaces: [...state.workspaces, ...fresh].slice(0, 3) };
    }
    case 'open-studio':
      return { ...state, studioOpen: true, activeView: { kind: 'center' } };
    case 'close-studio':
      // Closing without creating: put the previewed universe back.
      return {
        ...state,
        studioOpen: false,
        corpusDocs: state.previewBackup?.corpusDocs ?? state.corpusDocs,
        sessionDocs: state.previewBackup?.sessionDocs ?? state.sessionDocs,
        previewBackup: null,
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
    case 'extend-session-doc':
      // Background deepening: new page batches join the live document.
      return {
        ...state,
        sessionDocs: state.sessionDocs.map((d) =>
          d.id === a.docId ? { ...d, pages: [...d.pages, ...a.pages.filter((p) => !d.pages.some((x) => x.page === p.page))] } : d),
      };
    case 'vr-outbox':
      return { ...state, vrOutbox: a.text };
    case 'vr-log-push':
      return { ...state, vrLog: [...state.vrLog, a.entry].slice(-10) };
    case 'vr-log-clear':
      return { ...state, vrLog: [] };
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
    case 'demo-reset': {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(WS_KEY);
      for (const w of state.workspaces) localStorage.removeItem(convKey(w.id));
      // Reset lands on the boot workspace: restore its corpus if it was parked.
      const home = state.workspaces.find((w) => w.id === 'default');
      return {
        ...state,
        workspaceName: home?.name ?? (state.activeWorkspaceId === 'default' ? state.workspaceName : 'RepairCenter'),
        corpusDocs: home?.corpusDocs ?? state.corpusDocs,
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
        workspaces: [],
        activeWorkspaceId: 'default',
        studioOpen: false,
        previewBackup: null,
      };
    }
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

  // The engine routes between whatever agents the user left enabled - and
  // the ambient profile follows the lead agent (matters after a workspace
  // switch, for ingest-time classification; each step re-routes anyway).
  useEffect(() => {
    setWorkflowTeam(state.team);
    const lead = state.team.find((t) => t.active) ?? state.team[0];
    if (lead) setWorkflowProfile(lead.profile);
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

  // Persist conversations, one key per workspace.
  useEffect(() => {
    if (state.booted) localStorage.setItem(convKey(state.activeWorkspaceId), JSON.stringify(state.conversations));
  }, [state.booted, state.conversations, state.activeWorkspaceId]);

  // Persist the workspace manifest (light: no corpora). Ops serialize to
  // their specs and rebuild through opFromSpec - possible because every op
  // IS spec-materialized, nothing hand-wired.
  useEffect(() => {
    if (!state.booted) return;
    const entries = [
      ...state.workspaces,
      ...(state.activeWorkspaceId !== 'default'
        ? [{
          id: state.activeWorkspaceId, name: state.workspaceName,
          corpusDocs: state.previewBackup?.corpusDocs ?? state.corpusDocs,
          sessionDocs: [], conversations: [], team: state.team, ops: state.ops,
        }]
        : []),
    ];
    const list: PersistedWorkspace[] = entries
      .filter((w) => w.id !== 'default')
      .map((w) => ({
        id: w.id, name: w.name, corpusSource: corpusSourceOf(w.corpusDocs),
        team: w.team,
        opSpecs: w.ops.map(({ id, label, kind, cue, query }) => ({ id, label, kind, cue, query })),
      }));
    try { localStorage.setItem(WS_KEY, JSON.stringify(list)); } catch { /* quota: manifest only, safe to skip */ }
  }, [state.booted, state.workspaces, state.activeWorkspaceId, state.workspaceName, state.team, state.ops, state.corpusDocs, state.previewBackup]);

  // Reload: rebuild seed-backed workspaces from the manifest, parked. The
  // user lands on the boot workspace and switches back in one click.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!state.booted || hydratedRef.current) return;
    hydratedRef.current = true;
    let manifest: PersistedWorkspace[] = [];
    try { manifest = JSON.parse(localStorage.getItem(WS_KEY) ?? '[]') as PersistedWorkspace[]; } catch { return; }
    if (!Array.isArray(manifest) || manifest.length === 0) return;
    void Promise.all(
      manifest
        .filter((w) => SEED_SOURCES.has(w.corpusSource))
        .slice(0, 3)
        .map(async (w): Promise<WorkspaceSnapshot | null> => {
          try {
            const r = await fetch(`/${w.corpusSource}/docs.json`);
            if (!r.ok) return null;
            const corpusDocs = await r.json() as Document[];
            return {
              id: w.id, name: w.name, corpusDocs, sessionDocs: [],
              conversations: loadConversations(w.id),
              team: w.team, ops: (w.opSpecs ?? []).map(opFromSpec),
            };
          } catch { return null; }
        }),
    ).then((list) => {
      const ok = list.filter((x): x is WorkspaceSnapshot => x !== null);
      if (ok.length > 0) dispatch({ type: 'hydrate-workspaces', list: ok });
    });
  }, [state.booted]);

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
