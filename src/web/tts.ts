// Voice of the agent - the final verdict is read aloud in the technician's
// language. TTS runs on Vultr Serverless Inference (xtts, multilingual) through
// the /api/agent proxy; any failure falls back to the browser's speechSynthesis
// so the demo beat survives a service outage. Fire-and-forget: no TTS error may
// ever reach the timeline or delay the result render. Cached per (text, lang).
import type { Lang } from './store';

/** Coqui XTTS v2 language coverage (the model Vultr serves); others speak English. */
const XTTS_LANGS: Record<string, string> = {
  en: 'en', fr: 'fr', de: 'de', es: 'es', it: 'it', pt: 'pt', nl: 'nl', pl: 'pl',
  tr: 'tr', ru: 'ru', ar: 'ar', hi: 'hi', zh: 'zh-cn', ja: 'ja', ko: 'ko', cs: 'cs', hu: 'hu',
};
export const xttsLang = (lang: Lang): string => XTTS_LANGS[lang] ?? 'en';

// Validated against the live endpoint: unknown names get 422 "Voice Not Found",
// Coqui XTTS v2 speaker names pass validation. /audio/voices itself is broken.
const VOICE = 'Ana Florence';

// Voice preference lives here, not in the store (same precedent as
// setAgentLanguage in vultr/client.ts): it gates a side effect, no view
// re-renders on it except the toggle itself, which subscribes below.
let voiceOn = (() => {
  try { return localStorage.getItem('rc.voice') !== 'off'; } catch { return true; }
})();
const voiceListeners = new Set<() => void>();
export const voiceEnabled = (): boolean => voiceOn;
export function toggleVoice(): void {
  voiceOn = !voiceOn;
  try { localStorage.setItem('rc.voice', voiceOn ? 'on' : 'off'); } catch { /* private mode */ }
  if (!voiceOn) stopSpeaking();
  voiceListeners.forEach((l) => l());
}
/** For useSyncExternalStore: returns the unsubscribe. */
export function subscribeVoice(cb: () => void): () => void {
  voiceListeners.add(cb);
  return () => { voiceListeners.delete(cb); };
}
export function __setVoiceForTests(on: boolean) { voiceOn = on; }

function stopSpeaking(): void {
  currentAudio?.pause();
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** What actually gets spoken: citations and markdown stripped, whitespace
 *  collapsed, cut at the last sentence end (or word) before the limit. */
export function speechText(text: string, max = 250): string {
  const plain = text
    .replace(/\s*\(p\.\s*\d+[^)]*\)/gi, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > 60) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(' ');
  return word > 0 ? cut.slice(0, word) : cut;
}

export interface TtsDeps {
  fetchFn: typeof fetch;
  play: (blob: Blob) => void;
  /** returns false when the browser voice is unavailable */
  speakBrowser: (text: string, lang: Lang) => boolean;
}

const blobCache = new Map<string, Blob>();
export function __resetTtsCacheForTests() { blobCache.clear(); }

let currentAudio: HTMLAudioElement | null = null;

function defaultPlay(blob: Blob): void {
  if (typeof Audio === 'undefined') throw new Error('no Audio');
  stopSpeaking();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  audio.onended = () => URL.revokeObjectURL(url);
  void audio.play().catch(() => URL.revokeObjectURL(url));
}

function defaultSpeakBrowser(text: string, lang: Lang): boolean {
  if (typeof speechSynthesis === 'undefined') return false;
  stopSpeaking();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(lang));
  if (voice) utter.voice = voice;
  utter.rate = 1.05;
  speechSynthesis.speak(utter);
  return true;
}

async function synthesizeVultr(text: string, lang: Lang, fetchFn: typeof fetch): Promise<Blob> {
  const key = `${lang}/${text}`;
  const hit = blobCache.get(key);
  if (hit) return hit;
  const res = await fetchFn('/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: '/audio/speech',
      body: { model: 'xtts', input: text, voice: VOICE, language: xttsLang(lang) },
    }),
    signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  // Response shape unverified while the service is down: handle both raw audio
  // and JSON-wrapped base64 (docs/superpowers/specs/2026-07-04-agent-voice-tts-design.md).
  const type = res.headers.get('content-type') ?? '';
  let blob: Blob;
  if (type.includes('json')) {
    const data = await res.json() as { audio?: string; data?: { b64_json?: string }[] };
    const b64 = data.audio ?? data.data?.[0]?.b64_json;
    if (!b64) throw new Error('tts: no audio in JSON response');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: 'audio/mpeg' });
  } else {
    blob = await res.blob();
  }
  if (blob.size === 0) throw new Error('tts: empty audio');
  blobCache.set(key, blob);
  return blob;
}

/** Speak the final verdict. Never throws; resolves to which voice spoke. */
export async function speakVerdict(
  text: string,
  lang: Lang,
  driverKind: 'fake' | 'vultr',
  deps?: Partial<TtsDeps>,
): Promise<'vultr' | 'browser' | 'silent'> {
  const d: TtsDeps = {
    fetchFn: deps?.fetchFn ?? fetch,
    play: deps?.play ?? defaultPlay,
    speakBrowser: deps?.speakBrowser ?? defaultSpeakBrowser,
  };
  if (!voiceOn) return 'silent';
  const spoken = speechText(text);
  if (!spoken) return 'silent';
  if (driverKind === 'vultr') {
    try {
      d.play(await synthesizeVultr(spoken, lang, d.fetchFn));
      return 'vultr';
    } catch (err) {
      console.warn('[tts] Vultr synthesis failed, falling back to browser voice:', err);
    }
  }
  try {
    if (d.speakBrowser(spoken, lang)) return 'browser';
  } catch (err) {
    console.warn('[tts] browser voice failed:', err);
  }
  return 'silent';
}
