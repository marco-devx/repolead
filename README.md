# RepoLead

> **Stop letting your AI agents re-read the codebase. Give them a Tech Lead instead.**

[![CI](https://github.com/marco-devx/repolead/actions/workflows/ci.yml/badge.svg)](https://github.com/marco-devx/repolead/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black)](https://bun.sh)
[![MCP](https://img.shields.io/badge/Protocol-MCP-blue)](https://modelcontextprotocol.io)

RepoLead is a **repository intelligence system**. Deterministic analyzers (Tree-sitter, SCIP, git) build a verifiable code graph in SQLite; Claude acts as a Tech Lead that interprets the evidence into module dossiers and an architecture brief; everything is exposed to coding agents (Claude Code, Codex) through MCP.

## Why

When an AI agent explores a repository by reading files, every question burns context: repeated reads, compacted sessions, conclusions without evidence, and the same discoveries made over and over. RepoLead inverts the flow:

```
Facts            -> extracted by deterministic tools (parsers, indexers, git)
Interpretations  -> produced once by an LLM Tech Lead, cached by content hash
Evidence         -> exact files, lines and symbols backing every claim
```

Agents query a small, up-to-date, verifiable knowledge base instead of crawling the tree. Answers arrive in milliseconds, claims are traceable to source lines, and the expensive LLM analysis is paid once per change — not once per question.

## How it works

```
 repository
     |
     v
 [scan]   Tree-sitter (TS/TSX + Python) ---> symbols, imports, endpoints, tests
          SCIP (scip-typescript, scip-python) ---> resolved references (CALLS, IMPLEMENTS)
          git history ---> churn, co-changes, authorship
     |
     v
 SQLite (+FTS5)  <- source of truth: files, symbols, edges, metrics, findings
 Qdrant          <- semantic index (rebuildable from SQLite at any time)
     |
     v
 [analyze]  evidence packs -> Claude -> module dossiers + repository brief (cached)
 [audit]    YAML policies -> deterministic detectors -> Claude as judge -> findings
     |
     v
 [serve]  MCP server -> Claude Code / Codex query it with 7 tools
```

Key properties:

- **Language-unit chunks.** Symbols are real classes, functions, methods and HTTP endpoints — never fixed-size token windows.
- **Stable identities.** A symbol ID is a hash of `repository + path + kind + qualified name + signature`, never a line number.
- **Content-addressed caching.** A module is re-analyzed only when its evidence pack changes. Re-running `analyze` on an unchanged repository makes zero LLM calls.
- **Evidence or it does not exist.** A finding without file/line evidence is never stored.
- **Graceful degradation.** No vector services? Search falls back to FTS5 + graph. No SCIP indexer? Scan continues with syntactic edges. No LLM? Deterministic layers still work.

Supported languages today: **TypeScript/TSX** and **Python** (including FastAPI route detection). Other files are still indexed with git metrics.

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| [Bun](https://bun.sh) | >= 1.3 | Runtime and package manager (not npm/pnpm) |
| Node.js | >= 20 | Used by SCIP indexers and the test runner |
| git | any recent | Required — RepoLead only indexes git repositories |
| Docker | any recent | For Qdrant + embedding/reranking services |
| RAM | 8 GB (16 GB comfortable) | CPU inference services use ~4–6 GB |
| Disk | ~5 GB free | Docker images + embedding models |
| GPU (optional) | NVIDIA, >= 6 GB VRAM | Uses ~5 GB; needs NVIDIA Container Toolkit |

For the LLM layers (`analyze`, `audit`) you need one of:

- `ANTHROPIC_API_KEY` — pay-per-token via the Anthropic API, or
- a **Claude Code subscription** (Pro/Max) — RepoLead runs the analysis through the Claude Agent SDK using your existing login, no API credits required.

## Quickstart

```bash
git clone git@github.com:marco-devx/repolead.git
cd repolead
bun install
docker compose up -d

alias repolead="bun $(pwd)/apps/cli/src/index.ts"

cd /path/to/your/repo
repolead onboard .
```

`onboard` chains everything (scan, vector indexing, Tech Lead analysis, policy audit) and prints the exact `claude mcp add` command as its final step.

## CLI reference

| Command | Purpose | Options |
|---|---|---|
| `repolead onboard [path]` | Full setup of a repo in one command: scan + reindex + analyze + audit | `--db <path>` custom database file · `--name <name>` repository name · `--model <name>` · `--backend api\|claude-code` · `--policies <dir>` · `--no-scip` · `--no-analyze` · `--no-audit` |
| `repolead scan [path]` | Deterministic indexing: files, symbols, references, modules, git metrics | `--db <path>` · `--name <name>` · `--no-scip` skip reference resolution |
| `repolead refresh [path]` | Incremental update from git diff: re-analyzes only what changed | `--db <path>` · `--analyze` re-run Tech Lead on invalidated modules · `--model` · `--backend` · `--no-scip` |
| `repolead analyze` | Generate module dossiers + repository brief with Claude | `--db <path>` · `--module <name>` single module · `--dry-run` show evidence packs without LLM calls · `--model <name>` · `--backend api\|claude-code` |
| `repolead audit` | Run the policy pack: deterministic detectors + Claude as judge | `--db <path>` · `--policies <dir>` · `--model` · `--backend` · `--no-judge` store raw candidates |
| `repolead brief` | Read the repository brief or a module dossier in the terminal | `--db <path>` · `--module <name>` · `--json` |
| `repolead query <text...>` | Hybrid search (FTS5 + vectors + graph) in natural language | `--db <path>` · `--limit <n>` |
| `repolead reindex` | Rebuild the Qdrant vector index from SQLite | `--db <path>` |
| `repolead serve` | Start the MCP server over stdio | `--db <path>` one repo · `--dir <path>` every repo under a directory |
| `repolead install-hooks [path]` | Install a Claude Code PreToolUse hook that steers agents toward RepoLead instead of raw file reads | `--remove` uninstall |
| `repolead doctor` | Check binaries and services (git, SCIP, Qdrant, TEI, reranker) | — |

Analysis backend selection: if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set the direct API is used (default model `claude-opus-5`); otherwise the Claude Agent SDK runs on your Claude Code subscription. Force either with `--backend`.

## MCP tools

Once served, agents see these tools:

| Tool | Arguments | Returns |
|---|---|---|
| `repo_overview` | `repo?` | Snapshot stats, module list and the repository brief. With `--dir` and no `repo`, lists every served repository |
| `module_context` | `module`, `repo?` | Module dossier: responsibility, public API, dependencies, risks, confirmed findings |
| `symbol_context` | `symbol`, `repo?` | Location, signature, incoming and outgoing relations of a symbol |
| `find_callers` | `symbol`, `transitiveDepth?`, `repo?` | Who calls a symbol, breadth-first up to depth 5 |
| `architecture_findings` | `severity?`, `module?`, `repo?` | Confirmed policy findings, filterable |
| `get_evidence` | `findingId?` or `path` + `startLine?`/`endLine?`, `repo?` | The exact source lines backing a claim |
| `search` | `query`, `limit?`, `repo?` | Hybrid symbol search; multilingual queries supported. Without `repo`, searches across every served repository |

In multi-repo mode (`serve --dir`) the `repo` argument is optional everywhere: unambiguous symbols and modules resolve automatically, and ambiguity returns the list of candidate repositories.

## Connect to Claude Code

```bash
# Single repository
claude mcp add repolead -- bun /path/to/repolead/apps/cli/src/index.ts serve --db /path/to/your/repo/.repolead/repolead.db

# Every repository under a folder (each one onboarded first)
claude mcp add repolead -- bun /path/to/repolead/apps/cli/src/index.ts serve --dir /path/to/your/repos
```

Then, inside a session:

```
Use RepoLead to explain the authentication flow. Do not scan the repository manually.
```

Optionally, make the steering automatic: `repolead install-hooks .` registers a PreToolUse hook in the project that nudges the agent toward RepoLead tools whenever it tries to read indexed source files directly (at most twice per session, silent when the index is stale, fails open on any error).

## Remote deployment (product teams, private cloud)

The server can also run over authenticated HTTP so non-developers query the knowledge base from claude.ai without installing anything:

```bash
REPOLEAD_TOKEN=<strong-secret> repolead serve --dir /srv/repos --http --port 3939 --no-source
```

- `--http` switches from stdio to MCP Streamable HTTP at `POST /mcp`; every request requires `Authorization: Bearer <token>`.
- `--no-source` enables product mode: dossiers, briefs, findings, search and stored evidence excerpts are served, but raw source lines never leave the server.
- Keep the endpoint inside your VPN or behind a reverse proxy with TLS.

Connect it as a custom connector in claude.ai (Settings -> Connectors -> Add custom connector, URL `https://your-host/mcp`) or in Claude Code:

```bash
claude mcp add --transport http repolead https://your-host/mcp --header "Authorization: Bearer <token>"
```

Keep the indexes fresh with a cron job on the host:

```
*/30 * * * * cd /srv/repos && for d in */; do git -C "$d" pull -q && repolead refresh "$d" --analyze; done
```

Content-addressed caching keeps this cheap: unchanged modules cost zero LLM calls.

## Connect to Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.repolead]
command = "bun"
args = ["/path/to/repolead/apps/cli/src/index.ts", "serve", "--dir", "/path/to/your/repos"]
```

## CPU or GPU

The default `docker-compose.yml` runs everything on CPU and works on any machine:

```bash
docker compose up -d
```

With an NVIDIA GPU, use the override for much faster embedding and reranking (hundreds of symbols vectorized in under a second):

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

Choose GPU when you index large repositories or many of them; CPU is fine for small projects and occasional use. The shipped GPU tag targets Ada Lovelace (RTX 40xx, compute capability 8.9) — other generations are listed in the override file header. To make plain `docker compose` commands use the GPU permanently, create a local `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

Startup note: the reranker may log `Could not start ORT backend ... model.onnx does not exist` errors on CPU — this is harmless backend-fallback noise; the model loads through candle two lines later.

## Models

| Role | Model | Served by |
|---|---|---|
| Embeddings | Qwen3-Embedding-0.6B | Text Embeddings Inference (TEI) |
| Reranking | BAAI/bge-reranker-v2-m3 | TEI |
| Tech Lead analysis and policy judge | claude-opus-5 (API) or your Claude Code default model (subscription) | Anthropic |

Vectors are derived data: if Qdrant is lost, `repolead reindex` rebuilds it from SQLite.

## Development

```bash
bun install
bun run check     # lint + typecheck + tests + build
bun run test
```

Toolchain: Bun workspaces, [Rsbuild](https://rsbuild.rs), [Rstest](https://rstest.rs), [Rslint](https://rslint.rs).

## License

[MIT](LICENSE)
