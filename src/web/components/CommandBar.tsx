// The tempered-glass command bar floating over the universe.
// One free-form input: ask the agent anything; it searches the universe.
import { useRef, useState } from 'react';
import type { Attachment } from '../../agent/types';
import { AgentDock } from './AgentDock';
import { VoiceInput } from './VoiceInput';
import { useApp } from '../store';

const PRESETS = [
  { label: 'Whirlpool E3', device: 'Whirlpool dishwasher', symptom: 'error code E3, does not heat' },
  { label: 'HMMWV DTC 21', device: 'HMMWV M1151', symptom: 'transmission DTC 21, throttle position sensor' },
];

/** "device — symptom" or "device: symptom" splits cleanly; anything else is a free question. */
function parse(text: string): { device: string; symptom: string } {
  const m = text.match(/^(.{3,60}?)\s*(?:—|--|:)\s*(.+)$/);
  if (m) return { device: m[1].trim(), symptom: m[2].trim() };
  return { device: text.trim(), symptom: 'as described by the technician' };
}

export function CommandBar() {
  const { state, dispatch } = useApp();
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<Attachment | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const attach = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setPhoto({ kind: 'image', dataUrl: String(reader.result), name: file.name });
    reader.readAsDataURL(file);
  };

  const launch = (device: string, symptom: string) => {
    dispatch({
      type: 'new-conversation',
      id: crypto.randomUUID(),
      device,
      symptom,
      attachments: photo ? [photo] : [],
    });
    setText('');
    setPhoto(null);
  };

  const submit = () => {
    if (!text.trim()) return;
    const { device, symptom } = parse(text);
    launch(device, symptom);
  };

  return (
    <div className="cmdbar-zone">
      <AgentDock />
      <div className="cmdbar-presets">
        {PRESETS.map((p) => (
          <button key={p.label} className="cmdbar-preset mono" onClick={() => launch(p.device, p.symptom)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className={`cmdbar ${photo ? 'has-photo' : ''}`}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
        />
        <button
          className="cmdbar-clip"
          title={photo ? `Attached: ${photo.name} (click to remove)` : 'Attach a photo of the fault'}
          onClick={() => (photo ? setPhoto(null) : fileRef.current?.click())}
        >
          {photo ? (
            <img src={photo.dataUrl} alt={photo.name} />
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M21 12.5V7a4 4 0 0 0-4-4H8.5a5.5 5.5 0 0 0 0 11H18a2.5 2.5 0 0 0 0-5H9.5a1 1 0 0 0 0 2H17" transform="rotate(45 12 12)" />
            </svg>
          )}
        </button>
        <input
          className="cmdbar-input"
          placeholder={
            (state.team.find((a) => a.active) ?? state.team[0])?.profile.decisionMode === 'answer'
              ? "Ask the agent: 'Is a cracked windscreen covered by my policy?' or any question about the documents"
              : "Ask the agent: 'Whirlpool dishwasher: error E3, no heat' or any question about the universe"
          }
          value={text}
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <VoiceInput
          lang={state.lang}
          onText={(t) => setText((prev) => (prev ? `${prev} ${t}` : t))}
          onSubmit={(t) => { const { device, symptom } = parse(t); launch(device, symptom); }}
        />
        <button className="cmdbar-go" onClick={submit} disabled={!text.trim()} title="Start">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
