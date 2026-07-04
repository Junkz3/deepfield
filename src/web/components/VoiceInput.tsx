// Push-to-talk for the command bar, two flows:
//  - click the mic: record, transcribe (NVIDIA Parakeet via the local relay),
//    the text lands in the input for review;
//  - hold the V key: record while held, release to transcribe and send the
//    request STRAIGHT to the agent (walkie-talkie). Escape cancels.
// The button only appears when the relay answers /health, so prod without a
// relay shows nothing. All failures are silent: the bar must never break
// because of a microphone.
import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../store';
import { relayAvailable, transcribe } from '../stt';
import './voice.css';

type Phase = 'hidden' | 'idle' | 'rec' | 'busy';
const MAX_SECONDS = 30;

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

export function VoiceInput({ lang, onText, onSubmit }: {
  lang: Lang;
  onText: (text: string) => void;
  /** When set, a V-key recording goes straight to the agent through this. */
  onSubmit?: (text: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [secs, setSecs] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const viaKeyRef = useRef(false);
  const cancelRef = useRef(false);
  const pendingStopRef = useRef(false); // V released while the mic was still opening
  const startFnRef = useRef<() => Promise<void>>(async () => {});
  const propsRef = useRef({ lang, onText, onSubmit });
  propsRef.current = { lang, onText, onSubmit };

  useEffect(() => {
    let alive = true;
    void relayAvailable().then((ok) => { if (alive && ok) setPhase('idle'); });
    return () => { alive = false; };
  }, []);

  // Hard cap: a forgotten open mic stops itself.
  useEffect(() => {
    if (phase === 'rec' && secs >= MAX_SECONDS) recRef.current?.stop();
  }, [phase, secs]);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        window.clearInterval(timerRef.current);
        const viaKey = viaKeyRef.current;
        viaKeyRef.current = false;
        if (cancelRef.current) {
          cancelRef.current = false;
          setSecs(0);
          setPhase('idle');
          return;
        }
        setPhase('busy');
        try {
          const text = await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), propsRef.current.lang);
          if (text) {
            const submit = propsRef.current.onSubmit;
            if (viaKey && submit) submit(text);
            else propsRef.current.onText(text);
          }
        } catch (err) {
          console.warn('[stt] transcription failed:', err);
        }
        setSecs(0);
        setPhase('idle');
      };
      recRef.current = rec;
      rec.start();
      setSecs(0);
      timerRef.current = window.setInterval(() => setSecs((s) => s + 1), 1000);
      setPhase('rec');
      if (pendingStopRef.current) { // tap-released V before the mic opened
        pendingStopRef.current = false;
        rec.stop();
      }
    } catch (err) {
      viaKeyRef.current = false;
      console.warn('[stt] microphone unavailable:', err);
    }
  };
  startFnRef.current = start;

  // Global walkie-talkie key. Ignored while typing in any field.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phaseRef.current === 'rec') {
        cancelRef.current = true;
        recRef.current?.stop();
        return;
      }
      if (e.key.toLowerCase() !== 'v' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target) || phaseRef.current !== 'idle') return;
      viaKeyRef.current = true;
      pendingStopRef.current = false;
      void startFnRef.current();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'v' || !viaKeyRef.current) return;
      if (recRef.current?.state === 'recording') recRef.current.stop();
      else pendingStopRef.current = true;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  if (phase === 'hidden') return null;
  return (
    <>
      {phase === 'idle' && <kbd className="voice-key mono" title="Hold V, speak, release: the request goes straight to the agent">V</kbd>}
      {phase === 'rec' && (
        <span className="voice-timer mono">{`0:${String(secs).padStart(2, '0')}`}</span>
      )}
      <button
        className={`voice-btn${phase === 'rec' ? ' rec' : ''}${phase === 'busy' ? ' busy' : ''}`}
        title={
          phase === 'rec' ? 'Stop and transcribe (Escape cancels)'
            : phase === 'busy' ? 'Transcribing (NVIDIA Parakeet)'
              : 'Speak your request - click to fill the bar, or hold V to talk straight to the agent'
        }
        aria-label="Voice input"
        disabled={phase === 'busy'}
        onClick={() => {
          if (phase === 'rec') recRef.current?.stop();
          else { viaKeyRef.current = false; void start(); }
        }}
      >
        {phase === 'busy' ? (
          <svg className="voice-spin" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-9-9" />
          </svg>
        ) : (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
            <path d="M12 17.5V21" />
          </svg>
        )}
      </button>
    </>
  );
}
