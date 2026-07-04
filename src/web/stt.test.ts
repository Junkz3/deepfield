import { describe, expect, it, vi } from 'vitest';
import { relayAvailable, transcribe } from './stt';

const jsonResponse = (obj: unknown, ok = true, status = 200) => ({
  ok, status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
}) as unknown as Response;

describe('transcribe', () => {
  it('posts the clip to the relay and returns the trimmed text', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ text: '  Whirlpool dishwasher error E3  ' })) as unknown as typeof fetch;
    const out = await transcribe(new Blob(['x'], { type: 'audio/webm' }), 'en', { fetchFn });
    expect(out).toBe('Whirlpool dishwasher error E3');
    const url = String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain('/asr?lang=en');
  });

  it('throws on relay error status', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'down' }, false, 503)) as unknown as typeof fetch;
    await expect(transcribe(new Blob(['x']), 'en', { fetchFn })).rejects.toThrow('asr relay 503');
  });

  it('returns empty string when the relay hears nothing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ text: '' })) as unknown as typeof fetch;
    expect(await transcribe(new Blob(['x']), 'fr', { fetchFn })).toBe('');
  });
});

describe('relayAvailable', () => {
  it('true when /health answers', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    expect(await relayAvailable({ fetchFn })).toBe(true);
  });
  it('false when the relay is unreachable', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await relayAvailable({ fetchFn })).toBe(false);
  });
});
