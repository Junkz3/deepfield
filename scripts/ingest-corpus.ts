// Build-time corpus ingest: render PDF pages to PNG (120 DPI), extract per-page text,
// apply manifest metadata (kinds), emit public/corpus/docs.json + taxonomy.json.
// Usage: npm run ingest            (all docs)
//        npm run ingest -- whirlpool-w11187658   (one doc)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTaxonomy } from '../src/agent/taxonomy';
import type { Document, Page, PageKind, Region } from '../src/agent/types';

interface ManifestDoc { id: string; file: string; pages: string; category: string; brand: string; model: string; docType: Document['docType']; sourceRights: string; kinds: Record<string, PageKind>; regions?: Record<string, Region> }
interface ManifestVideo { id: string; videoId: string; url: string; title: string; category: string; brand: string; model: string; sourceRights: string; chaptersFile: string }

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'corpus/src');
const OUT = join(ROOT, 'public/corpus');
const manifest = JSON.parse(readFileSync(join(ROOT, 'corpus/manifest.json'), 'utf8')) as { docs: ManifestDoc[]; videos?: ManifestVideo[] };
const only = process.argv[2];

function parseRanges(spec: string, pageCount: number): number[] {
  if (spec === 'all') return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.trim().split('-').map(Number);
    for (let p = a; p <= (b ?? a); p++) out.push(p);
  }
  return out;
}

const docs: Document[] = [];
for (const m of manifest.docs) {
  if (only && m.id !== only) continue;
  const pdf = join(SRC, m.file);
  if (!existsSync(pdf)) { console.warn(`SKIP ${m.id}: ${pdf} missing`); continue; }
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const pageCount = Number(/Pages:\s+(\d+)/.exec(info)![1]);
  const pages = parseRanges(m.pages, pageCount).filter((p) => p <= pageCount);
  const dir = join(OUT, m.id);
  mkdirSync(dir, { recursive: true });
  const docPages: Page[] = [];
  for (const p of pages) {
    const prefix = join(dir, `p${p}`);
    if (!existsSync(`${prefix}.png`)) {
      execFileSync('pdftoppm', ['-png', '-r', '120', '-f', String(p), '-l', String(p), '-singlefile', pdf, prefix]);
    }
    let text = '';
    try { text = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf8' }).trim(); } catch {}
    docPages.push({
      docId: m.id, page: p, imageUrl: `/corpus/${m.id}/p${p}.png`,
      text: text.slice(0, 600) || undefined,
      kind: m.kinds[String(p)] ?? 'other',
      region: m.regions?.[String(p)],
    });
    process.stdout.write(`\r${m.id}: p${p}/${pages[pages.length - 1]}   `);
  }
  console.log();
  docs.push({ id: m.id, filename: m.file, format: 'pdf', category: m.category, brand: m.brand, model: m.model, docType: m.docType, pages: docPages, sourceRights: m.sourceRights, origin: 'corpus' });
}

// Videos: chapters become timestamped segment pages; the official thumbnail is
// the segment image (embedded player handles playback - nothing re-hosted).
for (const v of manifest.videos ?? []) {
  if (only && v.id !== only) continue;
  const chapters = JSON.parse(readFileSync(join(ROOT, 'corpus', v.chaptersFile), 'utf8')) as { timestamp: number; title: string }[];
  const thumb = `/corpus/${v.id}/thumb.jpg`;
  if (!existsSync(join(ROOT, 'public', thumb.slice(1)))) console.warn(`WARN ${v.id}: missing ${thumb}`);
  docs.push({
    id: v.id,
    filename: v.title,
    format: 'video',
    category: v.category,
    brand: v.brand,
    model: v.model,
    docType: 'video',
    sourceRights: v.sourceRights,
    origin: 'corpus',
    pages: chapters.map((c, i) => {
      const frame = `/corpus/${v.id}/seg${i + 1}.jpg`;
      const hasFrame = existsSync(join(ROOT, 'public', frame.slice(1)));
      return {
        docId: v.id,
        page: i + 1,
        imageUrl: hasFrame ? frame : thumb,
        text: c.title,
        title: c.title,
        kind: 'video-segment' as PageKind,
        timestamp: c.timestamp,
        videoUrl: v.url,
      };
    }),
  });
  console.log(`${v.id}: ${chapters.length} segments`);
}

mkdirSync(OUT, { recursive: true });
// Single-doc runs must merge into the existing docs.json, not replace it.
let allDocs = docs;
if (only) {
  const existingPath = join(OUT, 'docs.json');
  const existing: Document[] = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) : [];
  const manifestOrder = manifest.docs.map((m) => m.id);
  const byId = new Map(existing.map((d) => [d.id, d]));
  for (const d of docs) byId.set(d.id, d);
  allDocs = [...byId.values()].sort((a, b) => manifestOrder.indexOf(a.id) - manifestOrder.indexOf(b.id));
}
writeFileSync(join(OUT, 'docs.json'), JSON.stringify(allDocs));
writeFileSync(join(OUT, 'taxonomy.json'), JSON.stringify(buildTaxonomy(allDocs)));
console.log(`Wrote ${allDocs.length} docs, ${allDocs.reduce((a, d) => a + d.pages.length, 0)} pages -> public/corpus/`);
