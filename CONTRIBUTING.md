# Contributing

## Setup

```bash
git clone https://github.com/blessandy9104-hue/zoveli-intelligence.git
cd zoveli-intelligence
npm install
npm run check
```

Requires Node.js 22.16 or newer. The package is ESM and uses NodeNext module
resolution, so relative imports in TypeScript end in `.js`.

## Checks

```bash
npm run typecheck   # tsc --noEmit, includes tests
npm test            # builds, then Vitest
npm run build       # dist/
npm run check       # all three, in order
```

A pull request should leave all three green and add tests for behavior changes.
Security-boundary changes need a refusal test, not only a success test.

## Code style

- Zero runtime dependencies. Standard library only.
- Strict TypeScript; no `any` in public contracts. Internal `unknown` is
  narrowed explicitly.
- Small pure functions where possible. Domain outputs are deterministic.
- Every new error path gets a typed error with a stable code.
- No console output from library code. The CLI owns stdout; the MCP server owns
  the protocol stream and logs nothing to stdout.
- Keep comments about **why**, not what. Document limits next to the code that
  enforces them.
- Prefer existing patterns over new abstractions.

## Adding a domain

1. Extend `DomainId` and add a `DomainDefinition` to `src/registry.ts`.
2. Implement a pure function returning `DomainResult` in `src/domains/`.
3. Wire it into `IntelligenceGovernor.runDomain()`.
4. Add tool descriptors in `src/tools.ts` if it should be exposed over MCP.
5. Add tests: input validation, evidence, disclosure, verification cap, and at
   least one refusal.
6. Update `docs/DOMAINS.md`, `docs/ARCHITECTURE.md`, and `CHANGELOG.md`.

A domain may claim `verified` only for deterministic computation over supplied
input. Documents are `grounded`. Scaffolds and preferences are `advisory`.
Anything without evidence is downgraded to `unverified` by the governor.

## Commit and PR conventions

- Use imperative, scoped subjects: `feat(documents): add mtime re-index`,
  `fix(audit): refuse malformed tip`.
- One logical change per commit; tests with the behavior they protect.
- Describe user-visible effects and any verification change in the PR.
- Call out security implications, new limits, and migration steps.
- Do not commit `dist`, `node_modules`, or local `.zoveli` data.

## Reporting security issues

Follow [SECURITY.md](SECURITY.md). Do not open a public issue for a
vulnerability.

## License

Contributions are accepted under the MIT license.
