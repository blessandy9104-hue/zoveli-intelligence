# Security

## Reporting

Report vulnerabilities privately to **blessandy9104@gmail.com**. Do not open a
public issue with exploit details. Include the version, platform, a minimal
reproduction, and the impact you believe is possible. Expect an initial response
within a few days.

## Threat model

This is a single-user, local-first package. It assumes the operating-system
account and the local filesystem are trusted. It does not defend against a
compromised kernel, a malicious Node.js runtime, or an attacker who can already
read and rewrite the data directory.

| Threat | Control |
| --- | --- |
| Indexing files outside the owner's chosen folders | Realpath resolution against configured roots; symlinks skipped; `..` escapes rejected. |
| Silent data loss after a corrupt store | Missing files are empty; malformed files throw `StoreCorruptionError` and are never overwritten. |
| Tampered receipt history | SHA-256 per-entry hashes plus `prevHash` chaining; `verify()` reports line-numbered problems. |
| Appending onto a malformed log | Construction and append refuse an invalid tip with `AuditIntegrityError`. |
| Path traversal through a document name | Paths are resolved before use; `forget()` never touches the filesystem. |
| Oversized or binary input | Extension allowlist, per-file byte cap, file-count cap, and price-observation cap. |
| Prompt injection in indexed documents | Answers quote documents as untrusted data, disclose the source, and never execute content. |
| Secret leakage into receipts | Receipts store hashes and routing metadata, not queries, answers, or document text. |
| Silent network exfiltration | The package has zero runtime dependencies and makes no network calls. |
| Oversized tool payloads | Bounded result counts, character excerpts, and input length limits. |

## Known limitations

- **Truncation is not detected.** A hash chain detects edits inside the chain.
  Removing the newest entries leaves a valid shorter chain. Anchor the tip
  externally (`audit verify` output) or wait for signed checkpoints.
- **No encryption at rest.** The index, preferences, and audit log are local
  files. Use OS disk encryption if the device is shared.
- **One writer per data directory.** Concurrent processes can interleave audit
  entries. There is no lock yet.
- **Document text is stored in `documents.json`** as chunks so retrieval works
  offline. Index only folders whose contents may live in that file.
- **Verification is not truth.** `verified` means deterministic computation over
  supplied input. Garbage input produces a correctly computed interpretation of
  garbage.
- **Market output is not advice.** It describes structure in a historical
  window and never predicts.
- **Quoted content can be hostile.** A document may say "ignore previous
  instructions". The subsystem treats it as data; hosts must too.

## Hardening recommendations

- Set `ZOVELI_INTEL_ROOTS` to the smallest useful set of folders.
- Keep the data directory owner-only (`0700`); the code requests owner-only
  modes on supported platforms.
- Anchor the audit tip hash in a separate system if tamper evidence matters.
- Run the CLI/MCP server as the same unprivileged user that owns the notes.
- Review indexed source lists with `docs list` after adding broad roots.
- Use a separate `--data-dir` for tests and demos.

## Dependency policy

Runtime dependencies must stay at zero. Development dependencies are pinned by
lockfile and reviewed in CI. A new runtime dependency needs a written rationale,
a license check, and a threat-model update.
