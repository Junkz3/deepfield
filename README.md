# RepairCenter

A manual-agnostic, document-grounded repair agent. Built solo in 24 hours for the RAISE Summit
hackathon (Statement Two, Vultr track).

Drop in any repair documentation: service manuals, user guides, scanned military TMs, iFixit
guides, even videos. The agent reads every page as an image, classifies each document, and
auto-organizes the whole corpus into a knowledge base rendered as a navigable 3D universe of
files. A technician then describes a fault in any language. The agent plans, retrieves the right
pages visually, decides on its own when the evidence is not sufficient, reads schematics, calls
tools (parts stock, measurements), and delivers a cited step-by-step repair path with an
explained confidence score. Every claim links to the exact page, table row, wiring fold-out or
video second it came from.

The 3D universe is not decoration: it is the retrieval made visible. When the agent searches,
lightning probes the candidate files; when it cites, the real pages fan out in space; documents
outside the conversation scope fade to ghosts.

## Models (all on Vultr Serverless Inference)

| Role | Model |
|---|---|
| Visual retrieval (two-stage rerank over page images) | vultr/VultronRetrieverPrime-Qwen3.5-8B |
| Vision, diagnosis, translation (reads pages and photos) | nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16 |
| Planning and sufficiency orchestration | moonshotai/Kimi-K2.6 |

There is no vector store and no OCR pipeline in the retrieval path. Stage 1 narrows candidates by
taxonomy scope plus a lexical prefilter; stage 2 lets VultronRetriever score the actual page
images against the query. Scanned schematics and fold-outs rank correctly because the pages are
seen, not text-extracted.

## Multilingual by design

The technician picks any of 27 languages. The agent narrates its plan, its retrieval decisions
and its diagnosis in that language, while retrieval queries are always planned in English so the
search stays sharp on an English corpus (VultronRetriever is natively cross-lingual for its six
core languages). Any page can be translated in place: layout blocks come from the PDF text layer
(pixel-true positions extracted at ingest), Nemotron translates the words, and the patches
inherit the original type size, background and alignment. Only the words change. Scans without a
text layer fall back to a side-pane read of the page image.

## Run it

```
npm install
npm run demo        # offline agent loop in the terminal, no API key needed
npm run dev         # web app on http://localhost:5173 (offline scripted driver)
npm test            # 29 unit tests (agent loop, taxonomy, confidence rubric)
```

With a Vultr Serverless Inference key the same UI runs live: put the key in `.env`
(`VULTR_INFERENCE_API_KEY`, `VULTR_BASE_URL`), then open `/?driver=vultr`. The dev server (and
the production proxy in `functions/api/agent.ts`) forwards only `/chat/completions` and
`/rerank`; the key never reaches the browser.

## Corpus

The demo universe ships 30 documents across 26 device categories, ingested at FULL depth
(thousands of pages): complete service and user manuals, military TMs, a repair video with
chapter-accurate citations. Retrieval cost does not grow with corpus size: the two-stage
design always sends at most 24 page images to the visual reranker per query. `npm run ingest`
rebuilds `public/corpus/` from `corpus/manifest.json` (pages rendered at 120 DPI, text layer
and layout blocks extracted per page, video chapters mapped to timestamped segments). The
generated corpus is a build artifact and is not versioned in this repo.

Sources and rights for every document are listed in [SOURCES.md](SOURCES.md). Nothing is
re-hosted that should not be: videos play in the official embedded player.

## Architecture

```
src/agent/      loop.ts (plan, retrieve xN, reason, tools, decide), taxonomy, confidence
src/vultr/      client.ts (VultrDriver: two-stage visual retrieval, diagnosis, translation)
src/web/        React app: 3D universe (react-three-fiber), conversation panel, viewer
functions/      stateless API proxy (allowlist, rate limit, no key in browser)
scripts/        corpus ingest (pdftoppm, pdftotext -bbox, yt-dlp chapters, ffmpeg frames)
```

The whole agent runs through one seam (`ModelDriver`): a scripted offline driver for
deterministic tests and demos, and the live Vultr driver. Same loop, same UI, same events.
