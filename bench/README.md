# Live benchmark: real performance and generalization

This is the measured-performance side of Deepfield. The same methodology that
ships inside the product as the self-check feature, but against a versioned
gold set of hand-verified facts instead of model-written probes. Nothing is
mocked: every run drives the production agent loop (`runStep`) with the
production `VultrDriver` against the live Vultr Serverless Inference endpoint.

```bash
set -a; source .env; set +a
npm run bench                                  # full gold set (about 20 min, 2 in flight)
npm run bench -- --only diag-whirlpool-e3      # targeted case
npm run bench -- --group insurance,french      # one or more families
```

Results land in `bench/results/<label>.json` with, per item: pass verdict,
status, literal-fact hit, cited doc, cited page (+-1), video timestamps,
confidence, retrieval rounds, per-phase latency, the full phase timeline
(including the actual retrieval queries the plan wrote) and the answer.

## Gold set design

39 questions in `goldset.json`, every answer verified on the printed page
before writing the item. Ten families, each probing a different way the
system could fail to generalize:

| Family | Items | What it proves |
| --- | --- | --- |
| factual-qa | 12 | Precise values across 12 device types (ranges, ratios, part specs), incl. a fact printed on a FRENCH page of a bilingual manual and a scanned military resistance chart |
| diagnose | 6 | Error codes never rehearsed during development (E4, E6, Jam Rear, fails-to-crank) next to the two positive controls (E3, DTC 21) |
| french | 4 | French questions over the English corpus: query translation, French verdicts |
| paraphrase | 2 | The symptom described colloquially, without the error code ("quick and glass lights flash, dishes come out cold" must map to E3) |
| out-of-corpus | 3 | Honest refusal: Tesla, PS5 (near-category trap: a Joy-Con guide exists), iPhone 14 (near-model trap: SE 2020 battery guide exists) |
| missing-fact | 2 | Admitting what the pages do not hold (4K on a 1080p camera, a device-specific Wi-Fi key) |
| cross-doc | 1 | Two printer manuals in scope; the right one must be cited |
| video | 2 | Timestamped segment citations, via the action button and via natural language |
| scope | 1 | Workspace inventory answered from the taxonomy itself |
| insurance | 6 | Same engine, other vertical: coverage limits, exclusion polarity, a scoping trap (the Allianz product is classified under its underwriter Jefferson) |

Scoring is deterministic (`scoreProbe`, shared with the product self-check):
a pass needs the literal expected value in the normalized answer AND the
expected document cited (page +-1 tracked separately as retrieval strictness).
For out-of-corpus items the honest no-evidence step IS the pass.

## Results

Run 1 (2026-07-05, before fixes): 29/39 (74 percent), doc cited 34/34,
page +-1 27/29 (93 percent), p50 latency 31.6s, zero harness errors.

Failure triage on run 1:

- 3 scoring false negatives (the engine was right): unicode dashes in
  "90-135 VAC" broke literal matching (fixed in `selfcheck.ts`, now unit
  tested), a US-variant FM range read off the same page, and a "do not
  contain" phrasing the marker list missed (gold set widened).
- 2 retrieval-variance misses on 300+ page manuals: the plan sometimes
  writes queries carrying the device name, and the visual rerank then crowns
  the pages that DISPLAY that name (covers, title pages) over the fault
  table. Measured: with the plan's query the Brother "Jam Rear" table ranks
  6th (6.88) behind five covers (8.61 to 7.08); with the bare symptom it
  ranks 1st. Both cases passed on rerun; the reproducible one (Brother) is
  now covered by the SECOND LOOK in `loop.ts`: when diagnose returns
  insufficient evidence, retry once with the bare symptom over the unread
  pages. Triggers only on the failure path.
Run 2 (2026-07-05, after fixes): 34/39 (87 percent), doc cited 34/34,
page +-1 29/29 (100 percent), p50 latency 40.1s, zero harness errors.

Reading run 2's answers exposed two FALSE passes: the Wi-Fi answer named
the type label but still quoted the manual's SAMPLE key, and the boiler
answer said "Yes" while matching the question's own "15 years" echo. The
harness was hardened (mustNotContain field, echo markers removed) and the
one-line prompt guards written against those two cases were REVERTED after
measurement: they did not fix either answer, and a stricter intent cascade
tried at the same time regressed an unrelated QA item into the diagnose
mold. Lesson kept: the gold set gets stricter, the prompts stay generic.
One generic routing fix survived its measurements: workspace-inventory
questions route to scope before the informational-question net (was 0/3 on
informal French, 3/3 after, no intent regression across 6 control items).

Run 4 (2026-07-05, final state, hardened scoring): **36/39 (92 percent)**,
doc cited 34/34, page +-1 29/29 (100 percent), p50 latency 34.1s, zero
harness errors. factual-qa 12/12, french 4/4, out-of-corpus 3/3,
paraphrase 2/2, video 2/2. The three misses: the sample-key quote (killed
by mustNotContain, exactly as designed), the exclusion polarity, and one
retrieval-variance miss on the scanned 207-page HMMWV manual (passes 4 of
5 runs; the honest no-evidence step is the failure shape, never an
invented verdict).

## Known failure modes (kept, documented)

Left as measured weaknesses. One-line prompt guards were tried against the
first two and MEASURED ineffective (the answers did not change), so they
were reverted: the engine stays generic, the failure modes stay documented
(the diagnose prompt is lace; see CLAUDE.md):

1. **Example values read as truth.** Asked for "the default Wi-Fi key of my
   router", the agent quotes the sample key printed in a manual illustration
   as if it were the user's, even while correctly naming the type label as
   the source. The bench kills this with mustNotContain.
2. **Exclusion polarity - fully characterized, model-level.** "Are repairs
   to a boiler over 15 years old covered?" answers "Yes." while the item
   sits in a "What is not covered" list. Everything upstream was ruled out
   by measurement: the heading page IS retrieved (cited second), a
   deterministic splice that guarantees the heading page in the evidence
   changed nothing, and re-ordering the evidence into reading order (heading
   page first) still produced "Yes, covered (p.11)" - citing the very page
   that prints the exclusions heading. A one-line prompt guard had already
   measured ineffective. Both deterministic mechanisms were reverted
   (neutral on target, and the discipline is: what does not measurably fix
   does not ship). Conclusion: the reader model does not bind a continued
   list to its section heading across page images or across a page's own
   vertical structure; the visible "What is covered" title wins. This needs
   a stronger reader or model-level work, not engine plumbing. The bench
   holds the case; any future model swap gets measured against it.
   Final escalation, also measured: an explicit continuity FACT in the
   prompt ("the list at the top of p.12 continues the section on p.11; its
   items belong to that heading") changed nothing - the model answered
   "covered, as listed under item 2a (p.12)", citing the exclusion item
   itself as proof of coverage. Not a binding failure then: a polarity
   prior ("home emergency covers repairs") that survives even a spelled-out
   structural fact. Reverted like the rest; model-level stands confirmed.
3. **Near-model transfer without a disclaimer.** iPhone 14 screen question
   can answer with opening steps from the iPhone SE 2020 BATTERY guide
   without flagging either mismatch (intermittent; run 4 passed). Confidence
   self-reports low (0.20), which the UI surfaces, but the verdict should
   name the mismatch.
4. **Scanned-manual retrieval variance.** On the 207-page scanned HMMWV TM,
   the plan's query wording decides whether the fault table surfaces; about
   1 run in 5 ends in an honest no-evidence step instead of the verdict.
   The second-look retry recovers part of this; the residue is documented.
