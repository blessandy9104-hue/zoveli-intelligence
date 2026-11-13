# Integration

There are three supported integration modes. They share the same governor, tool
contracts, storage layout, and receipts.

## 1. MCP over stdio

Any MCP-capable host can launch the CLI:

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

With an installed package the binary is `zoveli-intel`. From a checkout, build
and point the host at `node /path/to/zoveli-intelligence/dist/cli.js mcp
--root /path/to/notes`.

The server:

- reads newline-delimited JSON-RPC 2.0 from stdin and writes it to stdout;
- supports `initialize`, `ping`, `tools/list`, and `tools/call`;
- ignores notifications, including `notifications/initialized`;
- returns tool failures as `{ content, isError: true, structuredContent }`;
- returns protocol errors (`-32600`, `-32601`, `-32602`, `-32700`) for malformed
  requests.

Do not print to stdout from wrappers around the server; it would corrupt the
stream. Logs belong on stderr.

## 2. In-process library

```ts
import { createIntelligenceKit } from '@zoveli/intelligence';

const { governor, tools } = createIntelligenceKit({
  dataDir: '/Users/me/.zoveli/intelligence',
  roots: ['/Users/me/notes', '/Users/me/projects/docs'],
  maxFiles: 1000,
  maxFileBytes: 4 * 1024 * 1024,
});
```

`tools` is an array of `{ name, description, parameters, execute }` objects.
Most hosts can mount them directly; the shape is structurally compatible with
the Zoveli `Tool` contract.

Lifecycle:

- Construct once per process. The constructor loads the index and audit tip.
- The governor is safe for sequential use. Do not share one instance across
  processes writing the same `dataDir`.
- Indexing is explicit. Call `governor.documents.indexPaths([...])` or mount the
  `intel_docs_index` tool.
- Use `--data-dir`/`dataDir` to keep test and development state separate from
  real notes.

## 3. Zoveli AI plugin

The adapter lives in the Zoveli AI workspace at `packages/intelligence-plugin`
and is an **opt-in** plugin, not a default. This keeps Zoveli's default surface
at 26 plugins and lets the intelligence subsystem evolve independently.

The adapter:

- imports `@zoveli/intelligence` from the tagged GitHub release;
- creates one governor per host process;
- registers the 16 tools under `assistant-intelligence-tools`;
- provides an `intelligence` service with `status()` and `verifyAudit()`;
- injects routing/verification rules into new agents.

Enable it:

```bash
export ZOVELI_PLUGINS=zoveli-intelligence
export ZOVELI_INTEL_ROOTS="$HOME/notes,$HOME/vault"
export ZOVELI_INTEL_DATA_DIR="$HOME/.zoveli/intelligence"
pnpm start
```

Environment:

| Variable | Meaning |
| --- | --- |
| `ZOVELI_INTEL_ROOTS` | Comma-separated document roots. Defaults to the process cwd. |
| `ZOVELI_INTEL_DATA_DIR` | Local state directory. Defaults to `~/.zoveli/intelligence`. |
| `ZOVELI_PLUGINS` | Must include `zoveli-intelligence` to mount the optional plugin. |
| `ZOVELI_DISABLE_PLUGINS` | Can disable it again without removing the package. |

Suggested root policy: point roots at notes and documents, **not** at a whole
home directory. Root allowlisting is the main read boundary.

Dependency pinning:

```json
{
  "dependencies": {
    "@zoveli/intelligence": "github:blessandy9104-hue/zoveli-intelligence#v0.1.0"
  }
}
```

Use a tag or commit, never a moving branch, so installs are reproducible. The
package has zero runtime dependencies; its `prepare` script builds `dist` from
TypeScript during git installation. In a network-restricted environment, pack
the package once and depend on the tarball with `file:` instead.

### What the agent is told

The plugin injects concise rules, not hidden behavior:

- Route document questions through `intel_ask` or `intel_docs_answer` before
  answering from memory.
- Treat `grounded` answers as quotable with citations; never invent a citation.
- Say `unverified` when the subsystem withholds.
- Present market output as structure interpretation, never advice.
- Treat plans as proposals requiring owner review.
- Use preference signals only when the owner explicitly gives feedback.

## Data ownership

All three modes use the same files. Deleting `documents.json` removes the index
but not the source files. Deleting `audit.jsonl` destroys receipt history
(including tamper evidence). Back up the directory if receipts matter.

## Migrating from sibling tools

- **Aether documents:** re-index the same folders with `docs index`; PDFs are not
  supported yet, so keep Aether for PDF/OCR work.
- **Maya market:** pass the same closes/candles. Output keys follow the MPM
  contract but this package does not run Maya's engine or schema validator
  beyond `validateInterpretation`.
- **Aether planner/preferences:** the state formats are intentionally different.
  Re-record preference feedback; plans are generated on demand and not stored.
- **Aether audit:** do not import the old log. Start a new chain; mixing formats
  would make verification ambiguous.

## Compatibility

- Node.js 22.16+ (tested on 22 and 24).
- ESM only. TypeScript consumers need `module: NodeNext` or a bundler that
  respects `exports`.
- MCP protocol versions accepted on initialize: `2025-06-18`, `2025-03-26`,
  `2024-11-05`.

## Failure isolation

The Zoveli adapter catches nothing at mount time: a failure to create the data
directory is reported to the host instead of being hidden. Tool calls return
typed errors (`INTEL_INPUT`, `INTEL_SECURITY`, `INTEL_STORE_CORRUPT`,
`INTEL_AUDIT_BROKEN`) so the agent can explain the failure without leaking a
stack trace. If the subsystem must never block startup, mount it behind the
host's existing optional-plugin path, which is the default here.
