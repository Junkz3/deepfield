// Push-to-talk for the command bar: press the mic, speak, press again -
// NVIDIA Parakeet (through the local relay) turns it into text the user can
// review and send. The button only appears when the relay answers /health,
// so prod without a relay shows nothing. All failures are silent: the bar
// must never break because of a microphone.
import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../store';
import { relayAvailable, transcribe } from '../stt';
import './voice.css';

type Phase = 'hidden' | 'idle' | 'rec' | 'busy';
const MAX_SECONDS = 30;

export function VoiceInput({ lang, onText }: { lang: Lang; onText: (text: string) => void }) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [secs, setSecs] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef(0);

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
        setPhase('busy');
        try {
          const text = await transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), lang);
          if (text) onText(text);
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
    } catch (err) {
      console.warn('[stt] microphone unavailable:', err);
    }
  };

  if (phase === 'hidden') return null;
  return (
    <>
      {phase === 'rec' && (
        <span className="voice-timer mono">{`0:${String(secs).padStart(2, '0')}`}</span>
      )}
      <button
        className={`voice-btn${phase === 'rec' ? ' rec' : ''}${phase === 'busy' ? ' busy' : ''}`}
        title={
          phase === 'rec' ? 'Stop and transcribe'
            : phase === 'busy' ? 'Transcribing (NVIDIA Parakeet)'
              : 'Speak your request - NVIDIA Parakeet transcribes it'
        }
        aria-label="Voice input"
        disabled={phase === 'busy'}
        onClick={() => (phase === 'rec' ? recRef.current?.stop() : void start())}
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
