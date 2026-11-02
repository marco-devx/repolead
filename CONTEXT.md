# Budgeted context and token measurements

The CLI now defaults to `analysis_mode: files`. It consumes complete recognized
technical source in bounded file sections and recursively synthesizes large parents;
it does not generate one card per symbol. File dossiers include cited `productFacts`.
The symbol index and raw evidence remain intact. `analysis_budget.file_pack_bytes`
defaults to 24000; oversized source continues in another section rather than being
silently truncated. The 120000-token retrieval/analysis ceiling remains unchanged.
`--analysis-mode symbols` retains exhaustive symbol cards; the library's omitted
`analysisMode` retains its existing exhaustive behavior for compatibility.
`analyze --dry-run` reports the selected mode's minimum plan. Additional hierarchy
steps can expand the progress total. See `benchmarks/file-mode-plan.json` for the
read-only access-service plan (6664 to at least 880 tasks), not a wall-clock claim.

RepoLead now provides a deterministic `context_pack` MCP tool and a `context`
CLI command. Neither calls an LLM. A task selects named symbols or search hits;
the map includes their immediate relationships, ranked within a measured token
budget. Source mode prioritizes complete target function bodies and outgoing
dependencies. Map mode also includes callers. Omitted context is reported.

```bash
repolead context --symbols analyzeSubject --tokens 2000
repolead context --symbols analyzeSubject --tokens 2000 --source
repolead analyze --context-tokens 4000 --dry-run
```

The response budget covers the complete returned text, including its metadata.
For `context --json`, the count describes the `text` field, not the additional
diagnostic JSON envelope. MCP transport overhead is not included.

## Open-source ideas reused

- [Aider's repository map](https://aider.chat/docs/repomap.html) and
  [ranking implementation](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py):
  personalized graph ranking, a token budget, and progressive source retrieval.
  RepoLead implements the algorithm independently in TypeScript and ranks its
  existing symbol graph; no Aider source files were copied.
- [CocoIndex](https://github.com/cocoindex-io/cocoindex): dependency-aware
  invalidation and reuse of derived data. Module fingerprints cover all owned
  files, symbol content and incident dependencies, even evidence omitted from
  a prompt. Vector updates reuse unchanged embedding inputs with the same
  reported model/configuration identity, while updating every live point's
  snapshot. This is an independent implementation, not a CocoIndex dependency.
- [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT) is used directly
  for local BPE token counting, with the explicit `o200k_base` encoding.
- [jscpd](https://github.com/kucherenko/jscpd), [Ruff](https://github.com/astral-sh/ruff)
  and [Radon](https://github.com/rubik/radon) run as optional installed analyzers.
  RepoLead normalizes their actual results, caches reports by source/tool/profile
  and supplies measured evidence to technical analysis and policy candidates.
  Their engines are not copied or simulated. See [quality acceptance](benchmarks/quality-acceptance.json).

CodeGraphContext and ast-grep have not been integrated in this change. Adding
language adapters or a structural-rule engine is separate from context savings.

## Analysis and correctness

The old default of 50 symbols / 200 internal edges is replaced by a configurable
120000-token evidence budget. Optional symbol/edge caps remain available through
the library API. Symbol cards now receive indexed source (up to the configured
line/token budget), then file dossiers, module dossiers and the repository
brief are synthesized bottom-up. Each evidence pack is bounded. Prompt
instructions, output schemas and model output are additional
tokens; `--context-tokens` is not a total provider bill limit.

The most specific module owns each file. Parent modules no longer repeat all
child symbols. Truncation counts include relations lost when their symbols are
omitted, files, tests and dependencies. A quarter of the module evidence budget
is reserved for non-symbol information. The final synthesis distributes space
across modules before adding larger dossier sections.

Analysis caches include content fingerprints, analysis policy version, prompt
version and model name. Output schemas and referenced evidence IDs are
validated before storage, with at most two correction retries. Immutable
evidence records preserve provenance when cached summaries move to a new
snapshot. Source and evidence omissions are persisted in `unknowns` even if
the model omits those warnings. MCP resources and `brief --symbol` / `--file`
expose the additional levels without new model calls.

A model name that aliases mutable weights is still not a pinned model revision.
Unchanged evidence produces no new analysis calls; source changes invalidate
the affected symbol/file/module chain. Initial analysis therefore costs more
than the former module-only analysis; inspect `analyze --dry-run` first.

`analysis_budget.max_reanalysis_depth` defaults to 3 and accepts 0–32 outgoing
dependency hops. Own facts and relation topology always participate; changing a
caller body does not invalidate an intact callee. Without mapped compiler
definitions, file imports provide conservative dependency coverage. File/module/
repository ancestors always follow their child evidence, independently of this
depth setting. Boundary counts expose excluded dependencies. Fingerprints track
content even when dependency facts do not fit the evidence budget.

Technical dossiers now cover recognized text files without symbols, including
barrels and configuration. A file receives raw source outside bodies already
covered by its symbol cards, retaining top-level initialization without resending
each analyzed body. Partial or unavailable source remains explicit. Selected
documentation uses its document cards instead of duplicate technical dossiers.

Live source reads reject outside paths, outside symlinks, unindexed files and files
whose hashes differ from the indexed snapshot. `get_evidence` serves source to EOF or explicit endLine under a 120000-token
default; grouped ranges share one budget and indicate where to continue.
`--no-source` also applies to `context_pack`. Existing stored finding excerpts
remain available in product mode.

Long-lived stdio and HTTP MCP clients observe new snapshots without restarting.
This does not create automatic indexing: run `refresh` when source changes.
Duplicate symbol/module names and overlapping IDs across served repositories
require explicit disambiguation. Finding evidence only resolves in the current
snapshot; immutable summary provenance remains metadata about its original evidence.

HTTP defaults to localhost with a required bearer token. Browser origins must be
explicitly allowed using repeatable `--allow-origin` flags; an allowed preflight
does not authorize the subsequent MCP request. Request bodies are bounded at
1 MiB and decode UTF-8 after combining chunks. The
[HTTP acceptance report](benchmarks/mcp-http-acceptance.json) covers compiled CLI,
two repositories, two clients and protocol 2025-11-25.

Product context uses tracked documentation selected by `.repolead.yaml`
(`README.md` and `docs/` by default), alongside the technical dossiers.
`analyze --audience all` generates both views; `brief --product` and MCP
`repo_overview` with `audience: "product"` read the stored result. Each product
claim records documented/implemented/inferred support and evidence IDs.
Documentation alone cannot establish implemented behavior. Long documents
are analyzed in bounded sections covering all lines; synthesis omissions
remain explicit. Cached reads do not automatically preload a client's chat.

The [roadmap status](docs/roadmap-status.json) distinguishes implemented features
from remaining acceptance. [Real generation](benchmarks/generative-acceptance.json)
verifies the hierarchy, a local Qwen scalar-conversion card, zero-call unchanged
repeat and a product discrepancy after changing code. Cold preparation consumed
substantial tokens; a tiny repository's direct reads remained cheaper than MCP.
These finite fixtures do not establish general accuracy or the 90% savings target.
The [latest prepared-module corroboration](benchmarks/preloaded-savings-corroboration.json)
uses three fixed Git-adapter questions: 66,096 manual vs 55,306 MCP query tokens
(16.3% fewer), but SDK estimated query cost is 43.5% higher. Preparation adds
144,114 tokens; unchanged repeat makes zero calls. Source-reviewed requested
facts pass, but this is neither monetary savings nor summary-only validation.
The separate [policy evaluation](benchmarks/policy-quality-acceptance.json)
passed 16 authored cases with a real Claude Code backend; it evaluates audit
decisions, not the quality or token cost of downstream product answers.

`impact_analysis`/CLI `impact` now compute potential change scope using incoming
stored references and explicit ownership. Exact compiler references do not expand
every declaration in an importing file; compiler gaps use a labeled conservative
file/container fallback. A later fallback visit can expand a file already seen by
an exact reference. Outgoing calls are walked separately for effects in unchanged
callees. Test links identify candidate tests, not assertions or execution coverage.
The twelve-factor score includes an uncertainty range; caller-provided change
facts remain labeled and workflow recommendations never launch agents.

`trace_flow`/CLI `trace` return shortest static paths with stored analyzer locations.
Imports/type references are not execution edges. Express named handler arguments
retain exact locations and lexical scope, allowing SCIP to bind imported aliases
without confusing a shadowed parameter with a same-name module function. TypeScript
member visibility persists through migration 12; legacy/Python visibility is unknown.
Both commands use traversal bounds; impact details paginate and flow path limits
are explicit. Recorded effects are consumed, but arbitrary external sinks are not
automatically classified. See [acceptance evidence](benchmarks/change-analysis-acceptance.json).

`refresh` compares indexed file hashes, configuration and extractor version.
It parses only changed TS/JS/Python files, reuses unchanged extractions and
rebuilds imports against current paths. Repeating an already-indexed dirty
working tree performs no scan. SCIP remains a project-level step when enabled.
`refresh --analyze` still prepares or resumes analysis when the index is current;
it no longer silently skips missing knowledge. Restoring a previous model/policy
can republish its cached result as the current dossier without a model call.
See [incremental acceptance](benchmarks/incremental-acceptance.json) for a real
SCIP dependency chain with a contract model and both product/technical views.
Changes to source line locations can still invalidate evidence-based summaries;
the fixture measures a body edit that preserves line locations.

`audit` caches both positive and negative verdicts, validates one verdict per
candidate and deduplicates findings/evidence. Its cache includes the full policy,
policy version, evidence/file hashes, model and prompt. Configurable prompt,
candidate and evidence budgets report omissions. Repeating an unchanged audit
makes no new judge calls; changed policy results supersede earlier active ones.

## Searchable persistent memory

Scan stores recognized text files up to 1 MiB in content-addressed SQLite blobs.
Analysis and vector rebuilding use the indexed copy without mounting the repo;
current-source tools still verify the live checkout. A unified FTS projection
covers complete symbols, summaries, confirmed findings, document sections and
complete modern test bodies (legacy records without spans retain names/paths).
Query and MCP search filter by type, language, module and kind
before limiting candidates. Vector hits must match the current SQLite content.
Documents are readable by `get_evidence documentId=...` in product mode.

`onboard` now indexes vectors after analysis and audit; `refresh --analyze`
indexes after both audience views. Standalone analysis/audit update FTS; run
`reindex` afterward for vectors. Body changes invalidate embeddings. Matching
inputs and pinned model revisions reuse vectors with payload-only updates;
obsolete points are purged by repository. Oversized inputs are reported instead
of truncated. Query/reranker outages preserve the available ranking signals.

`bun run verify-retrieval` tests real local TEI/Qdrant services with an isolated
collection. See [retrieval acceptance](benchmarks/retrieval-acceptance.json):
8/8 queries at rank 1 in a 28-function fixture, zero new embeddings on repeat,
and one after a function body change. This does not measure generative quality
or billed token savings.

Exact UTF-16 spans distinguish adjacent declarations on the same line, including
Unicode source. Export facts and declared HTTP routes are persisted and included
in analysis evidence. `find_references` reads all mapped compiler occurrences in
pages, including imports and callback uses; only AST-confirmed invocations become
`CALLS`. Missing SCIP definitions are reported as unknown reference coverage.
`doctor --db ... --json` exposes extraction and reconciliation diagnostics.
See [deterministic acceptance](benchmarks/deterministic-acceptance.json) for the
20-symbol comparison against the TypeScript language service and the real-repo
inventory. The suite does not establish complete Python SCIP conformance.

## Prioritization without generative calls

`repolead hotspots` / MCP `hotspots` rank functions and methods by AST complexity,
observed fan-in, file churn over the last 500 Git commits and checksum-verified
reported line coverage. Missing coverage is unknown. Every score has its factors
and uncertainty range; ranking is a heuristic, not defect probability or business
impact. Test files are excluded from hotspot candidates.

`repolead opportunities` builds/reads the persisted projection from confirmed
findings and hotspots. Scan, refresh, quality collection and audit also update it.
MCP `improvement_opportunities` is read-only: stale projections are withheld.
`get_evidence opportunityId=...` accepts current entries and respects no-source.
Module evidence is metadata, not a source file. Both lists use `limit` (10 by
default, maximum 200), `offset` and exact owning-module filters; multi-repo mode
requires `repo`. Effort and business value are unknown; candidate findings are
excluded. Directed Stryker plans, explicit execution, source/range-validated imports and read-only MCP results are available through `mutation` / `mutation_results`. Results are snapshot-bound; the adapter does not treat compile errors as killed mutants.

See [prioritization acceptance](benchmarks/prioritization-acceptance.json): actual
SCIP and six Git commits, source-checked synthetic LCOV, automatic/cached updates,
compiled Node CLI and nine real MCP calls. The judge is a contract fixture; the
report establishes integration, not real-model quality or token savings.

## Evidence retrieval in one response

`context_pack mode=evidence` accepts up to eight focused `queries`, retrieving
four candidates per query and deduplicating them under one response budget
(default 120,000; 256–120,000). It combines original source quotations, matching
file declarations and persisted memory. No generative model runs. The CLI
exposes the same builder with `context --evidence` or `--questions queries.json`.
Tests are excluded by default; `includeTests` opts in. Source restrictions and
current snapshot/hash checks apply. `types` can focus symbols and summaries.

Oversized symbols use AST statement excerpts with original line numbers,
enclosing headers and small earlier exit guards. These are partial quotations,
not semantic program slices; missing code can change the interpretation.
Memory keeps recorded provenance, basis and unknowns, without claiming a fresh
source read. Query coverage counts returned blocks, not verified answer facts.

MCP and CLI queries use the vector collection recorded by the index. TEI
reranking batches at most 32 complete documents and isolates oversized inputs;
those retain their fused positions with an explicit warning. This avoids losing
all reranking when a single large symbol exceeds the service limit.

## Reproduce the benchmark

MCP `get_evidence ranges` batches up to twenty current source ranges under one
global `o200k_base` budget (120,000 by default; 256–120,000). The budget includes
headers, source hashes and continuation coordinates. It removes the legacy
200-line cap, while retaining snapshot/source checks and no-source restrictions.
`context_pack` gives exact identifiers mentioned in a query priority over broad
lexical seeds. Larger useful reads can avoid repeated tool/history overhead;
they do not by themselves prove end-to-end savings.

`serve --tool-profile context` exposes four retrieval tools instead of the full
fourteen-tool catalog, on both stdio and HTTP. It keeps knowledge resources and
the same source restrictions. This is a client context optimization, not an
access-control boundary; use the default `all` profile for diagnostics/impact.

```bash
repolead scan . --db /tmp/repolead-benchmark.db
repolead benchmark-tokens --db /tmp/repolead-benchmark.db \
  --cases benchmarks/token-cases.json --tokens 2000
```

Cases provide known symbols, as after a search. For each case the benchmark
counts the numbered source of its relevant files and compares that with the
context pack including complete target source. It reports coverage, negative
savings where applicable, and source hashes identifying the measured working
tree. `mapOnlyTokens` measures navigation only and is not equivalent to receiving
the source. No inference, TEI service or Qdrant is required for this comparison.

These are exact counts for **o200k_base**, a proxy for other model tokenizers.
They are not exact Fable 5.1 or Astra billing measurements. Discovery, MCP
schemas and protocol overhead, conversation history, reasoning/output tokens,
provider caching, initial indexing/analysis cost and answer correctness are not
measured. Source coverage confirms that the selected bodies were retained; it
does not establish that those bodies alone answer every question.

See [token-results.json](benchmarks/token-results.json) for the measured run. The small
suite is a regression fixture, not an independent evaluation across repositories.


## Additional analysis backends

Optional Joern executes a fixed parameter-to-call-argument query on captured
JS/TS or Python source. `dataflow --run` publishes per-query snapshot metadata;
`trace_flow engine=joern` only reads it. Source paths and line hashes are validated,
limits are explicit, and no-source MCP does not return code. The
[real acceptance](benchmarks/joern-acceptance.json) covers both frontends and a
constant-argument counterexample, not general security precision/recall.

Ollama Qwen3.5 is now the default primary for all technical/product levels and
policy judgments, using the same JSON/evidence validation. `--backend api` and
`--backend claude-code` explicitly select remote generation; environment credentials
never select a remote backend automatically. There is no remote fallback on local
failure. `local_model` configures Ollama; model flags override its model name.
Actual weight digest and generation settings identify caches. Explicit remote
backends retain optional conservative local routing for trivial JS/TS functions;
critical modules and upper levels use that selected primary. Public/nontrivial selection preserves omitted
private trivial source in file dossiers. Relocating an unchanged symbol rebinds
cached evidence IDs while preserving historical coordinates; recognizable absolute
line references in cached prose conservatively force regeneration. Prompt v7
explicitly distinguishes incoming consumers from outgoing dependencies and literal
arithmetic from unsupported business labels.

Model calls use short, schema-constrained evidence aliases that expand back to
immutable IDs before validation/persistence. Child synthesis facts exclude nested
citation IDs; structured child claims retain their own evidence parents instead
of inheriting unrelated evidence from the whole child. This reduces repeated
identifier text while preserving lookup and source/document provenance.

Local model update: pinned TEI 1.9.4 with Qwen3-Embedding-4B (2560 dimensions),
CPU Qwen3-Reranker-0.6B via services/reranker, and Ollama 0.40.13 /
Qwen3.5-9B Q4_K_M. Context retrieval and technical/product analysis default to
120000 tokens, with explicit smaller budgets supported. Per-model native limits
remain separate. Default reindex collections are derived from the embedding
identity; old collections are preserved. Run reindex for other existing bases
after upgrading. Historical savings reports retain the previous budgets/models.
