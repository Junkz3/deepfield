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
import './studio.css';

/** Deepfield Studio: the workspace creation screen shown before boot (?studio).
 *  RepairCenter is workspace one; the engine underneath is domain-agnostic.
 *  Presets map to shipped workflow profiles; Custom asks the model to write
 *  the agent's own configuration from the dropped corpus. */

const PRESETS = [
  { id: 'repair', label: 'Repair & field service', hasSeed: true },
  { id: 'insurance', label: 'Insurance & warranty', hasSeed: false },
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
  onCreate: (name: string, corpus: Document[], liveFiles: File[]) => void;
}

export function DeepfieldStudio({ onCreate }: Props) {
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
  const fileInput = useRef<HTMLInputElement>(null);

  const seedAvailable = PRESETS.find((p) => p.id === preset)?.hasSeed ?? false;
  const seedOn = seedAvailable && seed;

  const { matched, unmatched } = useMemo(
    () => splitSeedFiles(files, state.pendingDocs),
    [files, state.pendingDocs],
  );
  const corpus = useMemo(
    () => (seedOn ? state.pendingDocs : matched),
    [seedOn, state.pendingDocs, matched],
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

  const dissolve = () => {
    setClosing(true);
    // Let the veil dissolve so the universe is already in view when it fills up.
    setTimeout(() => onCreate(name, corpus, unmatched), 360);
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
    dispatch({
      type: 'set-ops',
      ops: chosen.some((a) => a.profile.decisionMode === 'diagnosis')
        ? ops.filter((t) => toolIds[t.id])
        : [],
    });
    dispatch({ type: 'set-team', team: chosen });
    dissolve();
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
          <label className="studio-label mono" htmlFor="ws-name">Workspace</label>
          <input
            id="ws-name"
            className="studio-name"
            placeholder="RepairCenter"
            value={name}
            autoFocus
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
              <span className="studio-seed-name">RepairCenter seed corpus</span>
              <span className="studio-seed-count mono">
                {state.pendingDocs.length > 0 ? `${state.pendingDocs.length} documents, pre-indexed` : 'loading…'}
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

        <footer className="studio-foot mono fade-up">
          deepfield · the document-universe engine
        </footer>
      </div>
    </div>
  );
}
