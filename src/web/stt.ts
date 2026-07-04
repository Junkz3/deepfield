// Voice input - the technician speaks, NVIDIA Parakeet transcribes. Both go
// through the local relay (tools/tts-relay) which bridges the gRPC-only
// hosted ASR to plain HTTP. Without the relay (prod, or not launched) the
// mic button simply does not appear: relayAvailable() gates the UI.
import type { Lang } from './store';
import { NVIDIA_RELAY_URL } from './tts';

export interface SttDeps { fetchFn: typeof fetch }

const signal = (ms: number) =>
  typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined;

/** Send a recorded clip to the relay; resolves to the transcript ('' if silent). */
export async function transcribe(blob: Blob, lang: Lang, deps?: Partial<SttDeps>): Promise<string> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const res = await fetchFn(`${NVIDIA_RELAY_URL}/asr?lang=${encodeURIComponent(lang)}`, {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
    signal: signal(30_000),
  });
  if (!res.ok) throw new Error(`asr relay ${res.status}`);
  const data = await res.json() as { text?: string };
  return (data.text ?? '').trim();
}

/** One fast probe at mount: no relay, no mic button. */
export async function relayAvailable(deps?: Partial<SttDeps>): Promise<boolean> {
  try {
    const res = await (deps?.fetchFn ?? fetch)(`${NVIDIA_RELAY_URL}/health`, { signal: signal(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
