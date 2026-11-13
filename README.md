# RepoLead

> **Stop letting your AI agents re-read the codebase. Give them a Tech Lead instead.**

[![CI](https://github.com/marco-devx/repolead/actions/workflows/ci.yml/badge.svg)](https://github.com/marco-devx/repolead/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black)](https://bun.sh)
[![MCP](https://img.shields.io/badge/Protocol-MCP-blue)](https://modelcontextprotocol.io)

RepoLead is a **repository intelligence system**. Deterministic analyzers (Tree-sitter, SCIP, git) build a verifiable code graph in SQLite; a local Ollama model interprets the evidence into technical and product memory; everything is exposed to coding agents (Claude Code, Codex) through MCP. Claude generation remains available through an explicitly selected backend.

**Documentación en español:** [Guía técnica: del primer uso a la arquitectura interna](docs/guia-tecnica.md), con el flujo de trabajo, todos los comandos, MCP y presupuestos de tokens.

**Shared product MCP:** [PostgreSQL/pgvector + corporate SSO deployment](deploy/cloud/README.md).
Publish existing local analyses and vectors without regenerating them, serve the latest complete
context from containers, and use an authorized inference worker for new semantic queries and
source corroboration. The local vector backend also supports `REPOLEAD_VECTOR_BACKEND=pgvector`.

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
 [scan]   Tree-sitter (TS/JS + Python) ---> symbols, imports/exports, endpoints, tests
          SCIP (scip-typescript, scip-python) ---> exact references, calls, inheritance
          git history ---> churn, co-changes, authorship
     |
     v
 SQLite (+FTS5)  <- source of truth: files, symbols, edges, metrics, findings
 Qdrant          <- semantic index (rebuildable from SQLite at any time)
     |
     v
 [analyze]  complete file analyses -> first-round synthesis groups (cached; no global brief)
 [audit]    YAML policies -> deterministic detectors -> selected model as judge -> findings
     |
     v
 [serve]  MCP server -> Claude Code / Codex query it with 14 tools
```

For a faster product-focused workflow, use `--analysis-mode entrypoints` (or
`analysis_mode: entrypoints` in `.repolead.yaml`). It generates one analysis per backend
UseCase class and frontend page, without synthesis rounds or global briefs. Other source
files remain indexed as code, so agents can retrieve supporting implementations as needed.
The WLT Make runner selects this mode explicitly. Generic CLI configuration still defaults
to `files` unless overridden.

Key properties:

- **Language-unit chunks.** Symbols are real classes, functions, methods and HTTP endpoints — never fixed-size token windows.
- **Stable identities.** A symbol ID is a hash of `repository + path + kind + qualified name + signature`, never a line number.
- **Content-addressed caching.** A module is re-analyzed only when its evidence pack changes. Re-running `analyze` on an unchanged repository makes zero LLM calls.
- **Measured context budgets.** `context_pack mode=evidence` combines up to eight queries into cited source excerpts and stored memory under one configurable budget (120,000 tokens by default). The default `map` mode shares this ceiling and optional complete source. Technical/product analysis uses configurable 120,000-token evidence packs instead of a fixed 50-symbol cutoff. Counts use `o200k_base` as a declared proxy.
- **Evidence or it does not exist.** A finding without file/line evidence is never stored.
- **Graceful degradation.** No vector services? Search falls back to FTS5 + graph. No SCIP indexer? Scan continues with syntactic edges. No LLM? Deterministic layers still work.

Supported languages today: **TypeScript/TSX, JavaScript/JSX** and **Python** (including FastAPI route detection). Configured Markdown/plain-text documentation is also indexed for product context. Other files retain their Git metadata.

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| [Bun](https://bun.sh) | >= 1.3 | Runtime and package manager (not npm/pnpm) |
| Node.js | >= 22 | Tested with 22.12.0; required by directed Stryker execution |
| git | any recent | Required — RepoLead only indexes git repositories |
| Docker | any recent | For Qdrant + embedding/reranking services |
| RAM | Depends on model placement and context size | Local generation can offload layers to RAM |
| Disk | Space for images, indexes and model weights | Embeddings alone use about 8 GB; the generator download is about 6.6 GB |
| GPU (optional) | NVIDIA | The shipped override targets RTX 40xx; generation shares VRAM with embeddings |

Optional Joern downloads require additional disk space. The local generator is
separate from embeddings and is the default primary analysis model.

For the LLM layers (`analyze`, `audit`) choose:

- **Ollama with `qwen3.5:9b-q4_K_M`** — local generation by default, without Anthropic credentials.
- Explicit `--backend api` with `ANTHROPIC_API_KEY`, or `--backend claude-code` with an authenticated Claude Code installation, to use remote generation.

## Quickstart

```bash
git clone git@github.com:marco-devx/repolead.git
cd repolead
bun install
docker compose --profile leaf up -d
docker compose exec leaf-model ollama pull qwen3.5:9b-q4_K_M

alias repolead="bun $(pwd)/apps/cli/src/index.ts"

cd /path/to/your/repo
repolead onboard .
```

`onboard` chains scan, technical and product analysis, policy audit, and vector indexing of all generated knowledge. It prints the client registration commands at the end.

## Precomputed context for product and engineering

Keep requirements, workflows and decisions in tracked documentation. By default,
RepoLead ingests `README.md` and text documents under `docs/`; configure other
locations in `.repolead.yaml`:

```yaml
version: 1
analysis_mode: files
documentation:
  paths: [README.md, docs, requirements]
modules:
  - name: api
    path: src/api
analysis_budget:
  file_pack_bytes: 24000
  max_tokens: 120000
  max_source_lines_per_pack: 100000
  max_reanalysis_depth: 3
model:
  backend: ollama
```

Only Git-tracked `.md`, `.mdx`, `.txt` and `.rst` documents up to 1 MiB are
ingested. Relative Markdown links to code create `DOCUMENTED_BY` relations;
line anchors such as `../src/orders.ts#L12` also identify enclosing symbols.
Unknown config keys, duplicate module paths and paths outside the repo fail
explicitly. CLI budget/model flags override configuration. Files outside the
declared modules are assigned to a root module.

```bash
repolead refresh .
repolead analyze --dry-run
repolead analyze --audience all
repolead brief --product --json
repolead brief --document docs/product.md --json
```

Product context contains goals, features, roles, user flows, business rules and
decisions with evidence. Claims distinguish `documented`, `implemented` and
`inferred`; unsupported information stays in `unknowns`. Documentation alone
cannot support an `implemented` claim. Large documents are analyzed in bounded
sections covering every line. The default file workflow stops after first-round
synthesis groups: no later rounds, repository brief or global product summary is generated.
These checks establish provenance, not automatic semantic correctness.

MCP clients use `context_pack mode=evidence` with focused queries and
`types:["summary","document"]` to retrieve pertinent file analyses, first-round
groups and product documents. Hybrid retrieval uses vectors, lexical matches and
reranking when available; it does not require a global summary. Verify implementation
details with source evidence. `repo_overview` reports inventory and analysis status.
Reads use stored knowledge without new generation; connecting MCP does not inject
the database into the client's context window. Explicit exhaustive symbol mode
retains its legacy global briefs.

`refresh . --analyze` refreshes both audiences. It compares indexed file hashes,
reuses unchanged syntax extractions and recomputes changed summaries through
the content cache. A repeated dirty working tree does not cause another scan.
With `--analyze`, missing or interrupted analysis still runs against that current
snapshot; a fully unchanged repeat makes no new model calls. Technical file
dossiers include recognized text files without symbols, such as barrels, startup
scripts and JSON configuration. Documentation has its own cards.
SCIP, when enabled, still runs as a project-level indexer. `onboard --no-product`
and `refresh --analyze --no-product` skip product generation.

`analysis_budget.max_reanalysis_depth` defaults to 3 (range 0–32). It bounds
outgoing dependency hops used for cache invalidation; 0 tracks only the subject's
own facts and relationship structure. File/module/repository syntheses always
follow changes to their children. Missing compiler references use a conservative
file-import fallback. Depth boundaries and missing dependency content are exposed
in `unknowns`; increasing depth does not prove transitive runtime behavior.

## CLI reference

| Command | Purpose | Options |
|---|---|---|
| `repolead onboard [path]` | Full setup of a repo in one command: scan + analyze + audit + reindex | `--db <path>` custom database file · `--name <name>` repository name · `--model <name>` · `--backend ollama\|api\|claude-code` · `--policies <dir>` · `--no-scip` · `--no-analyze` · `--no-audit` |
| `repolead scan [path]` | Deterministic indexing: files, symbols, references, modules, git metrics | `--db <path>` · `--name <name>` · `--no-scip` skip reference resolution |
| `repolead refresh [path]` | Compare indexed contents and reuse unchanged file extractions | `--db <path>` · `--analyze` refresh technical and product knowledge · `--no-product` · `--model` · `--backend` · `--no-scip` |
| `repolead analyze` | Generate technical and product context with evidence | `--audience technical\|product\|all` (default `all`) · `--db <path>` · `--module <name-or-path>` (technical scope) · `--dry-run` · `--context-tokens <n>` · `--model <name>` · `--backend ollama\|api\|claude-code` |
| `repolead impact` | Potential change scope, contracts, tests, risk factors and provisional workflow | `--change <text>` · repeatable `--symbol`/`--path` · `--fact name=true\|false` · `--max-depth`/`--max-nodes`/`--max-edges` · `--limit`/`--offset` · `--db` · `--json` |
| `repolead trace <from> [to]` | Shortest static call paths to a symbol or recorded effect | `--max-depth`/`--max-nodes`/`--max-edges` · `--max-paths` · `--db` · `--json` |
| `repolead hotspots` | Rank callable hotspots with measured factors and uncertainty | `--module <name-or-path-or-id>` · `--offset` · `--limit` (default 10, max 200) · `--db` · `--json` |
| `repolead opportunities` | Materialize and read suggestions from confirmed findings and hotspots | Same pagination/module/database options as `hotspots`; refreshes the whole snapshot projection before filtering |
| `repolead audit` | Run versioned policies with evidence requirements and cached, validated judgments | `--db <path>` · `--policies <dir>` · `--context-tokens <n>` · `--model` · `--backend` · `--no-judge` store raw candidates |
| `repolead brief` | Read precomputed technical or product knowledge | `--db <path>` · one of `--module <name-or-path>`, `--file <path>`, `--symbol <name-or-id>`, `--product`, `--document <path>` · `--json` |
| `repolead query <text...>` | Search code, summaries, findings, documentation and tests | `--db <path>` · `--limit <n>` · `--type` · `--language` · `--module` · `--kind` · `--snapshot` · `--collection` |
| `repolead context [query...]` | Ranked, compact task context without an LLM call | `--symbols <names...>` · `--module <name>` · `--tokens <n>` (default 120000) · `--source` · `--json` · `--db <path>` |
| `repolead benchmark-tokens` | Compare relevant-file reads with compact context, including target-source coverage | `--cases <json>` · `--tokens <n>` · `--db <path>` |
| `repolead reindex` | Rebuild searchable knowledge and synchronize Qdrant from SQLite | `--db <path>` · `--collection <name>` |
| `repolead serve` | Start the MCP server over stdio | `--db <path>` one repo · `--dir <path>` every repo under a directory · `--tool-profile all\|context` |
| `repolead mutation` | Plan/run/import/read directed mutation testing | `--run --test-command`, `--report`, `--results` |
| `repolead dataflow <source-method> <sink-call>` | Run/read optional Joern data flow | `--run`, `--language`, `--max-paths` |
| `repolead install-hooks [path]` | Install a Claude Code PreToolUse hook that steers agents toward RepoLead instead of raw file reads | `--remove` uninstall |
| `repolead doctor` | Check binaries/services and inspect extraction/reference diagnostics | `--db <path>` latest snapshot diagnostics · `--json` full structured report |
| `repolead metrics` | Read metrics, run optional configured analyzers and import LCOV | `--db <path>` · `--tools jscpd,ruff,radon` or `none` · `--coverage coverage/lcov.info` · `--json` |

Analysis defaults to `ollama`, even when Anthropic credentials are present. Select `--backend ollama|api|claude-code` or `model.backend` in `.repolead.yaml`; CLI flags take precedence. Ollama handles symbols, files, modules, repository/document/product memory and policy judgments. Missing models, context overflow and invalid responses fail explicitly without switching to Claude. Existing configurations that explicitly select Claude keep that choice. Local generation uses your hardware, while Claude as an MCP client still consumes tokens to answer questions.

`onboard`, `analyze` and `refresh --analyze` accept `--context-tokens <n>` (default
120000) for each symbol, file, module and repository evidence pack. This is an evidence
budget, not a limit on total provider usage including schemas and output.

The first hierarchical analysis makes more calls than a module-only overview.
Use `analyze --dry-run` to inspect the work before selecting a paid backend.
Every generated level is schema-validated and may cite only evidence IDs it
actually received. Invalid responses get up to two correction retries. Partial
source and omitted evidence remain visible in persisted `unknowns`; unchanged
inputs reuse the technical and product caches without new model calls.

Policy audits also cache positive and negative judgments by policy definition,
version, candidate evidence, indexed file hashes, prompt and model. Repeated
audits update stable findings instead of duplicating them. Candidate prompts
are token-bounded; missing required evidence and budget omissions are reported.

## Quality measurements

`scan` measures physical LOC, AST cyclomatic complexity, a cognitive estimate,
nesting and empty exception handlers, plus distinct observed fan-in/out and
module dependency metrics. Optional tools analyze immutable captured source:

```yaml
metrics:
  tools: [jscpd, ruff, radon]
  coverage: coverage/lcov.info
```

Install jscpd with `bun install`; create `.repolead-tools/python` with `python3 -m
venv .repolead-tools/python` and install `services/quality/requirements.txt` in
that environment for Ruff/Radon. `doctor` checks availability. Tools run during
scan/refresh when configured, or explicitly with `repolead metrics --tools
jscpd,ruff,radon --json`. `--tools none` only reads stored measurements.

Reports are cached by tool version/profile and indexed source hashes. Missing
tools and coverage remain unknown. LCOV imports retain provenance; reports
without matching line checksums do not establish freshness. No target tests
are executed. Run `analyze`/`audit` after changing measurements to update their
interpretations; `refresh --analyze` also refreshes product knowledge.
See the [technical guide](docs/guia-tecnica.md#414-metrics-mediciones-de-calidad-y-cobertura)
for metric definitions, installation and source-binding limits.

The policy pack has twelve rules, including framework-owned types in public
domain contracts, cycles across two or more modules, measured complexity,
duplication, empty exception handlers and Python diagnostics. A
[real-model audit evaluation](benchmarks/policy-quality-acceptance.json) passed
16 authored positive/counterexample cases across eight policies, with zero
additional model calls on repeat. This finite fixture does not establish
population-wide precision or whole-repository summary quality.

## MCP tools

Once served, agents see these tools:

| Tool | Arguments | Returns |
|---|---|---|
| `context_pack` | `mode?`, `query?`, `queries?`, `types?`, `includeTests?`, `symbols?`, `module?`, `maxTokens?`, `includeSource?`, `repo?` | `evidence`: batched search with cited source and memory; `map`: compact navigation. Omissions explicit; multi-repo requires `repo` |
| `repo_overview` | `repo?`, `audience?` (`technical` or `product`) | Snapshot stats, selected brief and its resource URI. With `--dir` and no `repo`, lists every served repository |
| `module_context` | `module`, `repo?` | Module dossier: responsibility, public API, dependencies, risks, confirmed findings |
| `symbol_context` | `symbol`, `repo?` | Stored symbol card, location, signature and incoming/outgoing relations |
| `find_callers` | `symbol`, `transitiveDepth?`, `repo?` | Who calls a symbol, breadth-first up to depth 5 |
| `find_references` | `symbol`, `includeDefinitions?`, `limit?`, `offset?`, `repo?` | Compiler-resolved locations with UTF-16 columns, call/reference distinction and indexer status; 50 per page by default, up to 200 |
| `impact_analysis` | `change?`, `symbols?`, `paths?`, `facts?`, traversal limits, `limit?`, `offset?`, `repo?` | Potential affected code, public contracts, tests, reported coverage, effects and findings; an explained score with unknown-factor range and provisional workflow |
| `trace_flow` | `from`, `to?`, `maxDepth?`, `maxNodes?`, `maxEdges?`, `maxPaths?`, `repo?` | Shortest stored call/effect paths with analyzer locations and explicit bounds; not a runtime or data-flow trace |
| `mutation_results` | `reportId?`, `offset?`, `limit?`, `repo?` | Current snapshot mutation report; never runs tests |
| `hotspots` | `module?`, `offset?`, `limit?`, `repo?` | Complexity × observed fan-in × file churn × verified coverage; factor provenance and uncertainty range |
| `improvement_opportunities` | `module?`, `offset?`, `limit?`, `repo?` | Persisted ranked findings/hotspots with evidence; stale projections withheld; default 10 per page, max 200 |
| `architecture_findings` | `severity?`, `module?`, `repo?` | Confirmed policy findings, filterable |
| `get_evidence` | `evidenceId?`, `documentId?`, `findingId?`, `opportunityId?`, `path?` or `ranges?`, `maxTokens?`, `startLine?`/`endLine?`, `repo?` | Provenance or source; batch up to 20 ranges with one measured budget (default 120,000), source hashes and explicit continuation lines |
| `search` | `query`, `limit?`, `type?`, `language?`, `module?`, `kind?`, `repo?` | Hybrid knowledge search with IDs, locations and summary resource URIs; multilingual queries supported. Without `repo`, searches all served repositories |

In multi-repo mode (`serve --dir`), unambiguous symbols and modules resolve automatically. Duplicate names are rejected; use a symbol ID or module ID/path, and `repo` when IDs overlap across databases. Served aliases must be unique. `context_pack` and source reads by path require `repo` when more than one repository is served. Finding evidence is restricted to the current snapshot, so old coordinates never read a new version of the file.

`impact_analysis` also requires `repo` in multi-repository mode. A change description
can name an exact indexed identifier (`Add retries to OrderRepository.save`);
otherwise the tool returns selection suggestions. It does not invent a target from
prose. Counts and scoring cover the bounded traversal; detail categories paginate
independently with `limit` (default 20) and `offset`.

```bash
repolead impact --change 'Add retries to OrderRepository.save' --json
repolead impact --path src/payments --fact schemaChange=true --fact reversible=false --json
repolead trace 'POST /payments' 'OrderRepository.save' --max-paths 5 --json
```

Both analyses read SQLite without LLM calls or executing target code. Trace follows
`CALLS` and recorded effect edges, not imports or type references. Named Express
handler aliases can be bound through SCIP. Missing coverage, security/concurrency
context and unclassified side effects remain unknown; a method named `save` alone
does not prove database access. See the [technical guide](docs/guia-tecnica.md#415-impact-alcance-y-puntaje-de-un-cambio)
for the twelve score factors, limits and interpretation.

`hotspots` and `improvement_opportunities` require `repo` in multi-repository mode.
The module filter selects an exact owning module by name, path or ID; ambiguous
names are rejected. `scan`, `refresh`, quality collection and `audit` update the
persisted opportunity projection; `repolead opportunities` can rebuild an older
database's projection without reanalysis. MCP reads never rebuild it. Changed
inputs invalidate the projection and old opportunity evidence is refused.

```bash
repolead hotspots --module payments --json
repolead opportunities --limit 10 --json
```

Priorities combine AST complexity, distinct observed references, file changes
within the last 500 Git commits and checksum-verified reported line coverage.
Missing coverage remains unknown. Findings retain their severity and source ID;
unjudged candidates are excluded. Effort, business value and mutation-test results
are not inferred. Directed mutation testing is available explicitly:

```bash
repolead mutation --json
repolead mutation --run --test-command 'node --test test/*.test.js'
repolead mutation --results
repolead dataflow entry sink --run --language javascript
```

Stryker runs only planned hotspot ranges; report imports validate original source
and scope. `mutation_results` is read-only in MCP. Optional Joern consumes captured
source and publishes static parameter-to-call-argument flows; read them through
`trace_flow` with `engine: "joern"`. New snapshots require new reports. See the
[command guide](docs/guia-tecnica.md#419-mutation-mutaciones-dirigidas-por-hotspots).

Start/download Ollama with the Compose `leaf` profile. `local_model` configures its
endpoint, model, context, output and timeout; `--model` overrides the model name.
With the default `ollama` backend, every level uses the local primary, including
nontrivial code and critical modules. Explicit remote backends can still combine
`local_model` with a conservative local route for trivial JS/TS scalar functions.
CLI analysis defaults to `analysis_mode: files`: complete recognized source is analyzed
per file in bounded sections, then synthesized into file/module/repository dossiers.
This avoids one generation per DTO/function. File dossiers retain cited `productFacts`
for fields, constraints, permissions, messages, states and audit events. Large sources
and syntheses are split instead of silently dropping their tails. `file_pack_bytes`
bounds packet bytes independently of the unchanged 120,000-token evidence ceiling.
Use `--analysis-mode symbols` for exhaustive individual cards; `symbol_selection:
public-or-nontrivial` applies to that mode. Both modes retain the full symbol index.
Preview the work without model calls with `repolead analyze --dry-run`.
`onboard` and `refresh` accept `--no-vectors` to finish generation without contacting
embedding/vector services; follow with `repolead reindex --db <repo>/.repolead/repolead.db`.
This enables separate GPU phases without changing model weights or discarding cached memory.
Real weight digests and generation options participate in caching.
See [selection and local model setup](docs/guia-tecnica.md#selección-de-fichas-y-generación-local).

The server also exposes discoverable MCP resources for every stored analysis
level. List resources and read the returned URI to access precomputed context
without invoking a tool or a model. Resource URIs stay stable across snapshots
and resolve against the latest indexed snapshot; they do not silently fall back
to an older dossier. Reading a resource does not automatically preload it into
every client conversation.

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

The server can expose the indexed knowledge over authenticated HTTP for MCP clients that support a configured bearer token:

```bash
REPOLEAD_TOKEN=<strong-secret> repolead serve --dir /srv/repos --only backend,webapp --product --http --host 127.0.0.1 --port 3939
```

- `--http` switches from stdio to stateless MCP Streamable HTTP at `/mcp`; MCP requests require `Authorization: Bearer <token>`. It binds to `127.0.0.1` by default; `--host` selects another interface.
- A browser `Origin` must match a repeatable `--allow-origin https://product.example` entry. Allowed preflight requests do not require the token; subsequent MCP requests do. Bodies are limited to 1 MiB. These origin/local-binding defaults follow the [MCP 2025-11-25 transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- `--product` exposes a separate functional projection through `product_catalog`, `product_context`, `product_evidence` and `product_investigate`. It registers no technical tools or raw resources and opens SQLite read-only. With `--dir`, an explicit `--only` repository allowlist is required; newly created allowlisted databases are discovered every five seconds. Queries select the latest complete entrypoint analysis automatically, retaining an older complete snapshot while a newer one is processing. Generated interpretations include provenance refs, uncertainty, omissions and coverage gaps; they do not establish deployed behavior. `product_investigate` corroborates a focused question against captured source and dependencies using a background local-model job, with a second source review. Start it with product refs or English code keywords and poll its job ID; follow source refs to investigate omitted dependencies. It returns functional findings, bounded observations, inferences and source-location metadata, without raw code. Jobs are serialized, limited to four pending/running and cached in memory while evidence stays current. Obvious code blocks and secret patterns are excluded from projected prose; this is not a general DLP guarantee.
- `--no-source` only disables new raw source reads in the technical server. Stored excerpts, signatures, documents and technical resources remain accessible; it is not the product confidentiality boundary.
- `--tool-profile context` exposes only `repo_overview`, `context_pack`, `search` and `get_evidence`, reducing the schema catalog for retrieval-only clients. The default `all` profile keeps all fourteen tools. Resources remain available in both profiles; this is not an access-control boundary.
- For repeated evidence retrieval in the same conversation, `context_pack` accepts `knownBlocks`. Start with `mode=evidence, knownBlocks=[]` to receive SHA-256 receipts; on follow-ups, pass only receipts whose full block text remains available to the client. Validated identical blocks return `UNCHANGED` references, while changed evidence is delivered again. After conversation compaction, omit receipts for lost blocks to retrieve their text. This is opt-in transport reuse, not a model prompt-cache or a guarantee of billing savings.
- Use HTTPS through a reverse proxy or tunnel. Claude's remote custom connectors connect from Anthropic infrastructure, including Cowork and Desktop; a private VPN-only address is insufficient. Fixed bearer credentials can be configured under Request headers in the connector settings. See [Claude's connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Connect using a client that can attach the configured bearer token, for example:

```bash
claude mcp add --transport http repolead https://your-host/mcp --header "Authorization: Bearer <token>"
```

For an ephemeral demo, `python3 scripts/product-demo.py start --dir /path/to/repos --repos-file allowed.json --tunnel cloudflared` starts only a product MCP and HTTPS tunnel. `allowed.json` is a JSON array of authorized repository aliases; build the CLI and install the official tunnel binary first. Credentials stay in ignored private files under `.repolead/product-demo/`. Use `status` or `stop` on that script to inspect or stop only its owned processes. It does not operate Docker or run analyses. `bun scripts/verify-product-demo.ts` verifies public retrieval and isolation using that local credential file; it does not validate generated PRDs or product semantics.

Keep the indexes fresh with a cron job on the host:

```
*/30 * * * * cd /srv/repos && for d in */; do git -C "$d" pull -q && repolead refresh "$d" --analyze; done
```

Content-addressed caching keeps this cheap: unchanged modules cost zero LLM calls.

## Connect to Codex

Register a repository using the [Codex MCP CLI](https://developers.openai.com/codex/mcp):

```bash
codex mcp add repolead -- bun /path/to/repolead/apps/cli/src/index.ts serve --db /path/to/your/repo/.repolead/repolead.db
```

Alternatively, add a multi-repository server to `~/.codex/config.toml`:

```toml
[mcp_servers.repolead]
command = "bun"
args = ["/path/to/repolead/apps/cli/src/index.ts", "serve", "--dir", "/path/to/your/repos"]
```

Start a new Codex session after registering it, then use `/mcp` to inspect the
connection. The server recommends `context_pack` in its MCP instructions.
Example task:

> Use RepoLead's context_pack with maxTokens=2000 to locate the authentication
> code. Request source only for the relevant symbols and check omission counts.

`onboard` prints registration commands for both Claude Code and Codex. The
stdio server observes refreshed snapshots without requiring a restart.

## Measure token savings

```bash
repolead context --symbols analyzeSubject --tokens 2000 --source
repolead benchmark-tokens --cases benchmarks/token-cases.json --tokens 2000
```

The benchmark compares relevant-file source with task context that retains the
complete target function bodies. It reports coverage and negative savings too.
It makes no LLM calls. Counts are `o200k_base` measurements, not exact Fable/Astra
billing or a measurement of reasoning tokens. See the
[design, upstream ideas and limitations](CONTEXT.md) and
[recorded benchmark](benchmarks/token-results.json).

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

## Models

| Role | Model | Served by |
|---|---|---|
| Embeddings | Qwen3-Embedding-4B | Text Embeddings Inference (TEI) |
| Reranking | Qwen3-Reranker-0.6B | Local Transformers service, TEI-compatible API |
| Tech Lead analysis and policy judge (default) | qwen3.5:9b-q4_K_M | Local Ollama |
| Explicit remote generation | claude-opus-5 (API) or your Claude Code default model | Anthropic |

Vectors are derived data: `repolead reindex` rebuilds them from SQLite, including
complete persisted symbol bodies, document sections, summaries and confirmed
findings. Modern test records retain complete bodies with exact source spans;
legacy records without spans retain names and paths. No mounted checkout is
needed for modern snapshots. Run `refresh` once for legacy snapshots without
stored source or spans. Standalone `analyze`/`audit` update lexical search immediately;
run `reindex` afterward to synchronize vectors.

Compose pins model revisions. Reindex reuses vectors only when the full input
hash and model revision/configuration match; unchanged vectors receive payload
updates only, and obsolete points are physically purged within that repository.
Oversized inputs are reported and remain in lexical search; TEI truncation is
disabled explicitly. The default collection retains the name `repolead-symbols`.
Use `--collection` for a separate index (required when changing vector dimensions).

## Development

```bash
bun install
bun run check     # lint + typecheck + tests + build
bun run test
bun run verify-memory
bun run verify-incremental # real SCIP + contract model + both audiences and MCP
bun run verify-prioritization # real Git/SCIP + persisted rankings + Node CLI and MCP
bun run verify-quality # real jscpd/Ruff/Radon, LCOV, cached analysis and MCP
bun run verify-mcp-http # compiled CLI, two repositories/clients, product/technical resources
bun run verify-change-analysis # actual SCIP routes/calls, impact, CLI and no-source MCP
bun run verify-policy-quality # REAL Claude Code calls; consumes model quota
bun run verify-mutation # runs Stryker on a temporary hotspot fixture
bun run verify-python # actual Python SCIP, Ruff/Radon and MCP
bun run verify-joern # requires pinned Joern; JS/Python data-flow acceptance
bun run verify-clean-install # isolated frozen install + CI gates
REPOLEAD_ACCEPTANCE_MODEL=haiku bun run verify-generative # REAL Claude Code + local Ollama
bun run verify-token-workflow # REAL matched manual/MCP sessions after verify-generative
REPOLEAD_ACCEPTANCE_MODEL=sonnet bun run verify-repo-workflow # REAL matched sessions on captured RepoLead source
bun run verify-deterministic # compiler references, real repo inventory, MCP and doctor
bun run verify-retrieval  # requires local TEI embeddings, reranker and Qdrant
```

The [retrieval acceptance report](benchmarks/retrieval-acceptance.json) records
8/8 Spanish/English queries at rank 1 over 28 English-source fixture functions,
zero new embeddings on repeat and one new embedding after one body change. It
also checks physical deletion, repository isolation and source-free rebuilding.
This measures fixture retrieval, not generative answer quality or billed tokens.

The [HTTP acceptance report](benchmarks/mcp-http-acceptance.json) verifies two
connected clients, twenty resources, overlapping subject IDs, product documents,
source restrictions and live snapshot changes through the compiled CLI. It
negotiates protocol `2025-11-25`; it does not claim support for the 2026 transport.
One bearer token grants access to every served repository.

The [deterministic acceptance report](benchmarks/deterministic-acceptance.json)
compares SQLite references for 20 functions against the TypeScript language
service, including imports, direct calls, callback references and Unicode
columns. A resolved function reference becomes `CALLS` only at an AST call site;
other uses remain `DEPENDS_ON`. `doctor --db ... --json` reports unmapped
definitions, syntax issues and unsupported dynamic route declarations.

Exports include ESM aliases/reexports, CommonJS bindings and Python declarations
with literal `__all__` support. Express, Nest and FastAPI route metadata describes
declared paths and named handlers; it does not infer global prefixes, router
mounting or arbitrary runtime composition. Inferred modules use manifests and
reexport barrels; explicit `.repolead.yaml` modules take precedence.

The complete roadmap is still in progress. The
[requirement status](docs/roadmap-status.json) distinguishes implemented features,
acceptance evidence and pending performance criteria. The
[real generation evaluation](benchmarks/generative-acceptance.json) verifies
technical/product dossiers, a local Qwen leaf, zero-call repeated analysis and
incremental detection of a documented/implemented rule discrepancy. This is
finite fixture evidence, not a general semantic accuracy guarantee. Whole-session
token savings vary by task; the roadmap's 90% reduction target remains unmet.

The local model stack now uses Qwen3-Embedding-4B, Qwen3-Reranker-0.6B and optional Qwen3.5-9B Q4_K_M. Retrieval and technical/product evidence default to a 120,000-token ceiling; this does not enlarge the embedding model’s 32K per-input window or guarantee lower costs. The [new retrieval check](benchmarks/retrieval-upgrade-acceptance.json) retains 8/8 first-place results on the finite bilingual fixture. See the [model migration guide](docs/guia-tecnica.md#modelos-locales-actualizados-y-migración).

**21 of 22 requirements are complete within their recorded acceptance scope.** The latest [prepared-module corroboration](benchmarks/preloaded-savings-corroboration.json) compares three fixed questions on the real Git adapter: 66,096 manual versus 55,306 MCP query tokens (**16.3% fewer**), with requested facts and citations checked against source. However, SDK estimated query cost rose **43.5%** (USD 0.218253 → 0.313251), and preparing the 11 dossiers added 144,114 tokens and USD 0.314480. Unchanged preparation made zero new calls. This small-module result does not establish monetary savings or generalize to other models/repositories. The 90% reduction target remains open; historical positive and negative runs, cache breakdown and reproduction instructions are in the [technical guide](docs/guia-tecnica.md#64-sesiones-reales-ahorro-costo-inicial-y-límites).

The [change-analysis acceptance report](benchmarks/change-analysis-acceptance.json)
checks two real SCIP paths from an imported HTTP handler to a persistence function,
reference-only callbacks, public/private member visibility, relevant tests,
source-checked LCOV, compiled commands and MCP snapshot freshness. The score is
a versioned prioritization heuristic; it is not calibrated effort or defect probability.

The [prioritization acceptance report](benchmarks/prioritization-acceptance.json)
verifies six Git commits, actual SCIP references, source-checked synthetic LCOV,
automatic opportunity updates, cached repeat, compiled Node CLI and nine MCP
calls including stale/historical evidence rejection. Its audit judge is a
contract fixture; ranking itself makes no generative calls.

The [quality acceptance report](benchmarks/quality-acceptance.json) verifies
actual jscpd/Ruff/Radon outputs, coverage import, three cached tool reports,
zero additional contract-model calls on repeat, compiled CLI and MCP delivery.
The LCOV fixture has prescribed counts; it is not a test run of RepoLead itself.

The [incremental acceptance report](benchmarks/incremental-acceptance.json)
records which technical/product subjects are regenerated after one function body
changes, checks unchanged dossier contents and verifies current MCP resources
after refresh and rename. Its model is a contract fixture: call counts validate
orchestration, not real-provider latency, semantic quality or billed token savings.

Toolchain: Bun workspaces, [Rsbuild](https://rsbuild.rs), [Rstest](https://rstest.rs), [Rslint](https://rslint.rs).

## License

[MIT](LICENSE)
