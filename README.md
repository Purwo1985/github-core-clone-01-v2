# github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Purwo1985/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Purwo1985/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node 22, standard library only — no git binary, no outside service. Built as a modular server instead of a single-file monolith: a pre-compiled route trie dispatches in O(path segments), an immutable object arena with a pack cache serves git fetches, and the hot REST reads are cached as strings on their records. It speaks git smart HTTP (upload-pack protocol v2 and receive-pack v0, fast-forward only), REST v3 (repositories, branches, commits, contents, labels, issues, pull requests with squash merge), GraphQL (the documents the GitHub CLI and github-mcp-server send, plus introspection), and MCP (JSON-RPC 2.0 Streamable HTTP, modern `server/discover` and legacy `initialize`) — all over one in-memory store with a deterministic clock, so a run replays exactly.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node --experimental-strip-types main.ts
```

Requires Node 22. `MAKEFUN_ENV_URL` is the trial environment the entry registers with; the entry binds an ephemeral port, registers it, answers `/healthz`, and exits when the environment reports the trial is done. `MAKEFUN_SHOP_TOKEN` is the bearer token clients must present (empty means dev mode, any token is accepted); `MAKEFUN_TRIAL_NOW` sets the deterministic clock.

## Layout

- `main.ts` — lifecycle: listen, register, poll `/done`, exit.
- `src/forge.ts` — route wiring and the JSON-404 fallback.
- `src/http.ts` — route trie, request context, reply helpers.
- `src/store.ts` — object arena, repositories, reachability, packs, merges.
- `src/objects.ts` — SHA-1 objects, pkt-lines, pack read/write, deltas.
- `src/identity.ts` — the deterministic scenario identities (viewer and stranger).
- `src/rest.ts`, `src/rest2.ts` — REST v3 handlers.
- `src/git.ts` — git smart HTTP (v2 ls-refs/fetch, v0 upload/receive-pack).
- `src/graphql.ts` — hand-written GraphQL parser and executor.
- `src/mcp.ts` — MCP tools over JSON-RPC 2.0.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
