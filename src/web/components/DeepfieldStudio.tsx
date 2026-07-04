import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Document } from '../../agent/types';
import type { TeamCalibration, TeamCalibrationInput } from '../../agent/team';
import { heuristicCalibration, presetTeam } from '../../agent/team';
import type { WorkspaceTool } from '../../agent/tools';
import { TOOL_REGISTRY } from '../../agent/tools';
import type { AgentSpec } from '../../agent/workflow';
import { setWorkflowProfile } from '../../agent/workflow';
import { getDriver } from '../driver-factory';
import { initialDriverKind, LANGS, useApp } from '../store';
import { splitSeedFiles } from '../studio';
import { Mascot } from './Mascot';
import './studio.css';

/** Deepfield Studio: the workspace creation screen shown before boot (?studio).
 *  RepairCenter is workspace one; the engine underneath is domain-agnostic.
 *  Presets map to shipped workflow profiles; Custom asks the model to write
 *  the agent's own configuration from the dropped corpus. */

const PRESETS = [
  { id: 'repair', label: 'Repair & field service', hasSeed: true, seedName: 'RepairCenter seed corpus' },
  { id: 'insurance', label: 'Insurance & warranty', hasSeed: true, seedName: 'Insurance seed corpus (6 public policy wordings)' },
  { id: 'legal', label: 'Legal discovery', hasSeed: false },
  { id: 'custom', label: 'Custom: auto-calibrate', hasSeed: false },
];

async function calibrateTeam(input: TeamCalibrationInput): Promise<TeamCalibration> {
  try {
    const driver = await getDriver(initialDriverKind());
    if (!driver.calibrateTeam) return heuristicCalibration(input);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
    return (await Promise.race([driver.calibrateTeam(input), timeout])) ?? heuristicCalibration(input);
  } catch {
    return heuristicCalibration(input);
  }
}

interface Props {
  onCreate: (name: string, corpus: Document[], liveFiles: File[], team: AgentSpec[], ops: WorkspaceTool[]) => void;
  /** In-app panel mode (sidebar stays visible): shows a close button. */
  onClose?: () => void;
}

export function DeepfieldStudio({ onCreate, onClose }: Props) {
  const { state, dispatch } = useApp();
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('repair');
  const [intent, setIntent] = useState('');
  const [seed, setSeed] = useState(true);
  /** The team being assembled: preset teams show up immediately, the custom
   *  team appears after calibration. Toggles carry into the workspace. */
  const [team, setTeam] = useState<AgentSpec[]>(() => presetTeam('repair'));
  /** The op registry being assembled: the shipped repair ops for the repair
   *  preset, the calibration-written ops for custom workspaces. */
  const [ops, setOps] = useState<WorkspaceTool[]>(() => TOOL_REGISTRY);
  /** Which of those ops stay enabled at creation. */
  const [toolIds, setToolIds] = useState<Record<string, boolean>>(
    () => Object.fromEntries(TOOL_REGISTRY.map((t) => [t.id, true])),
  );
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [closing, setClosing] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  /** The insurance seed corpus, fetched lazily on first preset selection
   *  (real pre-indexed public policy wordings, same rank as the repair seed). */
  const [insuranceDocs, setInsuranceDocs] = useState<Document[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (preset !== 'insurance' || insuranceDocs !== null) return;
    fetch('/corpus-insurance/docs.json')
      .then((r) => (r.ok ? (r.json() as Promise<Document[]>) : Promise.resolve<Document[]>([])))
      .catch(() => [] as Document[])
      .then(setInsuranceDocs);
  }, [preset, insuranceDocs]);

  /** In-app panel: pendingDocs only exists during boot studio mode, so the
   *  repair seed is fetched the same lazy way the insurance one is. */
  const [repairDocs, setRepairDocs] = useState<Document[] | null>(null);
  useEffect(() => {
    if (preset !== 'repair' || state.pendingDocs.length > 0 || repairDocs !== null) return;
    fetch('/corpus/docs.json')
      .then((r) => (r.ok ? (r.json() as Promise<Document[]>) : Promise.resolve<Document[]>([])))
      .catch(() => [] as Document[])
      .then(setRepairDocs);
  }, [preset, state.pendingDocs.length, repairDocs]);

  const activePreset = PRESETS.find((p) => p.id === preset);
  const seedAvailable = activePreset?.hasSeed ?? false;
  const seedOn = seedAvailable && seed;
  const seedDocs = preset === 'insurance'
    ? insuranceDocs ?? []
    : state.pendingDocs.length > 0 ? state.pendingDocs : repairDocs ?? [];

  const { matched, unmatched } = useMemo(
    () => splitSeedFiles(files, seedDocs),
    [files, seedDocs],
  );
  const corpus = useMemo(
    () => (seedOn ? seedDocs : matched),
    [seedOn, seedDocs, matched],
  );

  // The universe behind the card previews the corpus selection live.
  useEffect(() => {
    dispatch({ type: 'studio-preview', corpus });
  }, [corpus, dispatch]);

  const addFiles = (list: FileList | File[]) => {
    const next = [...list].filter((f) => !files.some((x) => x.name === f.name));
    if (next.length > 0) setFiles([...files, ...next]);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  const pickPreset = (id: string) => {
    setPreset(id);
    setSeed(PRESETS.find((p) => p.id === id)?.hasSeed ?? false);
    // Custom teams are born from calibration; presets show theirs right away.
    // Same for ops: only the repair preset ships hand-written ones.
    setTeam(id === 'custom' ? [] : presetTeam(id));
    const nextOps = id === 'repair' ? TOOL_REGISTRY : [];
    setOps(nextOps);
    setToolIds(Object.fromEntries(nextOps.map((t) => [t.id, true])));
    setCalibrated(false);
  };

  const toggleAgent = (id: string) => {
    const next = team.map((a) => (a.id === id ? { ...a, active: !a.active } : a));
    if (next.some((a) => a.active)) setTeam(next);
  };

  const dissolve = (chosenTeam: AgentSpec[], chosenOps: WorkspaceTool[]) => {
    setClosing(true);
    // Let the veil dissolve so the universe is already in view when it fills up.
    setTimeout(() => onCreate(name, corpus, unmatched, chosenTeam, chosenOps), 360);
  };

  const create = async () => {
    if (closing || calibrating) return;
    // Custom, first click: the model designs the TEAM and its workspace OPS
    // from the corpus and the intent sentence; both appear for review.
    if (preset === 'custom' && !calibrated) {
      setCalibrating(true);
      const c = await calibrateTeam({
        workspaceName: name.trim() || 'Workspace',
        fileNames: files.map((f) => f.name),
        intent: intent.trim() || undefined,
      });
      console.log(`[deepfield] calibrated team: ${c.team.map((a) => `${a.id} (${a.profile.decisionMode})`).join(', ')}${c.ops.length > 0 ? ` · ops: ${c.ops.map((o) => o.id).join(', ')}` : ' · no ops'}`);
      setTeam(c.team);
      setOps(c.ops);
      setToolIds(Object.fromEntries(c.ops.map((t) => [t.id, true])));
      setCalibrating(false);
      setCalibrated(true);
      return;
    }
    const chosen = team.length > 0 ? team : presetTeam('generic');
    if (preset === 'custom') setWorkflowProfile(chosen[0].profile);
    else setWorkflowProfile(preset);
    // The workspace installs only the ops left enabled - and none at all
    // when no agent diagnoses (the diagnose path is the ops' only consumer).
    // Team and ops travel WITH the create call: the store decides whether
    // this replaces the boot workspace or parks the current one.
    const chosenOps = chosen.some((a) => a.profile.decisionMode === 'diagnosis')
      ? ops.filter((t) => toolIds[t.id])
      : [];
    dissolve(chosen, chosenOps);
  };

  return (
    <div className={`studio ${closing ? 'closing' : ''}`}>
      <div className="studio-col">
        <header className="studio-head fade-up">
          <span className="studio-mark" />
          <h1 className="studio-title">Deepfield</h1>
          <p className="studio-tagline">
            Drop any document corpus in, get a cited agent workspace out.
          </p>
        </header>

        <section className="studio-card panel fade-up">
          {onClose && (
            <button className="studio-close mono" onClick={onClose} title="Back to the active workspace">
              CLOSE
            </button>
          )}
          <label className="studio-label mono" htmlFor="ws-name">Workspace</label>
          <input
            id="ws-name"
            className="studio-name"
            placeholder="RepairCenter"
            value={name}
            // touch: autofocus would shove the virtual keyboard over the form
            autoFocus={!window.matchMedia('(pointer: coarse)').matches}
            onChange={(e) => setName(e.target.value)}
          />

          <span className="studio-label mono">Workflow</span>
          <div className="studio-presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`studio-preset ${preset === p.id ? 'active' : ''}`}
                onClick={() => pickPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <>
              <span className="studio-label mono">Intent</span>
              <input
                className="studio-name studio-intent"
                placeholder="Who will use this agent, and for what? (optional)"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
              />
            </>
          )}

          <span className="studio-label mono">Agents</span>
          {team.length > 0 ? (
            <div className="studio-team">
              {team.map((a) => (
                <button
                  key={a.id}
                  className={`studio-agent ${a.active ? 'on' : ''}`}
                  onClick={() => toggleAgent(a.id)}
                  title={team.filter((x) => x.active).length === 1 && a.active ? `${a.charter} (at least one agent must stay active)` : a.charter}
                >
                  <span className="studio-agent-head">
                    <span className="studio-agent-dot" aria-hidden />
                    <span className="studio-agent-name">{a.label}</span>
                    <span className="studio-agent-mode mono">{a.profile.decisionMode}</span>
                  </span>
                  <span className="studio-agent-charter">{a.charter}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="studio-team-hint mono">
              The team calibrates itself from your corpus and intent when you create the workspace.
            </div>
          )}

          <span className="studio-label mono">Corpus</span>
          {seedAvailable && (
            <button className={`studio-seed ${seedOn ? 'on' : ''}`} onClick={() => setSeed(!seed)}>
              <span className="studio-seed-check" aria-hidden>{seedOn ? '✓' : ''}</span>
              <span className="studio-seed-name">{activePreset?.seedName}</span>
              <span className="studio-seed-count mono">
                {seedDocs.length > 0 ? `${seedDocs.length} documents, pre-indexed` : 'loading…'}
              </span>
            </button>
          )}
          <div
            className={`studio-drop ${dragOver ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
          >
            {files.length === 0
              ? <>Drop files here, or click to browse</>
              : <>Add more files</>}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".pdf,image/*,.txt,.log,.md"
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
          {files.length > 0 && (
            <ul className="studio-files">
              {files.map((f) => {
                const indexed = matched.some((d) => d.filename.toLowerCase() === f.name.toLowerCase());
                return (
                  <li key={f.name} className="studio-file">
                    <span className="studio-file-name mono">{f.name}</span>
                    <span className={`chip ${indexed ? 'studio-chip-ok' : 'studio-chip-live'}`}>
                      <span className="dot" />
                      {indexed ? 'already indexed' : 'live ingest'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {ops.length > 0 && (
            <>
              <span className="studio-label mono">Tool operations</span>
              <div className="studio-tools">
                {ops.map((t) => (
                  <button
                    key={t.id}
                    className={`studio-tool ${toolIds[t.id] ? 'on' : ''}`}
                    onClick={() => setToolIds({ ...toolIds, [t.id]: !toolIds[t.id] })}
                    title={t.hint}
                  >
                    <span className="studio-tool-dot" aria-hidden />
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <span className="studio-label mono">Language</span>
          <select
            className="studio-lang mono"
            value={state.lang}
            onChange={(e) => dispatch({ type: 'set-lang', lang: e.target.value })}
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </select>

          <button className="btn btn-primary studio-create" onClick={create} disabled={calibrating}>
            {calibrating ? 'Calibrating…' : preset === 'custom' && !calibrated ? 'Calibrate the team' : calibrated ? 'Enter workspace' : 'Create workspace'}
          </button>
          {calibrating ? (
            <div className="studio-summary studio-calibrating mono">
              Reading your corpus, shaping the agent team…
            </div>
          ) : calibrated ? (
            <div className="studio-summary studio-calibrated mono">
              Team calibrated. Review the agents above, then enter.
            </div>
          ) : (
            <div className="studio-summary mono">
              {corpus.length} documents ready
              {unmatched.length > 0 ? ` · ${unmatched.length} to ingest live` : ''}
            </div>
          )}
        </section>

        <div className="studio-nova fade-up" aria-hidden>
          <Mascot mood="idle" size={64} />
        </div>

        <footer className="studio-foot mono fade-up">
          deepfield · the document-universe engine
        </footer>
      </div>
    </div>
  );
}
