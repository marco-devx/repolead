Sí. Yo no construiría un simple “RAG de código”. Construiría un **sistema de inteligencia del repositorio**, algo como **RepoLead**, cuya primera misión sea realizar el onboarding técnico completo antes de permitir que otros agentes implementen.

La idea sería:

```text
Repositorio
    ↓
Análisis determinístico completo
    ↓
Modelo estructural del código
    ↓
Análisis arquitectónico tipo Uncle Bob
    ↓
Memoria jerárquica persistente
    ↓
MCP de consulta
    ↓
Claude Code / Codex / SwarmForge
```

## La decisión arquitectónica más importante

No le pediría a Claude:

```text
Lee todo el repositorio y dime cómo funciona.
```

Eso genera exactamente el problema que viste en SwarmForge:

* Consumo enorme de tokens.
* Lecturas repetidas.
* Contextos que se compactan.
* Resultados diferentes entre sesiones.
* Agentes que vuelven a descubrir lo mismo.
* Resúmenes sin evidencia verificable.

En su lugar:

```text
Herramientas determinísticas descubren los hechos.
Claude actúa como Tech Lead e interpreta esos hechos.
La base de datos conserva ambos.
```

El LLM no debería descubrir por sí mismo dónde está definida una clase, quién la consume, qué depende de ella o cuántas referencias tiene. Todo eso debe venir de analizadores de código.

# Arquitectura propuesta

```text
┌───────────────────────────────────────────────┐
│               RepoLead CLI                    │
│ scan · refresh · analyze · query · doctor     │
└──────────────────────┬────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────┐
│       1. Deterministic Intelligence Layer     │
│                                               │
│ Git · Tree-sitter · SCIP · Joern · tests      │
│ linters · complexity · duplication · coverage │
└──────────────────────┬────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────┐
│          2. Normalized Code Graph             │
│                                               │
│ files · symbols · imports · calls · dataflows │
│ modules · tests · ownership · dependencies    │
└──────────────────────┬────────────────────────┘
                       │
              ┌────────┴─────────┐
              ▼                  ▼
┌──────────────────────┐  ┌─────────────────────┐
│ SQLite + FTS5        │  │ Qdrant              │
│ source of truth      │  │ semantic index      │
│ graph + findings     │  │ embeddings          │
└──────────┬───────────┘  └──────────┬──────────┘
           └─────────────┬───────────┘
                         ▼
┌───────────────────────────────────────────────┐
│        3. Tech Lead Analysis Engine           │
│                                               │
│ Evidence packs → Claude → structured findings │
│ Local Qwen → embeddings, reranking, summaries │
└──────────────────────┬────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────┐
│               RepoLead MCP                    │
│                                               │
│ overview · architecture · impact · findings   │
│ symbols · dependencies · tests · opportunities│
└──────────────────────┬────────────────────────┘
                       │
           ┌───────────┼────────────┐
           ▼           ▼            ▼
      Claude Code    Codex      SwarmForge
```

# 1. Primera capa: hechos determinísticos

Esta es la base del sistema. Antes de usar IA, extraería información precisa del repositorio.

## Tree-sitter para estructura sintáctica

Tree-sitter permite construir árboles sintácticos concretos y actualizarlos incrementalmente cuando cambia el código. Lo utilizaría para identificar:

* Clases.
* Funciones.
* Métodos.
* Interfaces.
* Imports.
* Exports.
* Decoradores.
* Rutas HTTP.
* Handlers.
* Consultas SQL.
* Bloques de error.
* Comentarios y documentación.
* Límites exactos de cada símbolo.

No dividiría código cada 500 tokens. Los chunks serían unidades reales del lenguaje:

```text
class PaymentService
function processPayment
interface PaymentRepository
route POST /payments
```

Eso evita cortar una función por la mitad y mejora mucho tanto los embeddings como los análisis posteriores. ([GitHub][1])

## SCIP para navegación semántica

Tree-sitter entiende sintaxis, pero no siempre puede resolver correctamente:

```text
¿A qué UserService se refiere este import?
¿Quién implementa esta interfaz?
¿Dónde se usa este método?
```

Para eso usaría SCIP. SCIP es un formato independiente del lenguaje que representa definiciones, referencias e implementaciones, precisamente para navegación como “go to definition” y “find references”. ([GitHub][2])

Así construirías relaciones como:

```text
PaymentController.create
    CALLS → PaymentService.process
    REFERENCES → CreatePaymentRequest
    RETURNS → PaymentResponse
```

SCIP debería ser la fuente principal para referencias cuando exista un indexador confiable para el lenguaje. Tree-sitter serviría como fallback y para extraer estructuras adicionales.

## Joern para análisis profundo

Para proyectos compatibles añadiría Joern como analizador avanzado.

Joern genera un **Code Property Graph**, combinando representaciones como:

* AST.
* Control flow.
* Data flow.
* Llamadas.
* Métodos.
* Expresiones.
* Relaciones entre nodos.

Esto permite responder preguntas más profundas:

```text
¿Desde qué endpoint puede llegar input externo a esta consulta?
¿Dónde atraviesan datos de usuario una frontera?
¿Existe un camino entre este controller y este side effect?
¿Dónde se mezclan reglas de negocio con infraestructura?
```

Joern está enfocado en análisis estático y descubrimiento de patrones sobre grandes bases de código, y soporta varios de los lenguajes que utilizas, incluyendo JavaScript, Python, Java y Kotlin. ([Joern Documentation][3])

No lo usaría como única representación porque su soporte y precisión varían por lenguaje. Lo usaría como una fuente adicional de relaciones.

# 2. Modelo normalizado del repositorio

Todos los analizadores deben producir un formato interno común.

Por ejemplo:

```text
Repository
├── Snapshot
├── Package
├── Module
├── File
├── Symbol
│   ├── class
│   ├── method
│   ├── function
│   ├── interface
│   └── endpoint
├── Test
├── Finding
├── Summary
└── Opportunity
```

Y relaciones:

```text
CONTAINS
IMPORTS
CALLS
IMPLEMENTS
EXTENDS
READS_FROM
WRITES_TO
EMITS
CONSUMES
TESTED_BY
DEPENDS_ON
VIOLATES
SUPERSEDES
DOCUMENTED_BY
```

## Identidades estables

Cada elemento necesita un identificador estable:

```text
repo://payments-api/src/payment/service.ts
symbol://payments-api/src/payment/service.ts#PaymentService.process
```

Y también:

```text
content_hash
commit_sha
start_line
end_line
language
signature
```

Nunca identificaría un símbolo solamente por número de línea, porque las líneas cambian.

Un ID podría construirse aproximadamente con:

```text
repository + path + symbol kind + qualified name + signature
```

# 3. Persistencia: SQLite más Qdrant

No escogería entre SQLite **o** vectores. Usaría ambos para cosas diferentes.

## SQLite como fuente de verdad

SQLite guardaría:

```text
repositories
snapshots
files
symbols
edges
metrics
tests
coverage
findings
summaries
opportunities
analysis_runs
evidence
```

También usaría FTS5 para búsquedas exactas y BM25:

```text
AuditLogService
ENO-1261
idempotency
refresh token
Kafka consumer
```

FTS5 proporciona búsqueda full-text y ranking BM25 sin necesitar infraestructura externa. ([SQLite][4])

Ejemplo de tablas:

```sql
CREATE TABLE symbols (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    path TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    signature TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL
);

CREATE TABLE edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    analyzer TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id, edge_type, analyzer)
);
```

## Qdrant como índice semántico

Qdrant almacenaría vectores de:

* Símbolos.
* Resúmenes.
* Módulos.
* Decisiones.
* Findings.
* Oportunidades.
* Documentación.
* Tests.

No sería la fuente de verdad. Si Qdrant se pierde, se reconstruye desde SQLite.

Qdrant permite búsqueda vectorial con filtros estructurados, índices HNSW y consultas híbridas. Eso te sirve para filtrar por repositorio, snapshot, lenguaje, módulo, tipo de símbolo o vigencia antes de calcular similitud. ([Qdrant][5])

Para un prototipo de un solo repositorio también podrías utilizar `sqlite-vec`. Sin embargo, actualmente sigue siendo pre-v1 y su búsqueda principal es exhaustiva; su propio proyecto advierte problemas de escala cuando el volumen crece mucho. Para una herramienta que aspira a múltiples repositorios, elegiría Qdrant. ([GitHub][6])

# 4. Qué haría Qwen y qué no haría

Esto es muy importante:

> **Un modelo de embeddings no analiza arquitectura.**

Qwen Embedding solo convierte contenido en vectores útiles para encontrar contenido semánticamente relacionado.

Por ejemplo:

```text
Consulta:
“¿Cómo evitamos procesar eventos dos veces?”

Memoria:
“The consumer persists an idempotency key before side effects.”
```

Los embeddings pueden relacionar ambos textos aunque no compartan exactamente las mismas palabras.

La familia Qwen3 Embedding está diseñada para recuperación multilingüe, cross-language y recuperación de código. Eso encaja bien porque tú consultas en español, mientras que el código y las decisiones normalmente están en inglés. ([Hugging Face][7])

Usaría:

```text
Qwen3-Embedding-0.6B
Qwen3-Reranker-0.6B
```

como primera configuración. No empezaría con modelos de 8B.

Para servir embeddings en tu GPU utilizaría **Hugging Face Text Embeddings Inference**, TEI. Tiene soporte para ejecución local en GPU y la documentación incluye directamente Qwen3-Embedding-0.6B como ejemplo. ([GitHub][8])

El flujo sería:

```text
consulta
   ↓
Qwen embedding
   ↓
FTS5 + vector search + graph search
   ↓
20 candidatos
   ↓
Qwen reranker
   ↓
5–8 evidencias finales
```

## Qwen local para resúmenes

Opcionalmente usaría un modelo coder local para generar el primer resumen de símbolos simples:

```text
Getter sencillo
DTO
Adapter pequeño
Mapper
Configuración
Test helper
```

Pero los módulos críticos deberían ser sintetizados por Claude:

```text
dominio
pagos
autenticación
concurrencia
mensajería
persistencia
integraciones externas
```

# 5. Análisis jerárquico: cómo no perder contexto

No generaría solamente “un resumen del repositorio”. Crearía varios niveles.

```text
Símbolo
   ↓
Archivo
   ↓
Módulo
   ↓
Feature o bounded context
   ↓
Servicio
   ↓
Repositorio
```

## Symbol Card

Por cada función, clase o interfaz:

```json
{
  "symbol": "PaymentService.process",
  "purpose": "Coordinates payment authorization and persistence",
  "inputs": ["CreatePaymentCommand"],
  "outputs": ["Payment"],
  "sideEffects": [
    "calls payment gateway",
    "writes payment repository",
    "publishes PaymentCreated"
  ],
  "dependencies": [
    "PaymentRepository",
    "PaymentGateway",
    "EventPublisher"
  ],
  "invariants": [
    "a confirmed payment must have a gateway transaction id"
  ],
  "errorBehavior": [
    "gateway failures are mapped to PaymentAuthorizationError"
  ],
  "tests": [
    "PaymentService.spec.ts"
  ],
  "evidence": [
    "src/payment/service.ts:24-87"
  ]
}
```

## File Dossier

Por archivo:

```text
Responsabilidad principal
Símbolos públicos
Dependencias
Consumidores
Side effects
Reglas de negocio
Errores
Tests relacionados
Métricas
Findings
```

## Module Dossier

Por módulo:

```text
Propósito
API pública
Dependencias entrantes
Dependencias salientes
Modelo de dominio
Flujos principales
Fronteras técnicas
Riesgos
Test strategy
Oportunidades
```

## Repository Brief

El resumen principal contendría:

```text
Objetivo del sistema
Arquitectura detectada
Entry points
Bounded contexts
Flujos críticos
Persistencia
Mensajería
Integraciones
Autenticación/autorización
Testing
Deployment
Observabilidad
Hotspots
Deuda técnica
Convenciones
```

La ventaja de esta estructura es que, cuando cambia una función, no vuelves a analizar todo:

```text
cambió función
    ↓
regenerar Symbol Card
    ↓
actualizar File Dossier
    ↓
actualizar Module Dossier
    ↓
actualizar Repository Brief solo si fue afectado
```

# 6. Claude como Tech Lead, no como crawler

Para construir el analizador usaría el **Claude Agent SDK**, no dependería únicamente de una sesión interactiva de Claude Code.

El Agent SDK proporciona programáticamente el mismo agent loop, herramientas y gestión de contexto de Claude Code, desde Python o TypeScript. Eso permite controlar exactamente qué evidencia recibe el agente y exigir respuestas estructuradas. ([Claude Platform Docs][9])

Claude recibiría algo parecido a:

```text
Analyze module payments.

Evidence pack:
- module structure
- public symbols
- incoming dependencies
- outgoing dependencies
- call graph
- side effects
- metrics
- tests and coverage
- duplication candidates
- static-analysis findings
- existing module summaries

Do not scan unrelated files.
Every conclusion must reference evidence IDs.
Return the required JSON schema.
```

Esto es muy diferente de:

```text
Explora libremente el repo y dime qué encuentras.
```

## Resultado estructurado

Claude tendría que devolver:

```json
{
  "responsibility": "...",
  "architecture": {
    "style": "...",
    "boundaries": [],
    "dependencyDirection": []
  },
  "strengths": [],
  "risks": [],
  "findings": [
    {
      "ruleId": "ARCH-DEPENDENCY-001",
      "severity": "high",
      "confidence": 0.93,
      "claim": "Domain module depends directly on Prisma",
      "evidenceIds": ["edge-182", "symbol-443"],
      "recommendation": "Introduce a repository port owned by the domain"
    }
  ]
}
```

Un finding sin evidencia no se guarda como hallazgo confirmado.

# 7. El “Uncle Bob Policy Pack”

No intentaría copiar una personalidad. Convertiría las ideas arquitectónicas en reglas versionadas.

El prompt del arquitecto de SwarmForge revisa explícitamente:

* Límites de módulos.
* Dirección de dependencias.
* Cohesión y acoplamiento.
* Information hiding.
* Encapsulación.
* Separación UI/core.
* Testabilidad.
* Calidad local.
* DRY.
* Mutation testing.

También contiene una regla especialmente importante para tu preocupación: el arquitecto debe decidir cuándo se necesita un cambio de diseño y cuándo basta con una modificación local sencilla. ([GitHub][10])

Lo modelaría así:

```text
policies/
├── architecture/
│   ├── dependency-rule.yaml
│   ├── boundaries.yaml
│   ├── ui-core-separation.yaml
│   └── information-hiding.yaml
├── design/
│   ├── cohesion.yaml
│   ├── coupling.yaml
│   ├── abstractions.yaml
│   └── side-effects.yaml
├── code-quality/
│   ├── naming.yaml
│   ├── duplication.yaml
│   ├── complexity.yaml
│   └── error-handling.yaml
└── testing/
    ├── testability.yaml
    ├── coverage.yaml
    ├── mutation.yaml
    └── acceptance-boundaries.yaml
```

Ejemplo:

```yaml
id: ARCH-DEPENDENCY-001
name: Dependency Rule
description: High-level policy must not depend on low-level infrastructure.
severity: high

candidate_detectors:
  - graph_dependency_direction
  - framework_type_leak
  - persistence_import_in_domain

required_evidence:
  - source_symbol
  - target_symbol
  - dependency_path

llm_judgment:
  question: >
    Is this dependency an actual architectural boundary violation,
    or a harmless implementation detail?
```

Primero un detector determinístico genera candidatos. Luego Claude decide cuáles son violaciones reales.

Esto reduce falsos positivos y tokens.

# 8. Métricas y analizadores de calidad

El onboarding debería ejecutar herramientas existentes y normalizar sus resultados.

## Duplicación

Usaría `jscpd` para encontrar bloques duplicados. Actualmente soporta una gran cantidad de lenguajes y puede producir reportes orientados a agentes con una salida reducida. ([jscpd][11])

## Complejidad

Cada adaptador de lenguaje debe obtener:

```text
cyclomatic complexity
cognitive complexity
lines of code
fan-in
fan-out
afferent coupling
efferent coupling
instability
test coverage
change frequency
```

Para Python, Radon puede producir complejidad ciclomática, Halstead y Maintainability Index de forma programática o mediante JSON. ([Radon][12])

## Mutation testing

No ejecutaría mutation testing sobre todo el repositorio durante cada escaneo. Sería demasiado costoso.

Primero identificaría hotspots:

```text
alta complejidad
+ baja cobertura
+ alto fan-in
+ alta frecuencia de cambios
+ lógica de negocio
```

Y solo entonces ejecutaría mutation testing. Stryker, por ejemplo, introduce mutaciones y verifica si los tests son capaces de detectarlas; soporta JavaScript y TypeScript, entre otros ecosistemas. ([Stryker Mutator][13])

Esto se acerca al rigor de SwarmForge sin mutar cada archivo irrelevante.

# 9. Git como dimensión temporal

El análisis no debe observar únicamente el estado actual.

Extraería:

```text
último autor
cantidad de commits
frecuencia de cambios
archivos que cambian juntos
bugs asociados
edad del código
ownership aproximado
```

Esto permite encontrar hotspots reales:

```text
Complejidad alta, pero nunca cambia
→ menor prioridad

Complejidad media, cambia cada semana y rompe producción
→ alta prioridad
```

También sirve para detectar módulos acoplados temporalmente:

```text
src/order/service.ts
src/invoice/mapper.ts

cambian juntos en 82% de los commits
pero no existe dependencia declarada
```

Eso puede indicar una frontera incorrecta o una abstracción faltante.

# 10. MCP para Claude Code y Codex

El sistema expondría tanto **resources** como **tools** MCP. MCP permite entregar contexto legible y funciones invocables a los agentes. ([Model Context Protocol][14])

Claude Code puede conectarse a servidores MCP, y Codex CLI e IDE también soportan servidores MCP locales o remotos. ([Claude Platform Docs][15])

## Herramientas MCP propuestas

### `repo_overview`

```json
{
  "repository": "payments-api",
  "snapshot": "HEAD"
}
```

Devuelve la visión técnica general.

### `module_context`

```json
{
  "module": "payments",
  "depth": "detailed"
}
```

Devuelve límites, responsabilidades, dependencias, tests y findings.

### `symbol_context`

```json
{
  "symbol": "PaymentService.process"
}
```

Devuelve la Symbol Card y sus relaciones.

### `find_callers`

```json
{
  "symbol": "PaymentRepository.save",
  "transitiveDepth": 3
}
```

### `trace_flow`

```json
{
  "from": "POST /payments",
  "to": "PaymentRepository.save"
}
```

### `impact_analysis`

```json
{
  "change": "Add retry behavior to PaymentGateway"
}
```

Devuelve:

```text
archivos probablemente afectados
símbolos afectados
contratos públicos
tests relevantes
side effects
riesgos
agentes recomendados
```

### `architecture_findings`

```json
{
  "severity": ["high", "critical"],
  "module": "payments"
}
```

### `improvement_opportunities`

```json
{
  "module": "payments",
  "maximum": 10
}
```

### `get_evidence`

Permite inspeccionar el código exacto que respalda una conclusión.

# 11. Cómo controlaría los tokens

Esta parte debe ser una característica del producto, no una recomendación informal.

## Regla 1: nunca enviar archivos completos innecesariamente

```text
LLM recibe:
símbolos relevantes + relaciones + métricas + extractos

LLM no recibe:
todo el repositorio
```

## Regla 2: caché por contenido

```text
cache key =
content_hash
+ analysis_policy_version
+ prompt_version
+ model
```

Si el contenido no cambió, no se vuelve a analizar.

## Regla 3: resumen jerárquico

Claude analiza módulos, no miles de archivos individualmente en una sola conversación.

## Regla 4: modelos por nivel

```text
Embeddings             → Qwen local
Reranking              → Qwen local
Leaf summaries simples → Qwen local opcional
Módulos importantes    → Claude
Arquitectura global    → Claude
Implementación futura  → Claude/Codex/SwarmForge
```

## Regla 5: presupuestos explícitos

Cada análisis tendría límites:

```yaml
analysis_budget:
  max_symbols_per_pack: 50
  max_source_lines_per_pack: 1200
  max_findings_per_module: 20
  max_evidence_per_finding: 8
  max_reanalysis_depth: 3
```

## Regla 6: incremental por Git diff

```text
git diff previous_snapshot..HEAD
        ↓
símbolos modificados
        ↓
dependientes directos
        ↓
módulos afectados
        ↓
solo esos resúmenes se invalidan
```

# 12. Analizador de impacto futuro

Aunque no sería lo primero que implementaría, el knowledge graph permitiría decidir qué workflow usar.

El impacto se calcularía con factores objetivos:

```text
Número de símbolos afectados
Dependientes transitivos
Cambio en API pública
Cambio de esquema
Cambio de contrato
Autenticación/autorización
Concurrencia
Side effects externos
Persistencia
Cobertura existente
Reversibilidad
Cantidad de módulos
```

Ejemplo:

```text
Impact score: 8/100
Cambio localizado, sin API pública
→ coder + reviewer

Impact score: 34/100
Afecta un módulo y varios tests
→ coder + cleaner + architect

Impact score: 72/100
Contrato público, DB y mensajería
→ spec + full SwarmForge
```

Así evitas que SwarmForge ejecute seis agentes y mutation testing para cambiar un label.

# Stack exacto que escogería

```text
Orquestador y MCP:
TypeScript + Node.js
Claude Agent SDK
Official MCP TypeScript SDK

Parsing:
Tree-sitter

Code intelligence:
SCIP indexers por lenguaje

Deep static analysis:
Joern como adapter opcional

Persistencia:
SQLite
FTS5
Qdrant local

Embeddings:
Qwen3-Embedding-0.6B
Hugging Face TEI

Reranking:
Qwen3-Reranker-0.6B
servicio Python local

Quality adapters:
jscpd
ESLint / TypeScript compiler
Ruff / Pyright / Radon
clj-kondo
RuboCop
Stryker / mutmut
coverage tools por lenguaje

Runtime:
Docker Compose
```

## Estructura del proyecto

```text
repolead/
├── apps/
│   ├── cli/
│   └── mcp-server/
├── packages/
│   ├── domain/
│   ├── knowledge-store/
│   ├── code-graph/
│   ├── retrieval/
│   ├── lead-analyzer/
│   └── policy-engine/
├── adapters/
│   ├── tree-sitter/
│   ├── scip/
│   ├── joern/
│   ├── git/
│   ├── typescript/
│   ├── python/
│   ├── clojure/
│   └── ruby/
├── policies/
│   ├── architecture/
│   ├── testing/
│   └── quality/
├── services/
│   ├── embeddings/
│   └── reranker/
└── docker-compose.yml
```

# Primer producto que construiría

La primera versión no debería intentar implementar agentes, specs ni code review automático. Solamente:

```text
repolead scan .
```

Y producir:

```text
✓ Repository fingerprinted
✓ 1,842 files indexed
✓ 12,411 symbols extracted
✓ 38,210 references resolved
✓ 14 modules identified
✓ 267 tests linked
✓ 53 architecture candidates found
✓ 18 findings confirmed
✓ 14 module dossiers generated
✓ Repository brief generated
✓ MCP server ready
```

Después:

```text
repolead serve
```

Y Claude podría preguntar:

```text
Use RepoLead to explain the audit-log architecture.
Do not scan the entire repository manually.
```

O:

```text
Before implementing this ticket, use RepoLead impact_analysis
and retrieve the affected modules, symbols, tests and architectural rules.
```

# Mi conclusión

La herramienta correcta no sería un “Uncle Bob chatbot”. Sería:

```text
analizadores determinísticos
+ grafo de código
+ historia Git
+ métricas
+ resúmenes jerárquicos
+ policy pack arquitectónico
+ Claude como juez técnico
+ Qwen local para retrieval
+ MCP para reutilizar el conocimiento
```

El punto decisivo es conservar tres capas separadas:

```text
Hechos
→ obtenidos por herramientas

Interpretaciones
→ producidas por el Tech Lead agent

Evidencias
→ archivos, líneas, símbolos y commits
```

Con eso, Claude Code, Codex o SwarmForge ya no tendrían que “conocer todo el proyecto”. Solo consultarían a RepoLead y recibirían un paquete pequeño, actualizado y verificable del área que necesitan modificar. Eso reduce tokens, evita pérdida de contexto y permite que el futuro orquestador decida proporcionalmente si una tarea requiere uno, dos, cuatro o seis agentes.

[1]: https://github.com/tree-sitter/tree-sitter/blob/master/README.md?utm_source=chatgpt.com "tree-sitter/README.md at master"
[2]: https://github.com/sourcegraph/scip "GitHub - scip-code/scip: SCIP Code Intelligence Protocol · GitHub"
[3]: https://docs.joern.io/code-property-graph/?utm_source=chatgpt.com "Code Property Graph"
[4]: https://www.sqlite.org/fts5.html?utm_source=chatgpt.com "SQLite FTS5 Extension"
[5]: https://qdrant.tech/documentation/quickstart/?utm_source=chatgpt.com "Local Quickstart"
[6]: https://github.com/asg017/sqlite-vec?utm_source=chatgpt.com "asg017/sqlite-vec: A vector search ..."
[7]: https://huggingface.co/Qwen/Qwen3-Embedding-8B?utm_source=chatgpt.com "Qwen/Qwen3-Embedding-8B"
[8]: https://github.com/huggingface/text-embeddings-inference?utm_source=chatgpt.com "Text Embeddings Inference"
[9]: https://docs.anthropic.com/en/docs/claude-code/sdk?utm_source=chatgpt.com "Agent SDK overview - Claude Code Docs"
[10]: https://github.com/unclebob/swarm-forge/blob/four-pack/swarmforge/roles/architect.prompt "swarm-forge/swarmforge/roles/architect.prompt at four-pack · unclebob/swarm-forge · GitHub"
[11]: https://jscpd.dev/?utm_source=chatgpt.com "jscpd - Copy/Paste Detector for Source Code - jscpd"
[12]: https://radon.readthedocs.io/en/latest/?utm_source=chatgpt.com "Welcome to Radon's documentation!"
[13]: https://stryker-mutator.io/?utm_source=chatgpt.com "Stryker Mutator"
[14]: https://modelcontextprotocol.io/specification/2026-07-28/server/resources?utm_source=chatgpt.com "Resources"
[15]: https://docs.anthropic.com/en/docs/claude-code/mcp?utm_source=chatgpt.com "Connect Claude Code to tools via MCP"
