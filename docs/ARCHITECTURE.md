# Architecture

## Design goals

1. **One governed subsystem, not loose tools.** Every request passes through the
   same route → run → cap → evidence → receipt path.
2. **Deterministic by default.** No domain calls a model, the network, or a
   probabilistic embedding service. The same input produces the same output on
   the same version.
3. **Honest verification.** A domain cannot claim more certainty than its
   evidence supports.
4. **Local-first privacy.** Indexed files, preferences, and receipts stay on the
   machine. Receipts hash inputs and answers rather than storing them.
5. **No runtime dependencies.** The package runs on the Node.js standard
   library alone, which keeps supply-chain and installation cost near zero.

Non-goals: open-domain chat, web search, autonomous execution, trading signals,
implicit user profiling, and cloud sync.

## Request lifecycle

```text
IntelligenceRequest
  │  query, optional domain, optional payload, optional limits
  ▼
IntelligenceRegistry.route()
  │  explicit domain wins; otherwise keyword scoring
  ▼
IntelligenceGovernor.runDomain()
  │  documents | market | planning | preferences
  ▼
DomainResult
  │  answer, verification, confidence, evidence, disclosures, data
  ▼
capVerification()
  │  no evidence ⇒ unverified; result cannot exceed domain ceiling
  ▼
AuditChain.append()
  │  SHA-256 receipt chained to the previous tip
  ▼
IntelligenceResult
     domain, routedBy, routeScore, receipt
```

`ask()` is asynchronous because hosts expect a promise, even though every
current domain is synchronous. That leaves room for a future opt-in domain
without changing the public call shape.

## Domain contract

Every domain is described by a `DomainDefinition`:

```ts
interface DomainDefinition {
  id: 'documents' | 'market' | 'planning' | 'preferences';
  name: string;
  description: string;
  keywords: readonly string[];
  verification: VerificationLevel; // ceiling, not a guarantee
  requiresEvidence: boolean;
  minModelTier: 'tiny' | 'small' | 'medium' | 'large';
  deterministic: boolean;
}
```

A domain returns a `DomainResult`:

```ts
interface DomainResult {
  answer: string;
  verification: VerificationLevel;
  confidence: number;       // 0..1, domain-specific
  evidence: Evidence[];     // empty means "cannot substantiate"
  disclosures: string[];    // limits the caller must show or respect
  data?: Record<string, unknown>;
}
```

`requiresEvidence` is documentation of intent. The governor enforces the
stronger rule for every domain: **no evidence ⇒ `unverified`**.

## Verification algebra

Ordering: `unverified (0) < advisory (1) < grounded (2) < verified (3)`.

```ts
const floor = result.evidence.length === 0 ? 'unverified' : result.verification;
const capped = order[floor] > order[domain.verification] ? domain.verification : floor;
```

Consequences:

- A market result is computed from supplied input, so it can be `verified`.
- A document answer is quoted from a local file, so its ceiling is `grounded`.
- Planning and preferences are scaffolds/biases, so their ceiling is
  `advisory`.
- An empty preference list or an unanswerable document query becomes
  `unverified` regardless of ceiling.

Confidence is domain-specific and never used to raise a verification level.

## Evidence and disclosures

Evidence is a small, serializable record:

```ts
interface Evidence {
  kind: 'computation' | 'document' | 'preference' | 'plan' | 'user-input';
  label: string;
  source?: string;   // file path for documents
  locator?: string;  // "lines 12-18"
  excerpt?: string;  // bounded quoted text
  sha256?: string;   // hash of the cited chunk or computation input
  value?: unknown;   // structured, bounded detail
}
```

Disclosures state what the subsystem did **not** do: no external source, no
prediction, no execution, no implicit profiling. Hosts should surface them.

## Receipts and the audit chain

Each turn appends one JSON line:

```json
{
  "ts": "2026-11-13T00:00:00.000Z",
  "domain": "documents",
  "verification": "grounded",
  "requestHash": "<sha256>",
  "answerHash": "<sha256>",
  "prevHash": "<sha256 of previous entry>",
  "id": "<first 16 hex chars of hash>",
  "hash": "<sha256 of the entry without id/hash>"
}
```

- The genesis hash is `sha256("zoveli-intelligence-genesis")`.
- `verify()` recomputes every entry hash, checks each `prevHash`, and reports
  line-numbered problems.
- A malformed tip makes `append()` fail rather than silently starting a new
  chain.
- Store mutations that do not pass through `ask()` (document indexing,
  forgetting) are sealed with `governor.seal()`.

Limits, stated plainly:

- The chain detects **modification** within the recorded chain. It does not
  prevent deletion, and truncating the newest entries leaves a valid shorter
  chain unless a caller anchors the tip hash externally.
- Receipts prove integrity of metadata, not truthfulness of an answer.
- One process should write a given chain at a time. Cross-process locking is
  future work.

## Storage

Default location: `~/.zoveli/intelligence` (override with
`ZOVELI_INTEL_DATA_DIR` or the `dataDir` option).

| File | Contents |
| --- | --- |
| `documents.json` | Index metadata, chunks, source paths, hashes, timestamps. |
| `preferences.json` | Explicit signal counts by category. |
| `audit.jsonl` | Append-only receipt chain. |

Writes use a same-directory temp file plus rename, with owner-only permissions
where the platform supports them. Reads distinguish "missing" from "corrupt":
missing files return an empty default, corrupt files throw
`StoreCorruptionError` so real data is never overwritten by a silent reset.

## Routing

`IntelligenceRegistry.route()` lowercases the query and scores every domain:

- A single-word keyword hit scores 1.
- A phrase keyword hit scores 2.
- Ties are broken alphabetically by domain id.
- If nothing matches, the query falls back to `documents` with score 0, because
  an unsupported question should be answered "no indexed source" rather than
  guessed.
- An explicit `domain` bypasses scoring and reports `routedBy: 'explicit'` with
  score 1.

Routing is deliberately simple and inspectable. `intel_route` exposes the
decision and alternatives without running a domain.

## Document indexing and path security

- Roots are resolved with `realpathSync.native` once at construction.
- Every index input is resolved and must be inside a root.
- Symlinks are skipped during directory walks to avoid escaping the root.
- Directory names such as `.git`, `node_modules`, `dist`, and virtualenvs are
  skipped.
- Supported extensions are text-like: Markdown, text, reStructuredText, AsciiDoc,
  JSON, JSONL, CSV, TSV, HTML, logs, YAML.
- Defaults: 500 files, 2 MiB per file, 220 words per chunk with 40 words of
  overlap. All are configurable.
- Re-indexing a path replaces its chunks; `forget()` only removes the index
  entry, never the source file.

BM25 is computed over chunks with `k1 = 1.2`, `b = 0.75`, plus a small exact
phrase bonus. Tokenization is ASCII alphanumeric with a stopword list, which is
good enough for local notes and intentionally not a linguistic model.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Unknown domain | `IntelligenceInputError` with available ids. |
| Malformed prices | `IntelligenceInputError` naming the violated invariant. |
| Path outside roots | `IntelligenceSecurityError`; indexing reports it per path. |
| Corrupt JSON store | `StoreCorruptionError`; no reset. |
| Malformed audit tip | `AuditIntegrityError`; append refused. |
| Tampered audit line | `verify()` returns `ok: false` with line numbers. |
| MCP tool failure | Tool result with `isError: true`, not a protocol crash. |

## Adding a domain

1. Add the id to `DomainId`.
2. Implement a pure function that returns `DomainResult`.
3. Add a `DomainDefinition` with an honest verification ceiling.
4. Add a branch in `IntelligenceGovernor.runDomain()`.
5. Add tool descriptors if the domain should be exposed over MCP.
6. Add routing, evidence, cap, and refusal tests before documentation.

Do not claim `verified` for anything that is not deterministic computation over
provided input or independently checked. Do not add a model call to a domain
without making it opt-in and changing its verification ceiling to `advisory` or
lower.
