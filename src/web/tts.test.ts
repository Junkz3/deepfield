import { beforeEach, describe, expect, it, vi } from 'vitest';
import { speakVerdict, speechText, subscribeVoice, toggleVoice, voiceEnabled, xttsLang, __resetTtsCacheForTests, __setVoiceForTests } from './tts';

beforeEach(() => { __setVoiceForTests(true); __resetTtsCacheForTests(); });

const audioResponse = (blob: Blob) => ({
  ok: true,
  headers: { get: () => 'audio/mpeg' },
  blob: async () => blob,
}) as unknown as Response;

/** Default double: NVIDIA relay down (connection refused), Vultr healthy. */
const relayDownFetch = () => vi.fn(async (url: RequestInfo | URL) => {
  if (String(url).includes('127.0.0.1:8123')) throw new TypeError('fetch failed');
  return audioResponse(new Blob(['x']));
}) as unknown as typeof fetch;

const deps = (over: Partial<Parameters<typeof speakVerdict>[3]> = {}) => ({
  fetchFn: relayDownFetch(),
  play: vi.fn(),
  speakBrowser: vi.fn(() => true),
  ...over,
});

const callsTo = (fn: unknown, host: string) =>
  (fn as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes(host)).length;

describe('speechText', () => {
  it('strips page citations and markdown, collapses whitespace', () => {
    expect(speechText('Measure the **heater** (p.18): expect 15 ohms.'))
      .toBe('Measure the heater: expect 15 ohms.');
  });
  it('returns short text unchanged', () => {
    expect(speechText('Replace part W10518394.')).toBe('Replace part W10518394.');
  });
  it('cuts long text at the last sentence end before the limit', () => {
    const text = `${'First sentence about the heater circuit. '.repeat(10)}tail`;
    const out = speechText(text, 250);
    expect(out.length).toBeLessThanOrEqual(250);
    expect(out.endsWith('.')).toBe(true);
  });
  it('cuts at a word boundary when there is no sentence end', () => {
    const out = speechText('word '.repeat(100), 250);
    expect(out.length).toBeLessThanOrEqual(250);
    expect(out.endsWith(' wor')).toBe(false);
  });
});

describe('xttsLang', () => {
  it('maps supported store codes', () => {
    expect(xttsLang('fr')).toBe('fr');
    expect(xttsLang('zh')).toBe('zh-cn');
  });
  it('falls back to English for uncovered languages', () => {
    expect(xttsLang('uk')).toBe('en');
  });
});

describe('speakVerdict', () => {
  it('nvidia relay first when reachable, vultr proxy untouched', async () => {
    __resetTtsCacheForTests();
    const d = deps({ fetchFn: vi.fn(async () => audioResponse(new Blob(['x']))) as unknown as typeof fetch });
    const out = await speakVerdict('Replace the heater.', 'en', 'vultr', d);
    expect(out).toBe('nvidia');
    expect(callsTo(d.fetchFn, '127.0.0.1:8123')).toBe(1);
    expect(callsTo(d.fetchFn, '/api/agent')).toBe(0);
    expect(d.play).toHaveBeenCalledTimes(1);
  });

  it('relay down: synthesizes through the vultr proxy and plays the blob', async () => {
    __resetTtsCacheForTests();
    const d = deps();
    const out = await speakVerdict('Replace the heater.', 'en', 'vultr', d);
    expect(out).toBe('vultr');
    expect(callsTo(d.fetchFn, '/api/agent')).toBe(1);
    expect(d.play).toHaveBeenCalledTimes(1);
    expect(d.speakBrowser).not.toHaveBeenCalled();
  });

  it('vultr: caches per (text, lang) - second call does not refetch the proxy', async () => {
    __resetTtsCacheForTests();
    const d = deps();
    await speakVerdict('Replace the heater.', 'en', 'vultr', d);
    await speakVerdict('Replace the heater.', 'en', 'vultr', d);
    expect(callsTo(d.fetchFn, '/api/agent')).toBe(1);
    expect(d.play).toHaveBeenCalledTimes(2);
  });

  it('everything down: falls back to the browser voice', async () => {
    __resetTtsCacheForTests();
    const d = deps({
      fetchFn: vi.fn(async () => ({ ok: false, status: 500, text: async () => 'err' }) as unknown as Response) as unknown as typeof fetch,
    });
    const out = await speakVerdict('Replace the heater.', 'en', 'vultr', d);
    expect(out).toBe('browser');
    expect(d.speakBrowser).toHaveBeenCalledTimes(1);
  });

  it('fake driver: goes straight to the browser voice, no fetch', async () => {
    __resetTtsCacheForTests();
    const d = deps();
    const out = await speakVerdict('Replace the heater.', 'en', 'fake', d);
    expect(out).toBe('browser');
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it('stays silent when nothing can speak', async () => {
    __resetTtsCacheForTests();
    const d = deps({ speakBrowser: vi.fn(() => false) });
    const out = await speakVerdict('Replace the heater.', 'en', 'fake', d);
    expect(out).toBe('silent');
  });

  it('voice off: silent, no fetch, no browser voice', async () => {
    __setVoiceForTests(false);
    const d = deps();
    const out = await speakVerdict('Replace the heater.', 'en', 'vultr', d);
    expect(out).toBe('silent');
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(d.speakBrowser).not.toHaveBeenCalled();
  });
});

describe('voice preference', () => {
  it('toggles and notifies subscribers', () => {
    __setVoiceForTests(true);
    const seen: boolean[] = [];
    const off = subscribeVoice(() => seen.push(voiceEnabled()));
    toggleVoice();
    expect(voiceEnabled()).toBe(false);
    toggleVoice();
    expect(seen).toEqual([false, true]);
    off();
  });
});
