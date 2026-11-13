# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-13

### Added

- `IntelligenceGovernor`: intent routing, explicit domain override, verification
  caps, evidence/disclosure envelopes, and hash-chained receipts.
- `documents` domain: allowlisted local indexing, BM25 retrieval, extractive
  answers with source and line citations, per-file re-indexing, and forgetting
  without deleting source files.
- `market` domain: deterministic MPM interpretation — trend, volatility,
  pattern, risk flags, RSI(14), EMA(9), ATR, and optional user-supplied news
  tone. Interpretation only; no forecasts or directives.
- `planning` domain: deterministic plan templates for research, build, write,
  analyze, organize, learn, and generic objectives, with done-when and
  verification criteria.
- `preferences` domain: explicit feedback signals and a transparent analytic /
  synthesis style bias, stored locally.
- Append-only SHA-256 audit chain with tamper detection, tail inspection, and a
  refusal to append onto a malformed tip.
- 16 MCP tools plus a stdio JSON-RPC server (`zoveli-intel mcp`).
- `zoveli-intel` CLI with JSON output for every command.
- Corrupt-store fail-closed behavior (`StoreCorruptionError`) and path-escape
  rejection (`IntelligenceSecurityError`).
- 86 tests covering domains, routing, verification caps, audit tampering,
  security boundaries, tools, MCP framing, and the CLI.
- CI for Node 22 and 24, plus npm pack verification.

### Provenance

Deterministic concepts adapted from the author's sibling repositories:

- Zoveli AI `math-intelligence` (governor shape, evidence, disclosures).
- Aether (document RAG, planner, preference store, hash-chained audit).
- Maya (market pattern module).

No source file is copied verbatim; the TypeScript implementation is a
dependency-free re-implementation of the deterministic subset.
