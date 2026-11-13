# Zoveli Intelligence

One governor over deterministic, local-first intelligence domains:

- **Documents** — BM25 retrieval and extractive answers over files you explicitly index, with source and line citations.
- **Market** — deterministic interpretation of a supplied price window (trend, volatility, pattern, risk flags, RSI, EMA, ATR). Never a prediction or recommendation.
- **Planning** — reviewable plan scaffolds with completion and verification criteria. Never executes anything.
- **Preferences** — explicit owner feedback turned into a transparent style bias. No implicit profiling.
- **Receipts** — an append-only SHA-256 hash chain recording what ran, when, and at what verification level.

Zero runtime dependencies. No network calls. No embedding model. No telemetry. Node.js 22+.

This repository consolidates the strongest local-first ideas from the Zoveli portfolio:

| Source | Reused idea | Here |
| --- | --- | --- |
| Zoveli AI `math-intelligence` | One governor, deterministic domains, verification caps, evidence, disclosures | `IntelligenceGovernor` |
| Aether `documents` + `vector_store` | Private document RAG | Local BM25 + extractive citations |
| Maya `maya_runtime/market/mpm.py` | MPM market structure interpretation | TypeScript port, interpretation-only |
| Aether `core/planner.py` | Goal decomposition with verification | Deterministic plan templates |
| Aether `core/preference_store.py` | Explicit feedback → style bias | Local preference store |
| Aether `trust/audit.py` | SHA-256 hash-chained audit log | Receipt chain with tamper detection |

The original implementations stay in their repositories. This project re-implements the deterministic, dependency-free subset in TypeScript so it can ship inside a local assistant without Python, ChromaDB, or a vector database.

## Architecture

```text
request ──▶ IntelligenceGovernor
              │
              ├─ route by intent (or explicit domain)
              ├─ run one deterministic domain
              ├─ cap verification to what the domain can prove
              ├─ attach evidence + disclosures
              └─ append hash-chained receipt
```

A domain cannot claim more verification than it can support. A result without evidence is downgraded to `unverified` even if the domain's ceiling is higher. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
git clone https://github.com/blessandy9104-hue/zoveli-intelligence.git
cd zoveli-intelligence
npm install
npm run check
```

Run the CLI from source:

```bash
npm run build
node dist/cli.js --help
```

Or install it as a command from this repository:

```bash
npm install
npm link
zoveli-intel --help
```

## CLI

```bash
# Index a notes folder once; only allowlisted roots are readable.
zoveli-intel --root ~/notes docs index ~/notes

# Ask a grounded question — answers quote local lines and cite them.
zoveli-intel ask "What does my runbook say about restarting the gateway?"

# Search without generating an answer.
zoveli-intel docs search "maintenance window"

# Interpret a price window (interpretation only).
zoveli-intel market 100,101,102,103,104,105 --instrument equity

# Build a reviewable plan.
zoveli-intel plan "Build a local search feature" \
  --constraint "no network" --deadline 2026-12-01

# Explicit preference feedback.
zoveli-intel prefs record coding more_detail

# Verify the receipt chain.
zoveli-intel audit verify
```

Use `--json` on any command for machine-readable output. State lives in `~/.zoveli/intelligence` unless `--data-dir` or `ZOVELI_INTEL_DATA_DIR` says otherwise.

## MCP server

`zoveli-intel mcp` speaks newline-delimited JSON-RPC 2.0 over stdio and exposes 16 tools:

```json
{
  "mcpServers": {
    "zoveli-intelligence": {
      "command": "zoveli-intel",
      "args": ["mcp", "--root", "/Users/me/notes"]
    }
  }
}
```

Tools: `intel_status`, `intel_route`, `intel_ask`, `intel_docs_index`, `intel_docs_search`, `intel_docs_answer`, `intel_docs_list`, `intel_docs_forget`, `intel_docs_stats`, `intel_market_interpret`, `intel_plan_create`, `intel_preferences_list`, `intel_preferences_get`, `intel_preferences_record`, `intel_audit_verify`, `intel_audit_tail`.

The server writes protocol messages only to stdout. Errors are returned as MCP tool results with `isError: true`, not as protocol crashes.

## Library

```ts
import { createIntelligenceKit } from '@zoveli/intelligence';

const { governor, tools } = createIntelligenceKit({
  dataDir: '/Users/me/.zoveli/intelligence',
  roots: ['/Users/me/notes'],
});

const result = await governor.ask({
  query: 'What does the runbook say about restarting the gateway?',
});

console.log(result.answer);
console.log(result.verification); // 'grounded' | 'verified' | 'advisory' | 'unverified'
console.log(result.receipt);      // hash-chained receipt
```

Market requests carry their own payload:

```ts
await governor.ask({
  query: 'Interpret this window',
  domain: 'market',
  payload: {
    prices: [100, 101, 102, 103, 104],
    instrument: { type: 'equity', timeframe: '1d' },
  },
});
```

## Verification levels

| Level | Meaning |
| --- | --- |
| `verified` | Deterministic computation over supplied input, or a sealed store operation. |
| `grounded` | Quoted from an indexed local document with a source and line citation. |
| `advisory` | A scaffold or preference bias; explicitly not executed or externally checked. |
| `unverified` | Withheld, or no evidence was produced. |

Every answer includes `evidence`, `disclosures`, and a `receipt`. Receipts contain hashes and routing metadata, not raw queries or document text.

## Security model

- **Allowlisted reads.** Documents can only be indexed from configured roots. Symlinks and `..` escapes are resolved and rejected.
- **No network.** The subsystem never fetches, phones home, or calls a model.
- **No hidden index.** The index is a JSON file you can inspect; deleting it loses no source files.
- **Fail closed.** Corrupt stores and broken audit tips stop the operation instead of silently resetting data.
- **Quoted data is still data.** Indexed documents may contain hostile instructions. Answers quote them as evidence; the host must not treat quoted text as instructions.
- **Not financial advice.** Market output describes historical/current structure only and never predicts or recommends.

See [SECURITY.md](SECURITY.md) for the threat model and reporting process.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Domains](docs/DOMAINS.md)
- [Integration](docs/INTEGRATION.md)
- [Roadmap](docs/ROADMAP.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, including tests
npm test            # builds, then runs Vitest
npm run build       # emits dist/
npm run check       # typecheck + test + build
```

The test suite covers routing, every domain, verification caps, tamper detection, path escapes, tool contracts, MCP framing, and the CLI.

## License

MIT © 2026 Andy ([blessandy9104-hue](https://github.com/blessandy9104-hue))
