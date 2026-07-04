import type { Document } from '../agent/types';

/**
 * Cache-hit resolution for the Deepfield Studio drop zone: files whose name matches a
 * seed-corpus document resolve to their pre-indexed version (ingest happened at build
 * time); everything else queues for live ingest once the workspace opens.
 */
export function splitSeedFiles<T extends { name: string }>(
  files: T[],
  seedDocs: Document[],
): { matched: Document[]; unmatched: T[] } {
  const byFilename = new Map(seedDocs.map((d) => [d.filename.toLowerCase(), d]));
  const matched: Document[] = [];
  const unmatched: T[] = [];
  for (const file of files) {
    const doc = byFilename.get(file.name.toLowerCase());
    if (doc && !matched.includes(doc)) matched.push(doc);
    else if (!doc) unmatched.push(file);
  }
  return { matched, unmatched };
}
