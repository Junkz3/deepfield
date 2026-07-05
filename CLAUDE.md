# CLAUDE.md

Deepfield / RepairCenter: a document-grounded enterprise agent (RAISE hackathon,
Vultr track). Drop any document corpus in, get a cited agent workspace out; the
3D universe IS the retrieval, rendered visible. All inference runs on Vultr
Serverless Inference (Nemotron for reasoning and vision, VultronRetrieverPrime
for visual reranking); the API key never reaches a browser.

## Commands

```bash
npm run dev                 # vite dev server; /api/agent proxy reads app/.env
npm run build               # tsc + vite build -> dist/
npx vite preview            # serves dist/ WITH the /api/agent proxy (demo capture target)
npx vitest run              # unit tests
npm run demo                # offline scripted agent run in the terminal (FakeDriver)
npm run ingest              # rebuild public/corpus/ from corpus/manifest.json
npm run smoke               # live smoke test against the real Vultr endpoint
node deploy/server.mjs      # the production server (see deploy/ for the VM story)
```

Browser modes: `?driver=vultr` (default, live) / `?driver=fake` (offline script);
`?studio` boots into the workspace creation screen. `.env` is git-ignored and holds
`VULTR_INFERENCE_API_KEY` (+ `VULTR_BASE_URL`, and `NVIDIA_API_KEY` for the speech
relay); never commit it, never expose it client-side. Voice (mic button + TTS) needs
the relay running: `cd tools/tts-relay && ./venv/bin/python serve.py`; without it
the mic button is hidden and TTS falls back to Vultr, then the browser.

## Architecture in one breath

- `src/agent/loop.ts` is the agent: plan, retrieve (sufficiency-driven rounds,
  max 3), reason, agent-requested ops, decide. Every phase yields a `PhaseEvent`
  the UI narrates. `src/agent/taxonomy.ts` scopes and prefilters; retrieval is
  two-stage (text prefilter `trimPool`, then VISUAL rerank on page images).
- One seam for all inference: `ModelDriver` (`src/agent/driver.ts`). `FakeDriver`
  is the deterministic offline script (tests, demos); `VultrDriver`
  (`src/vultr/client.ts`) is live. Same loop, same UI, same events.
- Workspace identity is module-singleton state set by the React store's effects:
  `setWorkflowProfile` / `setWorkflowTeam` (`workflow.ts`), `installWorkspaceOps`
  (`tools.ts`), `setAgentLanguage` (`client.ts`). The store
  (`src/web/store.tsx`) keeps the ACTIVE workspace flat and parks the others as
  snapshots; everything that defines a workspace (team, ops, manifest) is plain
  serializable data.
- The calibration writes the workspace: `calibrateTeam` returns the agent team
  AND its operations. Every op reduces to two generic runners (`lookup` =
  targeted search over the corpus pages, `capture` = the user reports a
  real-world value). Nothing simulated: no fixture catalogs, no pre-filled
  measurement buttons, no decorative toggles - if a feature cannot run for
  real, it does not ship.

## Hard-won constraints (do not relearn these)

- **The diagnose prompt is lace.** It took four measured iterations to settle.
  Anything optional (op offer, page-citation line, followups) rides the FIRST
  ladder rung only; the fallback rungs stay the exact prompt the fragile cases
  passed on. `opsPromptSection(TOOL_REGISTRY)` is locked byte-identical by a
  unit test. Never change these prompts without re-running the live suite.
- **Vultr grants max_tokens/2** (measured: 8000 -> 4000, 16000 -> 8000), and the
  nginx gateway kills generations past ~60s (504). Usable budget is ~4000 real
  tokens; the retry ladders in `diagnose`/`answer`/`classify` handle both
  cap-burn regimes (dense pages, rumination on sparse evidence) and treat a
  transient 5xx as a lost rung, never a dead step.
- **Reasoning models spend their hidden thinking inside the completion budget.**
  Every prompt carries a brevity directive; `/no_think` returns empty content.
- **Model-written JSON is validated, never trusted**: strict parsers with
  deterministic fallbacks everywhere (`parseTeam`, `parseOps`, `extractJson`).
  A bad op or agent entry drops silently; the heuristic fallback ships.
- **Op requests are non-deterministic by design** - the agent chooses per
  verdict. A run where it requests nothing is not a regression; re-run before
  touching any prompt.
- `public/corpus*` is a build artifact (not versioned). The full-corpus
  docs.json is tens of MB: keep it out of git and let the server gzip it.

## Production VM (live at http://140.82.52.6)

`./deploy/deploy.sh root@<vm-ip>` does everything (build, node install, rsync,
systemd, port 80 via setcap). The local `.env` is rsynced to the server as-is:
`AUTH_ENABLED=1` turns on public signup with per-account daily inference quotas
(`USER_DAILY_LIMIT`, `GLOBAL_DAILY_LIMIT`, store under `/opt/repaircenter/data/`);
`DEMO_TOKEN=<secret>` is the private-link alternative (`/?key=<secret>`).
Two deployment lessons: `deploy/auth.mjs` must ship next to `server.mjs` (the
service import-crashes without it - the script now syncs both), and fresh
Vultr Ubuntu images firewall everything but SSH: `ufw allow 80/tcp` once.
SSH password auth is disabled on the VM; access is key-only.

## Testing discipline

Unit tests (`vitest`) cover the deterministic engine. Prompt or retrieval
changes are validated against the LIVE suite (a scripted set of repair,
Q&A and insurance cases run through the real Vultr driver) before merging:
run targeted cases first, the full suite before calling anything done.
Confidence is a deterministic rubric (`confidence.ts`), not model output.

## Copy rules

All code, comments and UI copy in English. No emojis. No em-dashes in
user-facing copy (use periods, colons, commas). Part numbers, error codes and
measured values stay verbatim as printed in the manuals.
