# RepoLead — Plan de implementación

Este plan convierte la visión de [project.md](./project.md) en fases ejecutables. El principio rector: **cada fase termina con algo usable**, no con infraestructura huérfana. El orden respeta las dependencias reales — no se puede hacer retrieval sin grafo, ni análisis LLM sin evidencia determinística.

## Decisiones de alcance para la v1

| Decisión | Elección v1 | Se difiere |
|---|---|---|
| Runtime y package manager | **Bun** (workspaces, runtime TS nativo) | — |
| Build de apps | **Rsbuild** (target node) | — |
| Tests | **Rstest** (`@rstest/core`) | — |
| Lint + typecheck | **Rslint** (`@rslint/core`, `--type-check` reemplaza `tsc --noEmit`) — sin ESLint, Prettier ni Biome | — |
| Lenguaje objetivo inicial | TypeScript/JavaScript | Python (fase 8), Clojure, Ruby |
| Referencias semánticas | SCIP (`scip-typescript`) | Joern (adapter opcional, fase 9) |
| Vectores | Qdrant local vía Docker | — |
| Embeddings | Qwen3-Embedding-0.6B vía TEI | Modelos 8B |
| Resúmenes leaf | Claude para todo | Qwen coder local para símbolos triviales |
| Mutation testing | No en v1 | Fase 9 (solo hotspots) |
| Impact analysis / scoring | No en v1 | Fase 9 |
| Multi-repo | Esquema preparado (`repository_id` en todo), CLI mono-repo | Orquestación multi-repo |

Racional: el primer producto es `repolead scan .` + `repolead serve` (MCP). Todo lo que no contribuye a ese camino se difiere.

---

## Fase 0 — Bootstrap del monorepo

**Objetivo:** esqueleto compilable con CI.

- Monorepo con **Bun workspaces** + TypeScript (strict), estructura del doc:
  ```text
  apps/cli, apps/mcp-server
  packages/domain, knowledge-store, code-graph, retrieval, lead-analyzer, policy-engine
  adapters/tree-sitter, adapters/scip, adapters/git, adapters/typescript
  policies/, services/embeddings, services/reranker
  ```
- Tooling (stack Rstack + Bun, sin ESLint/Prettier/Biome):
  - **Rsbuild** para el build de `apps/cli` y `apps/mcp-server`; los packages internos no compilan — Bun ejecuta TS directamente.
  - **Rstest** como test runner (config raíz `rstest.config.ts`).
  - **Rslint** como linter type-aware; `rslint --type-check-only` hace de typecheck (sustituye `tsc --noEmit`).
  - GitHub Actions con `oven-sh/setup-bun` (lint + typecheck + test + build).
- `docker-compose.yml` inicial: Qdrant + TEI (aunque no se usen hasta la fase 4).
- CLI con **commander**: comandos `scan`, `refresh`, `query`, `serve`, `doctor` registrados como stubs.
- `repolead doctor`: verifica binarios y servicios externos (git, scip-typescript, Qdrant, TEI) — se implementa de verdad aquí porque es trivial y útil desde el día uno.

**Criterio de salida:** `bun install && bun run check` (lint + typecheck + test + build) verde en CI; `repolead doctor` reporta el entorno.

## Fase 1 — Modelo de dominio + knowledge store (SQLite)

**Objetivo:** la fuente de verdad existe antes que cualquier analizador.

- `packages/domain`: tipos de entidades (`Repository`, `Snapshot`, `File`, `Symbol`, `Edge`, `Test`, `Finding`, `Summary`, `Opportunity`, `Evidence`, `AnalysisRun`) y los 14 tipos de relación (`CONTAINS`, `IMPORTS`, `CALLS`, …).
- **Identidades estables** como funciones puras del dominio:
  - `repo://<repo>/<path>` y `symbol://<repo>/<path>#<qualified>.<name>`
  - ID de símbolo = `hash(repository + path + kind + qualified_name + signature)` — nunca por línea.
  - `content_hash`, `commit_sha`, `start_line`, `end_line`, `language`, `signature` como metadatos.
- `packages/knowledge-store`: SQLite con **driver dual** detrás de una interfaz común mínima — `bun:sqlite` bajo Bun (better-sqlite3 no carga en Bun) y **better-sqlite3** bajo Node, donde corren los workers de Rstest (`bun:sqlite` no existe ahí y el `node:sqlite` de Node 22 no trae FTS5). Migraciones versionadas, tablas del doc (`repositories`, `snapshots`, `files`, `symbols`, `edges`, `metrics`, `tests`, `coverage`, `findings`, `summaries`, `opportunities`, `analysis_runs`, `evidence`).
- **FTS5** sobre símbolos, resúmenes y findings (BM25) desde esta fase — es gratis y desbloquea `repolead query` textual temprano.
- `edges` con `confidence`, `analyzer` y `evidence_json` desde el día uno (clave primaria compuesta como en el doc): permite que Tree-sitter y SCIP coexistan sin pisarse.

**Criterio de salida:** tests de round-trip (insertar snapshot completo, consultar por FTS5, reconstruir grafo en memoria).

## Fase 2 — Capa determinística: Git + Tree-sitter → `repolead scan` (mínimo)

**Objetivo:** primer `scan` real que llena SQLite.

- `adapters/git`: enumeración de archivos versionados, `commit_sha`, detección de lenguaje, y la **dimensión temporal**: último autor, frecuencia de cambios, co-cambios (archivos que cambian juntos), edad. Se guarda en `metrics` — el análisis de hotspots la consumirá después.
- `adapters/tree-sitter` con **`web-tree-sitter` (WASM) + gramáticas de `@vscode/tree-sitter-wasm`** — un solo code path para Bun y Node, sin módulos nativos (`tree-sitter-wasms` quedó descartado: gramáticas compiladas con CLI 0.20, ABI incompatible). Extracción de clases, funciones, métodos, interfaces, imports/exports, rutas HTTP, límites exactos de cada símbolo. **Chunks = unidades del lenguaje**, nunca ventanas de N tokens.
- `adapters/typescript`: queries de Tree-sitter específicas del lenguaje + heurísticas (rutas Express/Nest, handlers, tests por convención `*.spec.ts`/`*.test.ts` → relación `TESTED_BY`).
- Detección de **módulos**: por directorio + `package.json`/barrels como primera heurística.
- Pipeline de `scan`: fingerprint del repo → snapshot → archivos → símbolos → edges sintácticos (`CONTAINS`, `IMPORTS`) → salida estilo checklist del doc (`✓ N files indexed`, `✓ N symbols extracted`, …).

**Criterio de salida:** correr `repolead scan` sobre un repo TypeScript real (p. ej. el propio RepoLead o un OSS mediano) y validar conteos manualmente.

## Fase 3 — SCIP: referencias resueltas

**Objetivo:** el grafo pasa de sintáctico a semántico.

- `adapters/scip`: invocar `scip-typescript`, parsear el índice SCIP (protobuf), mapear sus símbolos a nuestros IDs estables.
- Edges nuevos: `CALLS`, `IMPLEMENTS`, `EXTENDS`, referencias resueltas (¿a qué `UserService` apunta este import?).
- **Regla de precedencia**: SCIP es la fuente principal de referencias cuando existe; Tree-sitter es fallback. La columna `analyzer` + `confidence` resuelve conflictos.
- Reconciliación SCIP ↔ Tree-sitter: matching por path + rango + qualified name; los desacuerdos se registran (insumo para `doctor`).

**Criterio de salida:** para 20 símbolos elegidos a mano en un repo de prueba, "find references" desde SQLite coincide con lo que reporta el IDE.

## Fase 4 — Retrieval: Qdrant + Qwen + búsqueda híbrida

**Objetivo:** `repolead query` responde preguntas en lenguaje natural con evidencia.

- `services/embeddings`: TEI sirviendo **Qwen3-Embedding-0.6B** (ya en docker-compose desde fase 0); cliente TS con batching.
- `services/reranker`: **TEI** con la conversión seq-cls de **Qwen3-Reranker-0.6B** (`tomaarsen/Qwen3-Reranker-0.6B-seq-cls`, endpoint `/rerank`). El servicio Python propio queda diferido salvo que la conversión pierda calidad.
- `packages/retrieval`: pipeline del doc —
  ```text
  consulta → embedding → FTS5 + vector + graph → ~20 candidatos → reranker → 5–8 evidencias
  ```
- Colecciones Qdrant con payload filtrable: `repository`, `snapshot`, `language`, `module`, `symbol_kind`, vigencia. **Qdrant nunca es fuente de verdad**: comando `repolead reindex` lo reconstruye desde SQLite.
- Se vectoriza: símbolos (chunk = símbolo completo), y más adelante resúmenes/findings a medida que existan (fases 5–6).

**Criterio de salida:** consultas en español sobre código en inglés ("¿dónde se validan los pagos?") devuelven los símbolos correctos en el top-5 sobre el repo de prueba.

## Fase 5 — Tech Lead Engine: Claude + resúmenes jerárquicos

**Objetivo:** interpretación con evidencia, sin crawling.

- `packages/lead-analyzer` sobre el **Claude Agent SDK** (TypeScript).
- **Evidence packs**: ensamblados desde SQLite (estructura del módulo, símbolos públicos, dependencias entrantes/salientes, call graph, métricas, tests). Claude recibe el pack, no el repo. Prompt exige JSON con schema y referencias a `evidenceIds`; validación con zod + retry.
- Jerarquía de síntesis, en orden bottom-up:
  1. **Symbol Cards** (purpose, inputs/outputs, sideEffects, dependencies, invariants, errorBehavior, tests, evidence) — solo para símbolos públicos/no triviales en v1.
  2. **File Dossiers**
  3. **Module Dossiers**
  4. **Repository Brief**
- **Control de tokens como feature** (las 6 reglas del doc):
  - Caché por `content_hash + policy_version + prompt_version + model` en tabla `analysis_runs` — si nada cambió, cero llamadas.
  - Presupuestos en config (`analysis_budget`: max_symbols_per_pack: 50, max_source_lines_per_pack: 1200, …) aplicados por el ensamblador de packs, con truncado explícito y logging de lo descartado.
- `repolead analyze` orquesta esta fase; `scan` la invoca al final.

**Criterio de salida:** Repository Brief + Module Dossiers de un repo de prueba, con cada afirmación trazable a evidencia; segundo run sin cambios = 0 llamadas a Claude.

## Fase 6 — Policy engine: candidatos determinísticos + juicio LLM

**Objetivo:** findings arquitectónicos confirmados, no opiniones.

- `packages/policy-engine`: carga de policies YAML versionadas (`policies/architecture|design|code-quality|testing/`), con el formato del doc (`id`, `severity`, `candidate_detectors`, `required_evidence`, `llm_judgment`).
- **Detectores determinísticos** iniciales (queries sobre el grafo SQLite):
  - `graph_dependency_direction` (dominio → infraestructura)
  - `persistence_import_in_domain`
  - `framework_type_leak`
  - ciclos entre módulos, fan-in/fan-out extremos
- Flujo: detector → candidatos → Claude juzga con la pregunta de la policy → solo lo confirmado se persiste como `Finding` con `confidence` y `evidenceIds`. **Un finding sin evidencia no se guarda.**
- Policy pack inicial: 6–8 reglas del "Uncle Bob Policy Pack" (dependency rule, boundaries, cohesion, coupling, duplication, complexity, error-handling, testability).
- Métricas de calidad que alimentan detectores: **jscpd** (duplicación) y complejidad ciclomática/cognitiva por símbolo (via Tree-sitter) — se normalizan a la tabla `metrics` en esta fase.

**Criterio de salida:** sobre un repo con violaciones conocidas (se puede fabricar un fixture), el pipeline reporta los findings esperados y descarta los falsos positivos plantados.

## Fase 7 — MCP server: `repolead serve`

**Objetivo:** el conocimiento es consumible por Claude Code / Codex.

- `apps/mcp-server` con el **MCP TypeScript SDK oficial** (stdio primero; HTTP después si hace falta).
- Tools v1 (las de mayor valor/menor costo primero):
  1. `repo_overview` — Repository Brief
  2. `module_context` — Module Dossier + findings
  3. `symbol_context` — Symbol Card + relaciones
  4. `find_callers` — grafo, con `transitiveDepth`
  5. `architecture_findings` — filtrable por severidad/módulo
  6. `get_evidence` — código exacto que respalda una conclusión
  7. `search` — el pipeline de retrieval de la fase 4
- Diferidas a fase 9: `trace_flow`, `impact_analysis`, `improvement_opportunities`.
- Resources MCP para el Brief y los dossiers (contexto legible sin invocar tools).
- Documentar el registro en Claude Code (`claude mcp add`) y probar el flujo del doc: *"Use RepoLead to explain X. Do not scan the repository manually."*

**Criterio de salida:** desde una sesión de Claude Code conectada, responder una pregunta arquitectónica usando solo tools de RepoLead, con menos tokens que la exploración manual equivalente.

## Fase 8 — Incrementalidad: `repolead refresh`

**Objetivo:** el costo marginal de un cambio es proporcional al cambio.

- `git diff previous_snapshot..HEAD` → archivos modificados → símbolos afectados (por `content_hash`) → dependientes directos vía edges → módulos afectados.
- Invalidación en cascada exactamente como el doc: Symbol Card → File Dossier → Module Dossier → Brief solo si fue afectado.
- Re-index selectivo en Qdrant (delete + upsert por IDs afectados).
- Tree-sitter incremental si el ahorro lo justifica; si no, re-parse por archivo modificado (barato).

**Criterio de salida:** cambiar una función en el repo de prueba → `refresh` re-analiza solo su cadena de invalidación; tiempo y llamadas LLM medidos y reportados.

## Fase 9 — Extensiones (priorizar según uso real)

En orden sugerido:

1. **Python adapter** (Tree-sitter queries + `scip-python` + Ruff/Radon normalizados a `metrics`) — valida que la abstracción de adapters funciona.
2. **`impact_analysis` + scoring** — los factores objetivos del doc (símbolos afectados, dependientes transitivos, API pública, persistencia, cobertura…) → score → recomendación de workflow. Es lo que conecta con SwarmForge.
3. **`trace_flow`** — BFS sobre el grafo entre endpoint y side effect.
4. **Hotspots + mutation testing dirigido** — combinar complejidad × cobertura × fan-in × churn de la fase 2; Stryker solo sobre hotspots.
5. **Joern adapter** — data flow real para `trace_flow` profundo; opcional, detrás de `doctor`.
6. **Qwen coder local para leaf summaries** — solo si el costo de Claude en fase 5 lo justifica en repos grandes.
7. **`improvement_opportunities`** — deriva de findings + hotspots.

---

## Riesgos principales y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Mapeo SCIP ↔ IDs propios frágil (monikers, síntesis de nombres) | Fase 3 dedicada solo a esto, con suite de fixtures por patrón de código; `confidence` explícita en edges |
| Costo LLM en repos grandes al primer scan | Presupuestos duros desde fase 5 + jerarquía (Claude ve módulos, no archivos) + caché por hash; medir tokens por scan como métrica de producto |
| Detección de módulos por heurística falla en monolitos sin estructura | Permitir override en `.repolead.yaml` (mapa manual de módulos) |
| Drift entre SQLite y Qdrant | Qdrant siempre reconstruible (`reindex`); versión de snapshot en payload; nunca leer de Qdrant sin verificar vigencia |
| Falsos positivos del policy engine erosionan confianza | El juicio LLM es filtro obligatorio; findings llevan `confidence`; empezar con pocas reglas de alta precisión |
| Alcance: la tentación de construir las 3 capas a la vez | Cada fase tiene criterio de salida medible; no se abre una fase sin cerrar la anterior |

## Métricas de éxito de la v1

- `repolead scan` sobre un repo TS de ~1–2k archivos completa en < 10 min (sin contar LLM) y el checklist final coincide con la realidad.
- Segundo `scan` sin cambios: 0 llamadas LLM.
- Pregunta arquitectónica vía MCP: respuesta correcta con evidencia usando < 10% de los tokens de la exploración manual.
- `refresh` tras cambiar 1 archivo: < 30 s + solo los resúmenes afectados invalidados.

## Secuencia y esfuerzo estimado

```text
F0 Bootstrap          ▸ 1–2 días
F1 Domain + SQLite    ▸ 3–4 días
F2 Git + Tree-sitter  ▸ 1 semana      ← primer "scan" visible
F3 SCIP               ▸ 1 semana      ← el riesgo técnico grande, atacarlo temprano
F4 Retrieval          ▸ 4–5 días
F5 Tech Lead Engine   ▸ 1–1.5 semanas ← primer output "wow"
F6 Policy Engine      ▸ 1 semana
F7 MCP Server         ▸ 3–4 días      ← v1 completa: scan + serve
F8 Refresh            ▸ 4–5 días
F9 Extensiones        ▸ según demanda
```

Total hasta v1 (F0–F7): **~6–7 semanas** de trabajo enfocado. F8 es la primera post-v1 porque sin incrementalidad el producto no es usable a diario.
