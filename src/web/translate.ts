// Real-time translation layer. Nemotron reads the PAGE IMAGE and rewrites its
// content in the technician's language (part numbers, codes and units kept
// verbatim). Works on any page of the universe - scans included - because the
// input is the image, not extracted text. Cached per (page, language).
import { MODELS, proxyTransport } from '../vultr/client';
import type { Lang } from './store';
import { LANG_NAMES } from './store';

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

  let out: string;
  if (driverKind === 'fake') {
    await new Promise((r) => setTimeout(r, 1200));
    out = `[offline preview] This page would be read by Nemotron and rendered in ${LANG_NAMES[lang]}, structure preserved, part numbers kept verbatim. Switch to the live driver for real translation.`;
  } else {
    const t = proxyTransport();
    const r = await t('/chat/completions', {
      model: MODELS.omni,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Read this manual page and render its full content in ${LANG_NAMES[lang]}. Preserve the structure with short markdown headings and lists. Keep part numbers, error codes, units and connector names EXACTLY as printed. If a region is a diagram, describe it in one line in ${LANG_NAMES[lang]}. Do not deliberate: keep any internal reasoning under 50 words, then output ONLY the translated content.`,
          },
          { type: 'image_url', image_url: { url: await toDataUrl(imageUrl) } },
        ],
      }],
      max_tokens: 2400,
    });
    out = r.choices?.[0]?.message?.content?.trim() || 'Translation unavailable.';
  }
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
    const t = proxyTransport();
    const r = await t('/chat/completions', {
      model: MODELS.kimi,
      messages: [{
        role: 'user',
        content: `Translate each line into ${LANG_NAMES[lang]}. Return STRICT JSON: an array of strings, same length and order. Lines:\n${JSON.stringify(lines)}`,
      }],
      max_tokens: 1600,
    });
    const text: string = r.choices?.[0]?.message?.content ?? '[]';
    try {
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as string[];
      out = arr.length === lines.length ? arr : lines;
    } catch {
      out = lines;
    }
  }
  cache.set(key, JSON.stringify(out));
  return out;
}
