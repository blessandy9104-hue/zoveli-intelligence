# Domains

Each domain is deterministic, local, and returns evidence plus disclosures.
This document records the exact behavior a caller can rely on.

## Documents

**Purpose:** answer questions from files the owner explicitly indexed.

**Inputs**

- `indexPaths(paths)`: files or directories inside configured roots.
- `search(query, limit)`: query string, 1–50 results.
- `answer(query, limit)`: routed through the governor, so it produces a receipt.
- `list()`, `stats()`, `forget(source)`.

**Outputs**

- Search hits: source path, title, start/end line, BM25 score, excerpt, chunk
  SHA-256.
- Answers: quoted sentences with `[title, lines x-y]` citations, `grounded`
  verification, document evidence.
- Refusal: when nothing matches, `unverified`, confidence 0, no evidence, and a
  disclosure that no external source was consulted.

**Semantics**

- Retrieval is BM25 over word chunks (220 words, 40-word overlap by default).
- Answers are extractive. The subsystem never paraphrases from general
  knowledge and never calls a model.
- At most three sources and two sentences per source are quoted.
- Confidence is derived from the top BM25 score and capped at 0.95.

**Limits and non-goals**

- Text-like formats only. PDFs, images, audio, and Office binaries are skipped.
- No OCR, no embeddings, no semantic vector search in 0.1.
- No crawling, no watching, no automatic re-index.
- A hostile document can contain instruction-like text. It is quoted as data;
  the host must not execute it.

**Security**

- Reads are confined to configured roots after realpath resolution.
- Symlinks are skipped during walks.
- Files over the size limit are rejected per file.
- `forget()` never deletes the source file.

## Market

**Purpose:** describe historical/current price structure from a supplied window.

**Input:** 2–10,000 observations, each a finite close price or
`{ close, high?, low? }`, plus an instrument type and optional timeframe and
user context.

- Instrument types: `equity_index`, `equity`, `commodity`, `fx`, `crypto`,
  `treasury`.
- Timeframes: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`.
- Validation rejects non-finite values, `high < low`, and a close outside the
  high/low range.

**Outputs**

- `trend`: `uptrend`, `downtrend`, `sideways`, or `choppy`, with drift percent
  and signal strength.
- `volatility`: `low` (ATR% < 2), `medium` (2–6), `high` (> 6).
- `pattern`: `trend_continuation`, `range_consolidation`, `breakout`,
  `pole_reversal`, or `volatility_cluster`, with confidence and rationale.
- `risk_flags`: up to five flags — `high_volatility`, `overextension`,
  `sharp_move`, `gap` (reserved in the contract).
- `indicator_summary`: EMA(9) position and RSI(14) zone.
- `sentiment`: tone of `context.news` if supplied, otherwise `none`.

**Semantics**

- EMA(9) is seeded with the first close.
- RSI(14) uses the last 15 closes (14 changes); flat windows return 50.
- ATR uses true range across the full window, averaged over `n - 1`.
- Trend is based on first-to-last drift and the window's range.
- All arithmetic is local and stable for the same input/version.

**Disclosure**

Every result carries:

> Interpretation of historical and current price structure only. Not a
> prediction, recommendation, or guarantee of any outcome.

The domain never emits buy/sell/hold language and never forecasts. It is not a
trading system.

## Planning

**Purpose:** turn an objective into a small, reviewable scaffold.

**Input:** objective (required, ≤ 2,000 chars), constraints (≤ 20), optional
deadline, optional context.

**Categories:** `research`, `build`, `write`, `analyze`, `organize`, `learn`,
`generic`.

Classification scores keyword matches; on a tie, the keyword appearing earliest
in the objective wins. This favors the intent verb ("Learn enough Rust to build
a CLI" → `learn`).

**Outputs**

- Four to five steps, each with an id, title, action, done-when criterion, and
  verification criterion.
- Assumptions (owner approval, no automatic execution, supplied constraints,
  context treated as unverified).
- Risks (vague objective, missing deadline/constraints, unparseable or past
  deadline).
- A deterministic id derived from the normalized input.

**Non-goals**

- It does not execute, schedule, or call tools.
- It does not claim the plan is optimal or complete.
- It never hides missing information; it surfaces it as a risk.

## Preferences

**Purpose:** adapt tone using only feedback the owner explicitly records.

**Signals**

- `too_technical`, `too_vague`, `more_detail`, `less_detail`, `liked`,
  `disliked`.

**Bias**

Each category keeps signal counts. Two transparent scores are derived:

```text
analytic  = 1 + 0.10*(too_vague + more_detail)
              - 0.05*(too_technical + less_detail)
              + 0.05*liked - 0.05*disliked

synthesis = 1 + 0.10*(too_technical + less_detail)
              - 0.05*(too_vague + more_detail)
              + 0.05*liked - 0.05*disliked
```

Both are clamped to `[0.5, 2.0]`. The style hint is derived from the gap:
analytic-leaning, synthesis-leaning, or balanced.

**Non-goals**

- No implicit learning from clicks, dwell time, or message content.
- No cross-user profiles, advertising, or telemetry.
- No model is asked to infer preferences.

**Privacy**

Only the category name, signal counts, and timestamps are stored locally.
Feedback is editable only by deleting the store; export tooling is roadmap work.

## Provenance

| Domain | Sibling source | What changed |
| --- | --- | --- |
| Documents | Aether `skills/documents.py`, `memory/vector_store.py` | Replaced ChromaDB/embeddings with BM25 + extractive citations; added allowlisted roots and line locators. |
| Market | Maya `maya_runtime/market/mpm.py` | Ported the deterministic indicator/trend/volatility/risk subset to TypeScript; preserved the interpretation-only contract and disclaimer. |
| Planning | Aether `core/planner.py` | Replaced the mutable goal/task store with deterministic, reviewable templates; no execution loop. |
| Preferences | Aether `core/preference_store.py` | Kept explicit-feedback bias; removed implicit signals; added clamps and local store fail-closed behavior. |
| Audit | Aether `trust/audit.py` | Kept the SHA-256 chain; added typed receipts, malformed-tip refusal, and verification reports. |
