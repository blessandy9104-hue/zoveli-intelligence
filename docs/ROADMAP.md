# Roadmap

The 0.1 line is deliberately small and deterministic. Work is ordered by user
value and by whether it preserves the verification contract.

## 0.2 — retrieval quality without losing determinism

- [ ] Optional, opt-in embedding adapter behind an explicit interface. Default
      remains BM25; any semantic result must carry its own evidence and cannot
      raise verification above `grounded`.
- [ ] PDF text extraction as an optional peer dependency (no OCR by default).
- [ ] Incremental re-index by mtime/size with an explicit `--force` path.
- [ ] Index exclusion patterns (`.gitignore`-style) per root.
- [ ] Search filters: path prefix, extension, modified-after.
- [ ] Benchmarks for 10k chunks and a documented performance budget.

## 0.3 — receipts you can anchor

- [ ] `audit anchor` command that prints the current tip for external storage.
- [ ] `audit verify --expect-tip <hash>` to detect truncation.
- [ ] Optional Ed25519 signing of receipts with a local key.
- [ ] Cross-process writer lock with a clear error instead of interleaving.
- [ ] Audit compaction that preserves a signed checkpoint.

## 0.4 — host and tooling maturity

- [ ] Streamable HTTP MCP transport in addition to stdio.
- [ ] OpenCode/Claude/Zoveli config generators in the CLI.
- [ ] Preference export, import, and deletion commands.
- [ ] Structured evaluation suite with fixed fixtures per domain.
- [ ] Windows/macOS/Linux CI matrix.
- [ ] Publish to npm (currently installable from GitHub).

## Later

- [ ] Plan state: opt-in persistence and progress tracking, still without
      execution.
- [ ] Document collections with per-collection roots and retention.
- [ ] Redaction rules before indexing sensitive patterns.
- [ ] Localization of stopwords and sentence splitting.
- [ ] A domain-authoring SDK with conformance tests.

## Explicit non-goals

- Autonomous trading, price targets, or buy/sell recommendations.
- Cloud sync or telemetry enabled by default.
- Implicit profiling from behavior.
- Training on the owner's documents.
- Silent fallback from "no evidence" to a model-generated guess.
