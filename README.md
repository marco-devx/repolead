# RepoLead

Sistema de inteligencia del repositorio: analizadores determinísticos (Tree-sitter, SCIP, Git)
construyen un grafo de código en SQLite; Claude actúa como Tech Lead interpretando evidencia;
el conocimiento se expone vía MCP a Claude Code, Codex y otros agentes.

- Visión completa: [docs/project.md](docs/project.md)
- Plan de implementación por fases: [docs/plan.md](docs/plan.md)

## Toolchain

> Este repo usa **Bun** — no npm, pnpm ni yarn.

| Herramienta | Rol |
|---|---|
| [Bun](https://bun.sh) | Runtime, package manager y workspaces |
| [Rsbuild](https://rsbuild.rs) | Build de las apps (`apps/cli`, `apps/mcp-server`) |
| [Rstest](https://rstest.rs) | Test runner |
| [Rslint](https://rslint.rs) | Lint type-aware + typecheck (`--type-check-only` sustituye a `tsc --noEmit`) |

Sin ESLint, Prettier ni Biome.

## Requisitos

- Bun >= 1.3
- git
- Docker (para Qdrant y TEI, desde la Fase 4)

## Comandos

```bash
bun install            # instala todo el monorepo
bun run doctor         # verifica binarios y servicios del entorno
bun run dev            # ejecuta el CLI desde el código fuente
bun run test           # tests (rstest)
bun run lint           # lint (rslint)
bun run typecheck      # typecheck (rslint --type-check-only)
bun run build          # build del CLI (rsbuild)
bun run check          # lint + typecheck + test + build

docker compose up -d   # Qdrant + TEI (embeddings)
```

## Conectar a Claude Code (MCP)

```bash
claude mcp add repolead -- bun /ruta/a/repolead/apps/cli/src/index.ts serve --db /ruta/al/repo/.repolead/repolead.db
```

Y en la sesión: *"Use RepoLead to explain the audit-log architecture. Do not scan the repository manually."*
Tools: `repo_overview` · `module_context` · `symbol_context` · `find_callers` · `architecture_findings` · `get_evidence` · `search`.

## Estructura

```text
apps/cli            CLI: scan · refresh · query · serve · doctor
apps/mcp-server     Servidor MCP (Fase 7)
packages/           domain · knowledge-store · code-graph · retrieval · lead-analyzer · policy-engine
adapters/           tree-sitter · scip · git · typescript
policies/           Policy pack arquitectónico (YAML versionado)
services/           embeddings (TEI) · reranker (Python)
```
