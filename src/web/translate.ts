// Real-time translation layer. Nemotron reads the PAGE IMAGE and rewrites its
// content in the technician's language (part numbers, codes and units kept
// verbatim). Works on any page of the universe - scans included - because the
// input is the image, not extracted text. Cached per (page, language).
import { MODELS, proxyTransport } from '../vultr/client';
import type { Lang } from './store';
import { langName } from './store';

const cache = new Map<string, string>();

async function toDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) return imageUrl;
  const res = await fetch(imageUrl);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

export async function translatePage(
  docId: string,
  page: number,
  imageUrl: string,
  lang: Lang,
  driverKind: 'fake' | 'vultr',
): Promise<string> {
  const key = `${docId}/${page}/${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;

  if (driverKind === 'fake') {
    await new Promise((r) => setTimeout(r, 1200));
    const out = `[offline preview] This page would be read and rendered in ${langName(lang)}, structure preserved, part numbers kept verbatim. Switch to the live driver for real translation.`;
    cache.set(key, out);
    return out;
  }

  const t = proxyTransport();
  const r = await t('/chat/completions', {
    model: MODELS.omni,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Read this manual page and render its full content in ${langName(lang)}. Preserve the structure with short markdown headings and lists. Keep part numbers, error codes, units and connector names EXACTLY as printed. If a region is a diagram, describe it in one line in ${langName(lang)}. This is mechanical transcription work: keep any internal reasoning under 40 words, then output the translated content immediately.`,
        },
        { type: 'image_url', image_url: { url: await toDataUrl(imageUrl) } },
      ],
    }],
    max_tokens: 4000,
  });
  const out = r.choices?.[0]?.message?.content?.trim() ?? '';
  if (!out) {
    // Reasoning burned the budget: do NOT cache the failure.
    return 'The vision model ran out of budget on this dense page. Try again, or use a page with a text layer.';
  }
  cache.set(key, out);
  return out;
}

/** Text-layer pages do not need vision at all: join the exact block texts and
 *  let Kimi translate them - fast and reliable. */
export async function translateTextLayer(
  docId: string,
  page: number,
  blocks: { text: string }[],
  lang: Lang,
  driverKind: 'fake' | 'vultr',
): Promise<string> {
  const key = `pane-text/${docId}/${page}/${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lines = blocks.map((b) => b.text);
  const translated = await translateLines(`pane-lines/${docId}/${page}`, lines, lang, driverKind);
  const out = translated.join('\n\n');
  cache.set(key, out);
  return out;
}

export async function translateLines(
  cacheKey: string,
  lines: string[],
  lang: Lang,
  driverKind: 'fake' | 'vultr',
): Promise<string[]> {
  const key = `${cacheKey}/${lang}`;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit) as string[];
  let out: string[];
  if (driverKind === 'fake') {
    await new Promise((r) => setTimeout(r, 600));
    out = lines.map((l) => `[${lang}] ${l}`);
  } else {
    // Chunked so long pages never overflow the completion budget.
    const t = proxyTransport();
    const CHUNK = 8;
    out = [];
    for (let i = 0; i < lines.length; i += CHUNK) {
      const slice = lines.slice(i, i + CHUNK);
      const r = await t('/chat/completions', {
        model: MODELS.kimi,
        messages: [{
          role: 'user',
          content: `Translate each line into ${langName(lang)}. Keep part numbers, codes and units verbatim. Return STRICT JSON: an array of ${slice.length} strings, same order, nothing else. Lines:\n${JSON.stringify(slice)}`,
        }],
        max_tokens: 2400,
      });
      const text: string = r.choices?.[0]?.message?.content ?? '[]';
      try {
        const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as string[];
        out.push(...(arr.length === slice.length ? arr : slice));
      } catch {
        out.push(...slice);
      }
    }
  }
  cache.set(key, JSON.stringify(out));
  return out;
}


