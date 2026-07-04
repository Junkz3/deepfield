// Sidebar row toggling the spoken verdict. Subscribes straight to the tts
// module: the voice preference lives there (not in the store), it only gates
// a side effect and nothing re-renders on it but this toggle.
import { useSyncExternalStore } from 'react';
import { subscribeVoice, toggleVoice, voiceEnabled } from '../tts';

export function VoiceToggle() {
  const on = useSyncExternalStore(subscribeVoice, voiceEnabled);
  return (
    <div className="sidebar-langs">
      <span className="sidebar-langs-label mono">VOICE</span>
      <button
        className={`sidebar-lang mono${on ? ' active' : ''}`}
        title="The agent reads its final verdict aloud in the selected language (Vultr TTS, browser voice as fallback)"
        aria-pressed={on}
        onClick={toggleVoice}
      >
        {on ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}
