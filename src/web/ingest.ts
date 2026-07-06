// Live ingestion: any file dropped on the universe becomes a session document.
// PDFs are rendered CLIENT-SIDE with pdf.js (no server filesystem involved);
// the driver classifies from the first pages, and the file-card joins its
// constellation. Idempotent by slugified filename.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ModelDriver } from '../agent/driver';
import type { Document, Page } from '../agent/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function renderPdfPages(file: File, maxPages = 3): Promise<{ dataUrl: string; text: string }[]> {
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out: { dataUrl: string; text: string }[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1000 / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport } as any).promise;
    const text = (await page.getTextContent()).items.map((it: any) => it.str ?? '').join(' ');
    out.push({ dataUrl: canvas.toDataURL('image/png'), text });
  }
  return out;
}

const slug = (name: string) =>
  name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Full-depth background ingestion: after the fast 3-page classify pass, the
 *  REST of the PDF renders batch by batch and joins the document live. This
 *  is what makes a dropped 88-page policy as searchable as a built corpus.
 *  Each batch is kind-tagged (retrieval boost) when the driver supports it. */
export async function deepenDocument(
  file: File,
  doc: Document,
  driver: ModelDriver,
  onPages: (docId: string, pages: Page[]) => void,
  opts?: { maxPages?: number; batch?: number },
): Promise<void> {
  if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) return;
  const cap = opts?.maxPages ?? 120;
  const batchSize = opts?.batch ?? 8;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const last = Math.min(pdf.numPages, cap);
  for (let start = doc.pages.length + 1; start <= last; start += batchSize) {
    const end = Math.min(start + batchSize - 1, last);
    const batch: Page[] = [];
    for (let i = start; i <= end; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1000 / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport } as any).promise;
      const text = (await page.getTextContent()).items.map((it: any) => it.str ?? '').join(' ');
      batch.push({ docId: doc.id, page: i, imageUrl: canvas.toDataURL('image/png'), text: text.slice(0, 3000) || undefined, kind: 'other' });
    }
    if (driver.tagPages) {
      try {
        const kinds = await driver.tagPages(batch.map((p) => ({ page: p.page, text: p.text })));
        for (const p of batch) if (kinds[p.page]) p.kind = kinds[p.page];
      } catch { /* tags are a boost, never a blocker */ }
    }
    onPages(doc.id, batch);
  }
}

export async function ingestFile(file: File, driver: ModelDriver): Promise<Document> {
  let pageImages: string[] = [];
  let pageTexts: (string | undefined)[] = [];

  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const rendered = await renderPdfPages(file);
    pageImages = rendered.map((p) => p.dataUrl);
    pageTexts = rendered.map((p) => p.text || undefined);
  } else if (file.type.startsWith('image/')) {
    pageImages = [await readAsDataUrl(file)];
    pageTexts = [undefined];
  } else {
    // treat as plain text
    const text = await file.text();
    pageImages = [];
    pageTexts = [text.slice(0, 2000)];
  }

  const meta = await driver.classify({ filename: file.name, pageImages, pageTexts });

  const pages: Page[] = (pageImages.length > 0 ? pageImages : ['']).map((img, i) => ({
    docId: slug(file.name),
    page: i + 1,
    imageUrl: img,
    text: pageTexts[i]?.slice(0, 3000),
    kind: meta.pageKinds[i] ?? 'other',
  }));

  return {
    id: slug(file.name),
    filename: file.name,
    format: file.type.startsWith('image/') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'text',
    category: meta.category,
    brand: meta.brand,
    model: meta.model,
    docType: meta.docType,
    pages,
    sourceRights: 'Uploaded by the technician (session only)',
    origin: 'session',
  };
}
