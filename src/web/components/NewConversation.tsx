// Entry point of a repair job: device + symptom + optional photo of the fault.
import { useRef, useState } from 'react';
import type { Attachment } from '../../agent/types';
import { useApp } from '../store';

const PRESETS = [
  { device: 'Whirlpool dishwasher', symptom: 'error code E3, does not heat' },
  { device: 'HMMWV M1151', symptom: 'transmission DTC 21, throttle position sensor' },
];

export function NewConversation() {
  const { dispatch } = useApp();
  const [device, setDevice] = useState('');
  const [symptom, setSymptom] = useState('');
  const [photo, setPhoto] = useState<Attachment | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const attach = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setPhoto({ kind: 'image', dataUrl: String(reader.result), name: file.name });
    reader.readAsDataURL(file);
  };

  const start = () => {
    if (!device.trim() || !symptom.trim()) return;
    dispatch({
      type: 'new-conversation',
      id: crypto.randomUUID(),
      device: device.trim(),
      symptom: symptom.trim(),
      attachments: photo ? [photo] : [],
    });
  };

  const [ask, setAsk] = useState('');
  const askUniverse = () => {
    if (!ask.trim()) return;
    dispatch({
      type: 'new-conversation',
      id: crypto.randomUUID(),
      device: ask.trim(),
      symptom: 'knowledge base inquiry',
      attachments: [],
    });
  };

  return (
    <div className="newconv panel">
      <div className="newconv-title">Describe the fault</div>
      <div className="newconv-row">
        <input
          placeholder="Device (brand, model)"
          value={device}
          onChange={(e) => setDevice(e.target.value)}
        />
        <input
          placeholder="Symptom (error code, behavior)"
          value={symptom}
          onChange={(e) => setSymptom(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && start()}
        />
      </div>
      <div className="newconv-actions">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
        />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          {photo ? `Photo: ${photo.name}` : 'Attach a photo'}
        </button>
        {photo && (
          <button className="btn" title="Remove photo" onClick={() => setPhoto(null)}>
            Remove
          </button>
        )}
        <button className="btn btn-primary" onClick={start} disabled={!device.trim() || !symptom.trim()}>
          Start diagnosis
        </button>
      </div>
      <div className="newconv-ask">
        <span className="newconv-ask-label mono">OR</span>
        <input
          placeholder="Ask the knowledge base anything ('what do we know about the HMMWV transmission?')"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && askUniverse()}
        />
      </div>
      <div className="newconv-presets">
        {PRESETS.map((p) => (
          <button
            key={p.device}
            className="newconv-preset mono"
            onClick={() => {
              setDevice(p.device);
              setSymptom(p.symptom);
            }}
          >
            {p.device} — {p.symptom}
          </button>
        ))}
      </div>
    </div>
  );
}
