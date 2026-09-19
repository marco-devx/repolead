# Budgeted context and token measurements

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

CodeGraphContext and ast-grep have not been integrated in this change. Adding
language adapters or a structural-rule engine is separate from context savings.

## Analysis and correctness

The old default of 50 symbols / 200 internal edges is replaced by a configurable
4000-token evidence budget. Optional symbol/edge caps remain available through
the library API. Both module evidence and the final repository synthesis are
bounded. Prompt instructions, output schemas and model output are additional
tokens; `--context-tokens` is not a total provider bill limit.

The most specific module owns each file. Parent modules no longer repeat all
child symbols. Truncation counts include relations lost when their symbols are
omitted, files, tests and dependencies. A quarter of the module evidence budget
is reserved for non-symbol information. The final synthesis distributes space
across modules before adding larger dossier sections.

Analysis caches include content fingerprints, prompt version and model name.
A model name that aliases mutable weights is still not a pinned model revision.
Unchanged evidence produces no new analysis calls; source changes invalidate
the appropriate module cache. Repository synthesis can remain cached if the
resulting module dossiers are unchanged.

Source reads reject outside paths, outside symlinks, unindexed files and files
whose hashes differ from the indexed snapshot. `get_evidence` returns up to 200
lines / 2000 proxy tokens per source range and indicates where to continue.
`--no-source` also applies to `context_pack`. Existing stored finding excerpts
remain available in product mode.

Long-lived stdio MCP connections observe new snapshots without restarting.
This does not create automatic indexing: run `refresh` when source changes.

## Reproduce the benchmark

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
