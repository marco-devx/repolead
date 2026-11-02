# RepoLead: guía técnica de básico a avanzado

Esta guía explica cómo usar RepoLead en un repositorio nuevo, qué ejecuta cada comando y cómo se conectan sus componentes. Describe la implementación del código que acompaña este documento, no funcionalidades planeadas. Los valores predeterminados mencionados son los configurados en el proyecto, no una garantía de disponibilidad de servicios externos.

## Ruta de lectura

- **Nivel inicial:** secciones 1–3, para comprender el producto y comenzar.
- **Nivel práctico:** secciones 4–6, para elegir comandos, conectar un agente y controlar el contexto.
- **Nivel avanzado:** secciones 7–10, para entender arquitectura, datos, límites y extensión del sistema.

Índice:

1. [Qué problema resuelve](#1-qué-problema-resuelve)
2. [Preparación y primer repositorio](#2-preparación-y-primer-repositorio)
3. [Flujo de trabajo cotidiano](#3-flujo-de-trabajo-cotidiano)
4. [Referencia técnica de todos los comandos](#4-referencia-técnica-de-todos-los-comandos)
5. [MCP y conexión con agentes](#5-mcp-y-conexión-con-agentes)
6. [Presupuestos de tokens y medición](#6-presupuestos-de-tokens-y-medición)
7. [Arquitectura interna](#7-arquitectura-interna)
8. [Datos, identidad e invalidación](#8-datos-identidad-e-invalidación)
9. [Operación, seguridad y diagnóstico](#9-operación-seguridad-y-diagnóstico)
10. [Cómo extender la solución](#10-cómo-extender-la-solución)

## 1. Qué problema resuelve

Un agente de programación suele explorar un proyecto leyendo archivos y buscando nombres. En otra sesión puede repetir esa exploración y consumir contexto de nuevo. Además, una explicación generada puede perder la conexión con las líneas que la respaldaban.

RepoLead prepara una base de conocimiento reutilizable del repositorio. Primero extrae hechos con herramientas de análisis de código; después, opcionalmente, pide a un modelo generativo que interprete esos hechos. Finalmente permite consultarlos desde una terminal o un agente conectado por MCP.

Una forma sencilla de imaginarlo:

- El **índice** es un catálogo de archivos, funciones, clases y relaciones.
- Los **resúmenes** son fichas técnicas generadas a partir de ese catálogo.
- La **evidencia** permite volver al archivo y a las líneas concretas.
- El **MCP** es la interfaz con la que Codex u otro cliente consulta todo lo anterior.

RepoLead no modifica automáticamente el código de tu aplicación, no ejecuta sus pruebas para validar cada conclusión y no reemplaza la lectura de código cuando una tarea necesita más detalle.

### Conceptos mínimos

| Concepto | Significado en RepoLead |
|---|---|
| Repositorio | Un proyecto Git, identificado por nombre y ruta local. |
| Snapshot | Una captura indexada del proyecto, con ID propio y referencia a `HEAD`. Puede incluir cambios locales en archivos rastreados. |
| Símbolo | Una unidad de código: función, clase, método, tipo o endpoint, entre otras. |
| Relación o edge | Una conexión: contiene, importa, referencia, implementa o está probado por. |
| Módulo | Un directorio detectado a partir de `package.json`, `pyproject.toml` o `setup.py`; no necesariamente cada carpeta. |
| Dossier | El resumen técnico de un módulo generado por el modelo. |
| Brief | La síntesis del repositorio construida a partir de los dossiers. |
| Finding | Un hallazgo de una regla, acompañado de evidencia y un estado como `candidate` o `confirmed`. |
| Embedding | Un vector numérico usado para recuperar código y conocimiento por similitud semántica. No es un resumen escrito. |

### Tres tipos de procesamiento diferentes

1. **Análisis determinista:** Git, Tree-sitter, SCIP, SQLite y selección de contexto. No necesita un modelo generativo.
2. **Recuperación con modelos locales:** TEI genera embeddings y puede reordenar resultados. Consume recursos de la máquina o del servidor al que apunten sus URLs.
3. **Interpretación generativa:** `analyze` y el juez de `audit` usan Qwen3.5 mediante Ollama local por defecto. Claude mediante API o Agent SDK queda disponible cuando se selecciona explícitamente y consume cuota o tokens del proveedor.

Conectar Claude Code o Codex como cliente MCP **no cambia el backend de `analyze`**. El cliente consulta la memoria preparada; los backends de generación disponibles son `ollama`, `api` y `claude-code`.

## 2. Preparación y primer repositorio

### 2.1 Preparar RepoLead

Necesitas Bun y Git. El proyecto declara Bun `1.3.13`; Node.js también participa en herramientas de desarrollo e indexadores. Docker es opcional para el catálogo y el contexto local, pero es la vía incluida para levantar los servicios semánticos.

Los ejemplos asumen Bash. Sustituye las rutas de ejemplo por rutas absolutas reales:

```bash
cd /ruta/a/repolead
bun install

export REPOLEAD_ROOT="/ruta/a/repolead"
repolead() {
  bun "$REPOLEAD_ROOT/apps/cli/src/index.ts" "$@"
}

repolead --help
repolead doctor
```

La función `repolead` solo vive en esa terminal salvo que la guardes en tu configuración de shell. Los clientes MCP necesitan el ejecutable y los argumentos reales; no pueden depender de esa función.

### 2.2 Requisitos del repositorio objetivo

Trabaja desde la raíz del repositorio que quieres indexar. Debe tener un `HEAD` válido: un proyecto recién creado con `git init` pero sin commits todavía no cumple ese requisito.

RepoLead enumera archivos con `git ls-files` y lee su contenido actual en disco. Por tanto:

- Incluye modificaciones locales de archivos rastreados, sin exigir un commit nuevo.
- No incluye archivos nuevos que sigan como `untracked`.
- Un archivo debe incorporarse deliberadamente a Git para entrar al índice; revisa qué agregas, especialmente secretos.
- El SHA del snapshot no basta para reconstruir un árbol de trabajo sucio; los hashes de contenido distinguen esos cambios.

### 2.3 Primer uso sin modelo generativo ni servicios semánticos

```bash
cd /ruta/a/mi-proyecto
repolead scan . --no-scip
repolead context --tokens 2000
repolead query "nombreDeUnaFuncion" --limit 5
```

Esto permite explorar símbolos y relaciones disponibles. Sin TEI/Qdrant, `query` utiliza búsqueda textual y señal de grafo; su comprensión de consultas conceptuales será más limitada.

`--no-scip` es útil para una primera pasada. Después ejecuta `scan .` sin esa opción para intentar incorporar referencias más precisas.

La base predeterminada se guarda en:

```text
mi-proyecto/
  .repolead/
    repolead.db
```

Añade `.repolead/` al `.gitignore` del proyecto objetivo si no está excluido. El `.gitignore` de RepoLead no se aplica automáticamente a otros repositorios.

### 2.4 Activar búsqueda semántica local

Ejecuta Compose desde la instalación de RepoLead:

```bash
cd "$REPOLEAD_ROOT"
docker compose up -d
repolead doctor

cd /ruta/a/mi-proyecto
repolead reindex
repolead query "validación de permisos del usuario"
```

El Compose incluido configura:

| Servicio | Modelo o función | Puerto local predeterminado |
|---|---|---|
| `qdrant` | Almacena y busca vectores | `6333` HTTP; también publica `6334` |
| `embeddings` | `Qwen/Qwen3-Embedding-4B` mediante TEI | `8080` |
| `reranker` | `Qwen/Qwen3-Reranker-0.6B` mediante servicio Transformers compatible con TEI | `8081` |

Compose fija la revisión de embeddings mediante `--revision` y la del reranker mediante `MODEL_REVISION`; `REPOLEAD_EMBEDDING_REVISION` y `REPOLEAD_RERANKER_REVISION` permiten sustituirlas. El despliegue actualizado ofrece 32.768 tokens por entrada de embeddings y por par de reranking, independientes de los 120.000 de contexto agregado. El cliente envía `truncate: false`; una prueba real confirmó rechazo HTTP 422 al enviar 40.002 tokens al embedding. Consulta `/info` para tu despliegue.

Los modelos pueden tardar en descargarse e inicializarse la primera vez. El Compose normal usa CPU; el [override GPU](../docker-compose.gpu.yml) requiere revisar la compatibilidad de la imagen y de tu hardware. RepoLead no arranca Docker al ejecutar `scan`, `onboard` o `serve`.

### 2.5 Alta completa con interpretación del proyecto

Levanta el generador local desde la instalación de RepoLead. En el equipo con RTX 40xx:

```bash
cd "$REPOLEAD_ROOT"
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile leaf up -d
docker compose exec leaf-model ollama pull qwen3.5:9b-q4_K_M
```

Después analiza el proyecto:

```bash
cd /ruta/a/mi-proyecto
repolead onboard . --backend ollama --context-tokens 120000
repolead brief
```

También puedes omitir `--backend ollama`: es el valor predeterminado, salvo una configuración explícita del proyecto. El comando genera memoria técnica, de producto y juicios de auditoría con el modelo local. Si eliges generación remota, usa `--backend claude-code` o `--backend api` con las credenciales correspondientes. `--model` permite seleccionar el nombre de modelo que acepte ese backend; el valor predeterminado codificado para API es `claude-opus-5`.

Para hacer el alta sin interpretación generativa debes desactivar **ambas** etapas:

```bash
repolead onboard . --no-analyze --no-audit
```

Ese último comando todavía intentará indexar vectores si TEI y Qdrant están disponibles. Si quieres exclusivamente los hechos locales, usa `scan`.

### 2.6 Precargar conocimiento de producto y técnico

El índice técnico explica estructura y comportamiento observado; para conocer requisitos, objetivos y decisiones, incluye documentación versionada. Por defecto se ingieren `README.md` y los archivos `.md`, `.mdx`, `.txt` y `.rst` dentro de `docs/`, hasta 1 MiB por archivo. Los documentos no rastreados por Git no se incorporan. Configura otras ubicaciones en `.repolead.yaml`:

```yaml
version: 1
documentation:
  paths: [README.md, docs, requirements]
modules:
  - name: pedidos
    path: src/orders
analysis_budget:
  max_tokens: 120000
  max_source_lines_per_pack: 100000
  max_findings_per_module: 20
  max_evidence_per_finding: 8
  max_reanalysis_depth: 3
model:
  backend: claude-code
```

Los flags de modelo/backend y `--context-tokens` tienen precedencia sobre la configuración. Los módulos anidados pertenecen a la ruta más específica; los archivos sin módulo declarado quedan en el módulo raíz. Se rechazan claves desconocidas, rutas externas y módulos duplicados. Un cambio de configuración invalida `refresh`, aunque el YAML sea local.

`max_reanalysis_depth` acepta enteros entre 0 y 32 y usa 3 por defecto. Limita los saltos de dependencias salientes cuyo contenido participa en la invalidación de una ficha. Con 0 se siguen los hechos propios y la estructura de relaciones; con 1 también los destinos directos; con 2, sus dependencias. La jerarquía archivo → módulo → repositorio siempre sigue los cambios de sus hijos. Los destinos más allá del límite se declaran en `unknowns`. Sin referencias de compilador se utilizan imports por archivo, con cobertura más conservadora.

```bash
repolead refresh .
repolead analyze --dry-run
repolead analyze --audience all
repolead brief --product --json
repolead brief --document docs/product.md --json
```

`all` prepara ambas vistas. `technical` prepara la jerarquía técnica; `product` prepara documentación y contexto funcional usando los dossiers técnicos disponibles. Este último informa si todavía no existe un brief técnico. El contexto de producto estructura objetivos, funcionalidades, roles, flujos, reglas y decisiones; distingue afirmaciones `documented`, `implemented` e `inferred`, y mantiene preguntas abiertas en `unknowns`. Una afirmación `implemented` necesita procedencia de fuente, no solo documentación.

Los enlaces Markdown relativos a archivos crean relaciones `DOCUMENTED_BY`. Un enlace como `[validación](../src/orders.ts#L12)` también identifica los símbolos que contienen esa línea. La existencia del enlace no demuestra que el código satisfaga el requisito. Los documentos largos se dividen por líneas/secciones: todas las líneas se analizan y la síntesis informa si omite evidencia de sus fichas. Una línea individual que no cabe produce un error explícito para ampliar el presupuesto o dividirla.

En MCP, producto puede comenzar con `repo_overview` y `audience: "product"`, y continuar leyendo los recursos de documentos. Ingeniería usa la vista técnica y sus dossiers. Estas lecturas no llaman al modelo generativo. Para precargarlas al empezar una conversación, el cliente debe solicitar esa vista: conectar el servidor no inserta toda la base en la ventana de contexto.

Para un equipo de producto, el flujo completo es: mantener requisitos y decisiones en la documentación versionada → ejecutar `onboard` o `refresh --analyze` → servir la base → hacer que el cliente solicite la vista de producto al iniciar → ampliar con documentos y evidencia según la pregunta. La vista técnica sigue disponible en la misma base. El límite de tokens de una consulta no limita cuánto conocimiento puede persistir SQLite: determina cuánto se selecciona para esa entrega.

El [estado del roadmap](roadmap-status.json) sigue `in_progress`. Las vistas técnica y de producto ya pasaron una [evaluación con modelos reales](../benchmarks/generative-acceptance.json): generación jerárquica, evidencia validada, repetición sin llamadas nuevas y actualización de producto tras cambiar código. Es una fixture finita, no una garantía de exactitud para cualquier proyecto. El objetivo de responder con menos del 10 % de los tokens de exploración manual todavía no está demostrado. Impacto, trazado estático, hotspots, oportunidades, mutaciones dirigidas con Stryker y flujo de datos con Joern están disponibles. El backend Qwen coder es opcional y se habilita explícitamente; las pruebas generativas y de tokens se registran por separado de las pruebas de integración.

Código: [configuración](../packages/config/src/index.ts), [ingesta](../packages/code-graph/src/documents.ts) y [análisis de producto](../packages/lead-analyzer/src/product.ts).

### 2.7 Varios proyectos Git dentro de una carpeta

Cada proyecto conserva su propia `.repolead/repolead.db`. Para una carpeta como `/home/marco-devx/companies/wlt`, procesa sus repositorios Git directos de forma secuencial:

```bash
(
  set -e
  for proyecto in /home/marco-devx/companies/wlt/*; do
    [ -d "$proyecto" ] || continue
    [ -e "$proyecto/.git" ] || continue
    printf '\nAnalizando: %s\n' "$proyecto"
    if [ -f "$proyecto/.repolead/repolead.db" ]; then
      repolead refresh "$proyecto" --analyze --backend ollama --context-tokens 120000
    else
      repolead onboard "$proyecto" --backend ollama --context-tokens 120000
    fi
  done
)
```

El bloque se detiene ante un error y no utiliza Claude como respaldo. Los proyectos nuevos reciben también la auditoría de `onboard`; `refresh --analyze` actualiza memoria e índice, pero no vuelve a ejecutar las policies. Para renovar sus juicios usa `repolead audit --db /ruta/proyecto/.repolead/repolead.db --policies "$REPOLEAD_ROOT/policies" --backend ollama`.

El cliente MCP puede servir todas esas bases con `repolead serve --dir /home/marco-devx/companies/wlt`. Si Claude ya tiene registrado ese comando, él inicia el proceso: reinicia la conexión al incorporar repositorios nuevos. Los cambios de snapshot dentro de bases ya conocidas se detectan sin reiniciar. El descubrimiento de `--dir` cubre la carpeta y sus hijos inmediatos; no recorre niveles arbitrarios ni interpreta una carpeta sin Git como repositorio independiente.

Al cambiar de Claude a Ollama, la identidad del modelo invalida la caché generativa correspondiente: la primera preparación local debe generar sus propios análisis. Después se reutilizan mientras sigan vigentes las entradas y la configuración.

## 3. Flujo de trabajo cotidiano

```text
Repositorio nuevo
  └─ scan / onboard
       ├─ hechos en SQLite
       ├─ vectores en Qdrant, si se indexan
       └─ dossiers + brief + findings, si se generan
            └─ context / query / brief / MCP

Cambias código rastreado
  └─ refresh
       ├─ nuevo snapshot si se detecta trabajo
       ├─ analyze, solo con --analyze
       └─ actualización vectorial de todo el conocimiento disponible
            └─ audit explícito + reindex si necesitas hallazgos nuevos en vectores
```

Secuencia habitual después de editar:

```bash
repolead refresh . --analyze --context-tokens 4000
repolead audit --policies "$REPOLEAD_ROOT/policies"
repolead reindex
repolead brief
```

Si no necesitas interpretación generativa:

```bash
repolead refresh .
repolead context --symbols MiServicio.validar --source --tokens 6000
```

`MiServicio.validar` es un ejemplo: reemplázalo por un nombre exacto de tu índice. Puedes encontrar nombres mediante `query` o el mapa de `context`.

Tres diferencias importantes:

- `refresh` no ejecuta `audit`.
- Si el código no cambió, `refresh` conserva el snapshot y vuelve a comprobar las herramientas/cobertura configuradas. Con `--analyze` también genera los resúmenes pendientes o invalidados; una repetición idéntica reutiliza sus cachés.
- Un snapshot nuevo no hereda automáticamente todos los resúmenes y hallazgos visibles. `analyze` recupera o genera los resúmenes para ese snapshot; `audit` produce sus hallazgos.

El servidor MCP no vigila archivos ni dispara `refresh` por sí mismo. Las consultas que resuelven el repositorio vuelven a comprobar el último snapshot, por lo que una conexión stdio puede consultar el índice actualizado sin reiniciarse.

## 4. Referencia técnica de todos los comandos

### Convenciones comunes

Consulta siempre `repolead <comando> --help` para la interfaz ejecutable. `repolead --help` lista los comandos, `repolead help <comando>` muestra su ayuda y `repolead --version` imprime la versión declarada por la CLI. Estas opciones no indexan ni analizan el proyecto.

`scan`, `onboard` y `refresh` calculan su base predeterminada desde el repositorio indicado por `[path]`. Los comandos de consulta y análisis usan `.repolead/repolead.db` **relativo al directorio actual**, salvo `--db` explícito. Una ruta relativa pasada en `--db` también se interpreta desde el proceso actual.

Los comandos trabajan normalmente sobre el snapshot más reciente; `query --snapshot <id>` permite consultar una captura anterior por texto, pero Qdrant conserva solo la vigente. Usa una base por repositorio y `serve --dir` para agrupar varias bases.

| Comando | Efecto principal | Modelo generativo |
|---|---|---|
| `doctor` | Diagnostica binarios y servicios | No |
| `metrics` | Consulta métricas, ejecuta herramientas configuradas o importa LCOV | No |
| `scan` | Escribe un nuevo snapshot de hechos | No |
| `onboard` | Orquesta scan, análisis, auditoría y vectores | Sí, salvo etapas desactivadas |
| `refresh` | Actualiza hechos y, si puede, vectores | Solo con `--analyze` y trabajo detectado |
| `reindex` | Escribe/actualiza vectores en Qdrant | No; usa embeddings |
| `analyze` | Escribe dossiers y brief, con caché | Sí, salvo caché o `--dry-run` |
| `audit` | Escribe hallazgos con evidencia | Sí, salvo `--no-judge` o sin candidatos |
| `brief` | Lee resúmenes almacenados | No |
| `query` | Busca símbolos | No; puede usar embeddings y reranker |
| `context` | Construye contexto acotado localmente | No |
| `impact` | Calcula alcance potencial, factores de riesgo y workflow provisional | No |
| `trace` | Recorre llamadas hasta un objetivo o efecto registrado | No |
| `hotspots` | Prioriza funciones con mediciones y factores desconocidos | No |
| `opportunities` | Consulta/regenera oportunidades derivadas | No |
| `mutation` | Prepara un plan, ejecuta Stryker con `--run` o importa/consulta resultados | No |
| `dataflow` | Consulta Joern o lo ejecuta con `--run` sobre fuente capturada | No |
| `benchmark-tokens` | Compara tamaños y cobertura | No |
| `serve` | Expone consultas por MCP | No; algunas consultas usan recuperación semántica |
| `install-hooks` | Modifica la configuración local de Claude Code | No |

Las consultas están pensadas para bases ya indexadas. Abrir una ruta SQLite inexistente puede crear una base vacía; comprueba `--db` si recibes “no hay snapshots”.

### 4.1 `doctor`: comprobar el entorno

```bash
repolead doctor
repolead doctor --db .repolead/repolead.db --json
```

Comprueba Bun, Git, Docker, los indexadores TypeScript/Python instalados como dependencias de RepoLead y los endpoints de salud de Qdrant, embeddings y reranker. No instala ni arranca servicios. Marca Bun y Git como obligatorios; los demás son opcionales. Devuelve código de error si falta un requisito obligatorio.

También comprueba versiones de jscpd, Ruff, Radon y Stryker, el intérprete Joern y la disponibilidad HTTP de Ollama. Los tres últimos son opcionales; una respuesta de Ollama no demuestra que el modelo esté descargado. `--db` incluye `metrics_status`, con errores, fuentes omitidas y estado de cobertura; encontrar el ejecutable no equivale a haber medido el snapshot.

Con `--db` inspecciona los diagnósticos del último snapshot: errores sintácticos, rutas dinámicas no resueltas, resultado de cada indexador y definiciones SCIP que no se pudieron reconciliar. La salida normal muestra hasta 20 detalles; `--json` devuelve el reporte completo. Una base inexistente produce un error sin crearla. No valida credenciales del modelo ni confirma que el proyecto pueda compilarse; encontrar el indexador instalado tampoco demuestra que haya terminado correctamente un scan.

Código: [checks.ts](../apps/cli/src/doctor/checks.ts).

### 4.2 `scan [path]`: construir los hechos

```bash
repolead scan .
repolead scan /ruta/a/mi-proyecto --name mi-api --db /ruta/a/mi-api.db --no-scip
```

Opciones: `[path]` por defecto `.`, `--db`, `--name`, `--no-scip`.

Pasos internos:

1. Obtiene `HEAD`, archivos rastreados e historial Git.
2. Prepara la identidad del repositorio y un snapshot nuevo.
3. Lee archivos; calcula hashes, lenguaje y metadatos.
4. Extrae símbolos, imports/exports, rutas y tests en TypeScript/TSX, JavaScript/JSX y Python; incorpora la documentación configurada. Símbolos y tests conservan límites exactos y hashes de su cuerpo.
5. Detecta módulos y relaciones de pertenencia.
6. Intenta ejecutar los indexadores SCIP aplicables, salvo `--no-scip`.
7. Publica atómicamente el snapshot completo con archivos, documentos, símbolos, relaciones, módulos, tests y métricas. Un fallo de escritura conserva el snapshot anterior.
8. Ejecuta los analizadores opcionales y la importación LCOV declarados en `metrics` de `.repolead.yaml`; publica sus resultados en una transacción separada, antes de que `onboard` continúe con `analyze`.

No crea embeddings, resúmenes ni hallazgos. Cada ejecución crea un snapshot; no es la alternativa que evita trabajo cuando no cambió nada. Los archivos superiores a 1 MiB no se parsean como fuente. Identificar una extensión no implica tener un extractor de símbolos para ese lenguaje.

Código: [scan.ts](../packages/code-graph/src/scan.ts).

### 4.3 `onboard [path]`: ejecutar el alta completa

```bash
repolead onboard . --backend ollama --context-tokens 120000
repolead onboard . --no-analyze --no-audit --no-scip
```

Opciones: `[path]`, `--db`, `--name`, `--model`, `--backend ollama|api|claude-code` (default `ollama`), `--context-tokens` (config o 120000), `--policies`, `--no-scip`, `--no-analyze`, `--no-product`, `--no-audit`.

Ejecuta secuencialmente:

1. **Scan:** crea el snapshot de hechos.
2. **Analyze:** genera o recupera la jerarquía técnica y el contexto de producto. `--no-product` omite producto; `--no-analyze` omite toda esta etapa.
3. **Audit:** ejecuta las policies con juez, salvo `--no-audit`; también puede omitirla si no encuentra el directorio de reglas.
4. **Reindex:** comprueba TEI/Qdrant e indexa código, documentos, resúmenes y hallazgos ya generados; si no hay servicios, informa que omitió esa etapa.

Al terminar imprime comandos de conexión para Claude Code y Codex; **no los registra automáticamente**. Tampoco instala hooks. Para rules personalizadas usa `--policies`; por defecto intenta localizar el pack de la instalación de RepoLead.

No es una transacción global de cuatro etapas: si una etapa posterior falla, puede haber quedado un snapshot o índice ya generado. Puedes continuar con `reindex`, `analyze` o `audit` sin repetir todo el alta.

Código: [onboard.ts](../apps/cli/src/commands/onboard.ts).

### 4.4 `refresh [path]`: detectar cambios y actualizar

```bash
repolead refresh .
repolead refresh . --analyze --backend ollama --context-tokens 120000
```

Opciones: `[path]`, `--db`, `--analyze`, `--model`, `--backend`, `--context-tokens` (120000), `--no-scip`.

Compara `HEAD`, la configuración, la versión del extractor y los hashes de archivos con el snapshot previo. Si nada cambió, evita otro scan. Sin `--analyze`, termina ahí; con `--analyze`, prepara o reanuda el conocimiento del snapshot actual y reutiliza lo que ya está completo. Esto funciona también después de haber indexado cambios locales sin commit. Los renombres se expresan como ruta eliminada y ruta nueva.

Reutiliza la extracción sintáctica de archivos sin cambios y parsea los modificados. Las relaciones de imports se reconstruyen contra los archivos actuales, para detectar dependencias eliminadas sin volver a parsear sus consumidores. Informa archivos parseados/reutilizados, símbolos cambiados/eliminados y módulos afectados. SCIP sigue siendo un índice de proyecto cuando está habilitado; lectura de archivos e historial tampoco son un parche de AST en memoria.

Con `--analyze`, primero recorre el análisis técnico y de producto y deja que sus cachés decidan qué reutilizar. `--no-product` omite la síntesis funcional. Después, si TEI/Qdrant están disponibles, actualiza todos los puntos vivos al snapshot actual, reutiliza vectores válidos y purga los obsoletos de ese repositorio. No vuelve a juzgar policies. Si ejecutas `audit` o `analyze` por separado, el nuevo conocimiento queda disponible por FTS inmediatamente; ejecuta `reindex` para actualizar también sus vectores.

`refresh` conserva el nombre almacenado durante el alta, aunque difiera del nombre de la carpeta, y rechaza una base perteneciente a otra ruta de repositorio.

Código: [refresh.ts](../packages/code-graph/src/refresh.ts) y [comando refresh](../apps/cli/src/commands/refresh.ts).

### 4.5 `reindex`: sincronizar el índice vectorial

```bash
repolead reindex --db /ruta/a/mi-proyecto/.repolead/repolead.db
```

Opción: `--db`.

Necesita un snapshot y TEI/Qdrant accesibles. Reconstruye el índice buscable desde SQLite: símbolos con cuerpo completo, resúmenes, hallazgos confirmados, secciones de documentación y nombres/rutas de tests. La fuente de cada snapshot se guarda por hash, por lo que reindexar no requiere montar el árbol original. Los snapshots antiguos sin fuente se identifican como incompletos: usa `refresh` para capturarla.

La colección predeterminada se deriva de la identidad de pesos/configuración del embedding (`repolead-<hash>`); `--collection <name>` selecciona una explícita. Cambiar de modelo crea otro espacio vectorial y conserva la colección anterior. El cliente envía `truncate: false`: una entrada que supera la capacidad de TEI se informa como omitida del índice vectorial y permanece consultable por FTS, sin recortar silenciosamente su cuerpo.

Reutiliza vectores cuando coinciden el hash del texto completo y la revisión/configuración de TEI. Los puntos intactos solo actualizan su payload cuando cambian el snapshot o los metadatos; las entradas nuevas o modificadas generan embeddings. Después de escribir los puntos vigentes, elimina físicamente los obsoletos de ese repositorio, incluso si quedó vacío. Una lease por base/colección impide indexaciones concurrentes sobre esa base; un cambio de snapshot o de conocimiento durante el cálculo obliga a reintentar. Los errores de servicio interrumpen la operación antes de la purga. No es una transacción distribuida: si una escritura intermedia falla, vuelve a ejecutar `reindex`.

No escanea cambios en disco. Si cambió el código, primero actualiza SQLite con `refresh` o `scan`. Tras cambiar el modelo, `reindex` sin `--collection` reconstruye sus vectores en una colección nueva y publica su nombre en los metadatos del snapshot. No regenera las fichas técnicas o de producto ni elimina la colección anterior. Una colección explícita de dimensión incompatible se rechaza.

Código: [indexer.ts](../packages/retrieval/src/indexer.ts) y [embeddings.ts](../packages/retrieval/src/embeddings.ts).

#### Modelos locales actualizados y migración

La configuración actual usa [Qwen3-Embedding-4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B) (2.560 dimensiones, revisión `5cf2132abc99cad020ac570b19d031efec650f2b`) y [Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) (revisión `e61197ed45024b0ed8a2d74b80b4d909f1255473`). Se eligieron por su soporte multilingüe/código y sus resultados publicados; esos benchmarks no demuestran un porcentaje de mejora en tus repositorios.

TEI se fija en `1.9.4`. El reranker causal requiere comparar logits de «yes/no»: `services/reranker` implementa ese protocolo con Transformers y mantiene el contrato `/health`, `/info`, `/rerank`. Corre en CPU para dejar la VRAM de la RTX 4080 SUPER a embeddings y al generador local. Recibe hasta 32 textos por solicitud, valida longitud sin truncar y devuelve los índices originales con sus scores. CPU puede ser más lenta que el BGE anterior en GPU.

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build embeddings reranker
repolead reindex --db .repolead/repolead.db
# Generador local para memoria técnica, producto y auditoría
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile leaf up -d leaf-model
docker compose exec leaf-model ollama pull qwen3.5:9b-q4_K_M
```

El generador cambia de Qwen2.5-Coder-7B a [Qwen3.5-9B Q4_K_M](https://ollama.com/library/qwen3.5). Qwen3.6 ofrece variantes más grandes (27B/35B) que requieren más de los 16 GB de VRAM disponibles solo para sus pesos cuantizados; se priorizó una variante que puede compartir este equipo. Ahora `ollama` es el backend principal predeterminado para toda la memoria y el juez de auditoría. `local_model` permite ajustar sus opciones; no es necesario declarar esa clave para utilizar el modelo local predeterminado.

La [validación de la actualización](../benchmarks/retrieval-upgrade-acceptance.json) obtuvo 8/8 consultas español/inglés en primer lugar, sin warnings: 34 embeddings iniciales, cero nuevos al repetir y uno nuevo tras modificar una función. Es el mismo corpus acotado que antes, no una mejora porcentual demostrada. La [prueba del generador](../benchmarks/local-model-upgrade.json) verificó una conversión escalar por el adaptador real: 149 tokens locales de entrada y 53 de salida, JSON válido, unos 38 segundos incluyendo arranque. No valida razonamiento general ni una entrada local llena de 120K.

```bash
REPOLEAD_RETRIEVAL_REPORT=benchmarks/retrieval-upgrade-acceptance.json bun scripts/verify-retrieval.ts
bun scripts/verify-local-model-upgrade.ts --real
```

La migración vectorial utiliza la fuente y memoria ya guardadas en SQLite; no llama al generador ni cambia sus resúmenes. La colección anterior permanece disponible para volver al modelo anterior. Los reportes históricos conservan sus pesos, presupuestos y resultados originales: no describen automáticamente esta configuración nueva ni garantizan que 120K ahorre más tokens.

### 4.6 `analyze`: interpretar los hechos

```bash
repolead analyze --dry-run --context-tokens 4000
repolead analyze --backend ollama --context-tokens 120000
repolead analyze --module retrieval --backend api --model nombre-del-modelo
```

Opciones: `--db`, `--model`, `--backend`, `--analysis-mode files|symbols` (config o `files`), `--module`, `--audience technical|product|all` (default `all`), `--dry-run`, `--context-tokens` (config o 120000) y `--batch-size` (modo `symbols`, 1–4; config o 1).

El CLI usa por defecto `analysis_mode: files`: analiza toda la fuente técnica reconocida por archivo, sin generar una ficha individual para cada DTO, función o clase. Divide archivos grandes en secciones completas y con caché; después sintetiza el dossier del archivo, los módulos y el brief. Las síntesis grandes también se dividen para consumir toda la evidencia hija. Cada paquete respeta el techo de tokens y `analysis_budget.file_pack_bytes` (24.000 bytes por defecto); el código que no cabe continúa en el siguiente paquete. Si ni una línea o evidencia cabe, falla explícitamente en vez de presentar cobertura completa.

El índice de símbolos, sus cuerpos y relaciones siguen disponibles para búsquedas y evidencia. Los dossiers de archivo añaden `productFacts` citados para campos, restricciones, permisos, mensajes, estados, rutas y auditoría. `--analysis-mode symbols` conserva el análisis exhaustivo anterior por símbolo. El backend Agent SDK mantiene desactivadas sus herramientas de lectura/ejecución y no carga settings, hooks, skills, servidores MCP ni `CLAUDE.md` del proyecto/usuario; cada llamada remota tiene un timeout de 120 segundos.

En modo `symbols`, las fichas reciben hasta 100.000 líneas de fuente por defecto, dentro del presupuesto de tokens, con omisiones explícitas si no cabe el cuerpo. En modo `files`, el límite de líneas determina secciones sucesivas y no descarta el final. El análisis usa la copia del snapshot; en bases antiguas sin ella, la lectura del árbol exige que su hash siga coincidiendo. Los dossiers técnicos abarcan archivos de texto reconocidos, incluidos barrels, scripts de inicialización y configuración sin símbolos extraídos. La documentación configurada tiene sus propias fichas y síntesis de producto. Los formatos no reconocidos quedan identificados como cobertura pendiente.

Con `--module` filtra por nombre o ruta y no genera los briefs globales técnico/de producto. `--dry-run` muestra el plan del modo seleccionado sin llamar al modelo. En modo `files`, cuenta archivos, secciones y síntesis mínimas; las reducciones jerárquicas pueden añadir pasos y ampliar el contador durante la ejecución. El cambio de granularidad necesita generar sus nuevos dossiers una vez; no elimina las fichas anteriores que sigan disponibles en el snapshot.

La salida debe cumplir el esquema Zod y citar únicamente IDs de evidencia entregados al modelo. Una salida inválida admite dos intentos de corrección adicionales; si sigue fallando, no se guarda como resumen. La caché considera evidencia, versión de la política de análisis, prompt y modelo. Un acierto evita la llamada y conserva la procedencia al copiar el resumen al snapshot actual. El presupuesto limita cada paquete, no todas las llamadas ni sus salidas. Dentro de cada llamada los IDs largos se sustituyen por referencias cortas (`E1`, `E2`, …), restringidas por el esquema. Antes de validar y persistir se traducen a los IDs originales. Las síntesis no reenvían citas anidadas de sus hijos; cada afirmación conserva sus padres de evidencia en SQLite. Esto reduce repetición y evita confundir referencias de distintos niveles sin borrar procedencia.

El agrupamiento opcional (`analysis_budget.batch_size` o `--batch-size`) reúne hasta cuatro fichas independientes del mismo nivel; sus padres esperan a que terminen los hijos. Cada ficha mantiene su esquema y un espacio de citas separado. El reparto de tokens entre fichas usa un proxy proporcional, conservando el total del proveedor. **Se mantiene 1 por defecto**: en la [medición real de cuatro fichas](../benchmarks/analysis-batching-acceptance.json), agrupar redujo cuatro consultas a una, pero elevó los tokens de 21.913 a 36.021 (+64,4 %) y el costo estimado del SDK de USD 0,048301 a USD 0,052638 (+9,0 %). Menos llamadas no demuestra ahorro. Ambos modos reutilizaron las fichas sin llamadas al repetir el análisis.

Código: [analyze.ts](../packages/lead-analyzer/src/analyze.ts), [evidence.ts](../packages/lead-analyzer/src/evidence.ts) y [prompts.ts](../packages/lead-analyzer/src/prompts.ts).


#### Selección de fichas y generación local

Para reservar la VRAM a Ollama, `onboard` y `refresh` permiten `--no-vectors`. Este flag no llama a TEI/Qdrant y marca `vector_refresh_pending=true`; después se ejecuta `repolead reindex --db <repo>/.repolead/repolead.db` con embeddings y Qdrant activos. El reindexado completo limpia la marca; si omite entradas, continúa pendiente. El CLI por sí solo no pausa contenedores.

En el workspace WLT, `make repolead-refresh` orquesta ambas fases: primero pausa embeddings/reranker, reinicia Ollama y genera memoria; después detiene Ollama, arranca recuperación y reindexa. `REPOLEAD_REPO=administration-service` limita la selección. `make repolead-analyze` y `make repolead-vectors` permiten ejecutarlas por separado con la misma selección. Un lock impide dos lotes coordinados simultáneos y se rechazan jobs CLI activos antes de cambiar servicios. No lanzar el antiguo comando directo en otra terminal durante estas fases. La caché y los modelos se conservan; durante generación la búsqueda semántica local está temporalmente pausada.

En una [prueba sintética con el entorno preparado](../benchmarks/phased-gpu-smoke.json), Ollama reportó el modelo completamente en GPU con contexto de 16.384. Esta observación verifica la colocación del modelo, no una mejora de tiempo garantizada para todos los tamaños de entrada o proyectos.

En modo `files` no se generan fichas individuales: toda la fuente técnica reconocida queda cubierta por dossiers de archivo y secciones. En modo `symbols`, `symbol_selection: all` conserva todas las fichas; `public-or-nontrivial` omite únicamente funciones/métodos privados sin export, de hasta cinco líneas y complejidad ciclomática medida igual a 1. Su fuente permanece en el dossier de archivo y las omisiones se informan en el plan y los metadatos. Complejidad desconocida conserva la ficha.

```yaml
analysis_mode: files
analysis_budget:
  file_pack_bytes: 24000
  max_tokens: 120000
symbol_selection: public-or-nontrivial # solo se aplica en modo symbols
model:
  backend: ollama
modules:
  - {name: payments, path: src/payments, critical: true}
local_model:
  url: http://127.0.0.1:11434
  model: qwen3.5:9b-q4_K_M
  context: 131072
  output: 4096
  timeoutMs: 180000
  # digest: hash SHA-256 de los pesos reportado por /api/tags
```

```bash
docker compose --profile leaf up -d leaf-model
docker compose exec leaf-model ollama pull qwen3.5:9b-q4_K_M
repolead analyze --dry-run
repolead analyze
```

El perfil usa Ollama `0.40.13`; se arranca explícitamente con `--profile leaf`, aunque el backend de análisis predeterminado ahora sea local. `docker-compose.gpu.yml` habilita NVIDIA también para este servicio. Qwen3.5-9B Q4_K_M descarga aproximadamente 6,6 GB incluyendo su proyector; necesita memoria adicional al ejecutarse. Ollama puede repartir capas entre GPU y RAM si embeddings ocupa parte de la VRAM. Es un generador distinto de Qwen3-Embedding-4B.

Con `model.backend: ollama` (también el valor predeterminado), el modelo local es el principal: procesa todas las fichas, archivos, módulos, brief, documentos, producto y juicios de auditoría, incluidos Python, funciones con ramas y módulos críticos. `--model` tiene prioridad sobre `model.name`, que a su vez tiene prioridad sobre `local_model.model`. No hay cambio automático a Claude si Ollama falla o rechaza una entrada. Los resúmenes pasan la misma validación de esquema y evidencia que los remotos.

Solo en modo híbrido, al seleccionar explícitamente un backend remoto y configurar `local_model`, se conserva la ruta auxiliar conservadora: funciones JS/TS de hasta cinco líneas, complejidad conocida igual a 1 y retornos literales, de variables o conversiones escalares simples. El resto utiliza el principal remoto. `critical: true` evita esa ruta auxiliar; no fuerza Claude cuando el principal es Ollama.

Los 120.000 tokens son el presupuesto de evidencia de RepoLead, medido con un tokenizador de referencia; no garantizan que esa entrada quepa en Qwen ni en la memoria disponible. La ventana de Ollama también debe alojar instrucciones, esquema y salida. Si la comprobación de contexto rechaza una entrada, reduce explícitamente `--context-tokens` o configura una ventana local compatible con tus recursos. No se recorta la entrada silenciosamente ni se envía a un proveedor remoto.

La [prueba real del backend principal](../benchmarks/local-backend-acceptance.json) ejecutó la CLI compilada sobre un proyecto aislado con una función condicional y documentación: seis niveles de memoria y un juicio de auditoría, siete llamadas locales, 13.341 tokens de entrada y 2.550 de salida, unos 138 segundos. Repetir `analyze`, `audit` y `refresh --analyze` produjo cero llamadas nuevas. La ficha conservó las dos ramas y producto mantuvo el correo futuro como documentado, sin presentarlo como implementado. El juicio de auditoría supuso trivialidad por el número de símbolos sin evidencia del comportamiento en su candidato: se valida su integración y caché, no la corrección general de sus decisiones. No demuestra equivalencia de calidad con Claude ni una entrada llena de 120K. Se reproduce con `bun run verify-local-backend`; usa el modelo local real y desactiva SCIP y vectores en esa fixture.

La identidad de caché incorpora endpoint, modelo, digest real, contexto, salida y modo sin thinking. El máximo local predeterminado es 131.072 posiciones; cada petición reserva solo el bloque necesario para entrada, esquema, salida y framing, sin asignar toda la ventana para una ficha pequeña. Se solicita `think: false` y JSON estructurado. Se verifica el digest antes/después de generar; `digest` permite exigir pesos concretos. Una comprobación conservadora de bytes UTF-8 reserva salida y framing para evitar truncamiento silencioso del contexto. Una respuesta incompleta se rechaza. Los contadores locales se incluyen en el total de análisis, pero no son tokens facturados por Claude. Referencias: [chat de Ollama](https://docs.ollama.com/api/chat), [salidas estructuradas](https://docs.ollama.com/capabilities/structured-outputs) y [modelo Qwen3.5](https://ollama.com/library/qwen3.5).

### 4.7 `audit`: evaluar reglas de arquitectura y diseño

```bash
repolead audit --policies "$REPOLEAD_ROOT/policies" --no-judge
repolead audit --policies "$REPOLEAD_ROOT/policies" --backend ollama
```

Opciones: `--db`, `--policies`, `--model`, `--backend`, `--context-tokens` (config o 120000), `--no-judge`.

Carga policies `.yaml` y `.yml` con esquema validado, versión y `required_evidence`. Ejecuta los detectores y descarta candidatos que no cumplen la evidencia requerida. Si hay modelo, agrupa candidatos en prompts acotados y valida un veredicto por índice, sin duplicados ni confianza fuera de 0–1. Una salida inválida admite dos correcciones adicionales. Sin juez guarda estado `candidate` y confianza inicial `0.5`; no son confirmaciones automáticas.

El pack incluye doce reglas: dependencias entre capas, persistencia dentro del dominio, tipos de framework expuestos en contratos públicos del dominio, ciclos, fan-in/fan-out altos, componentes de módulo desconectados, complejidad, bloques duplicados, capturas vacías de excepciones, diagnósticos Python y módulos sin tests vinculados. Las mediciones generan candidatos; el juez debe considerar usos legítimos como composición, limpieza de mejor esfuerzo o duplicación deliberada. “Sin tests vinculados” es una señal estructural, no cobertura ejecutada.

Los ciclos conservan un recorrido cerrado con evidencia por cada import; detectan recorridos de dos o más módulos mediante DFS, sin enumerar todos los ciclos simples posibles. El detector de contratos cruza imports y anotaciones públicas de TS/Python, reconoce aliases y excluye cuerpos ejecutables, miembros privados y parámetros genéricos que ocultan imports. Las referencias de tipo en strings de Python, imports bajo `TYPE_CHECKING` y cadenas de reexports no tienen resolución semántica completa en este detector. Las evidencias indican import y uso exacto; un import de solo tipo también puede acoplar la API pública a un framework.

La [evaluación con modelo real](../benchmarks/policy-quality-acceptance.json) acertó los 16 casos positivos/contraejemplos preparados para ocho reglas y no hizo nuevas llamadas al repetir. Es una prueba finita de auditoría, no una estimación de precisión general ni una validación de resúmenes de producto.

El directorio predeterminado de este comando es `policies` bajo el directorio actual. A diferencia de `onboard`, no busca automáticamente el pack de RepoLead: usa `--policies` cuando trabajes sobre otro proyecto.

La caché de juicios incluye definición/versión de policy, candidatos, hashes de archivos indexados, modelo y prompt; reutiliza confirmaciones y rechazos. Repetir una auditoría sin cambios no llama al modelo ni duplica hallazgos/evidencia. Después de completar todos los lotes de una policy, sus resultados anteriores dejan de estar activos (`superseded`) y se actualizan los actuales. Si falla la validación, se conserva el resultado anterior de esa policy.

El presupuesto predeterminado limita cada prompt de candidatos a 120.000 tokens proxy, con hasta 20 candidatos por módulo y 8 evidencias por candidato, configurables en `.repolead.yaml`. Si un candidato no cabe completo, se omite y se informa; no se presenta una evidencia recortada como completa. Los esquemas, instrucciones del sistema y la salida del proveedor siguen formando parte del uso facturado. La CLI muestra aciertos de caché, omisiones y tokens reportados. Las herramientas MCP de hallazgos muestran `confirmed`, no `candidate` ni `superseded`.

Código: [engine.ts](../packages/policy-engine/src/engine.ts), [detectors.ts](../packages/policy-engine/src/detectors.ts) y [policies](../policies).

### 4.8 `brief`: consultar resúmenes existentes

```bash
repolead brief
repolead brief --module retrieval --json
repolead brief --symbol hybridSearch --json
repolead brief --file packages/retrieval/src/search.ts --json
```

Opciones: `--db`, `--module`, `--file`, `--symbol`, `--product`, `--document`, `--json`. Los cinco selectores son mutuamente excluyentes; sin selector lee el brief técnico.

Lee el brief del snapshot actual o el dossier/ficha del objetivo. El módulo acepta nombre o ruta y el símbolo nombre exacto o ID; las ambigüedades se rechazan. No llama a un modelo ni genera un resumen faltante. `--json` devuelve el contenido estructurado; sin esa opción lo presenta por secciones con información del modelo y fecha.

Si no existe el resumen, ejecuta `analyze`; para el brief global, ejecútalo sin `--module`.

Código: [brief.ts](../apps/cli/src/commands/brief.ts).

### 4.9 `query <text...>`: encontrar código y conocimiento

```bash
repolead query "validación de permisos" --limit 8
repolead query hybridSearch --db /ruta/a/repolead/.repolead/repolead.db
```

Opciones: `--db`, `--limit` (8; rango 1–100), `--collection`, `--snapshot`, `--type symbol|summary|finding|document|test`, `--language`, `--module` (nombre o ruta) y `--kind` (subtipo: `function`, `product`, identificador de policy, etc.).

Combina búsqueda FTS5 sobre el contenido persistido, vectores cuando están disponibles y señal de grafo. Los filtros se aplican antes de limitar candidatos. Fusiona rankings, aplica una bonificación de coincidencia de términos y opcionalmente usa el reranker con el contenido completo. Devuelve títulos, tipos, IDs, ubicaciones, puntuaciones y procedencia de las señales. Por ejemplo, `query "reglas de reembolso" --type summary --kind product` busca en el contexto funcional guardado.

La colección predeterminada de `query` y de las consultas MCP es la registrada en `vector_index` del snapshot; `query --collection` permite cambiarla explícitamente. El reranker envía lotes de hasta 32 documentos completos. Si un documento excede su límite, lo aísla sin truncarlo, conserva su posición de fusión e informa que no tiene puntuación de reranker; los demás candidatos siguen ordenándose con el modelo.

No genera una respuesta conversacional. Encontrar símbolos relacionados con “autenticación” no equivale a explicar correctamente todo el flujo de autenticación.

Código: [search.ts](../packages/retrieval/src/search.ts).

### 4.10 `context [query...]`: entregar contexto acotado

```bash
repolead context "autenticación" --tokens 2000
repolead context --module retrieval --tokens 4000
repolead context --symbols hybridSearch --source --tokens 6000 --json
```

Opciones: `--db`, `--module`, `--symbols <names...>`, `--tokens`, `--source`, `--no-source`, `--evidence`, `--questions <path>`, `--types <kinds>`, `--include-tests`, `--known-blocks <path>`, `--json`. Mapa y evidencia usan 120.000 tokens por defecto; puedes pedir menos con `--tokens`.

Selecciona símbolos usando nombres, consulta textual y ranking del grafo. `--symbols` acepta nombres cualificados exactos o IDs; ante ambigüedad usa un ID o limita el módulo. `--module` acepta nombre o ruta y restringe el contexto a su propiedad de archivos, sin incluir automáticamente todos sus módulos hijos.

Sin `--source`, entrega principalmente firmas, ubicaciones y relaciones cercanas. Con `--source`, prioriza los cuerpos completos de los objetivos si caben, además de sus dependencias salientes inmediatas. Si un cuerpo no cabe, se omite y se reporta; no se corta silenciosamente una función para presentarla como completa.

El texto completo, incluyendo metadatos, debe respetar el presupuesto. `--json` añade métricas y listas de IDs: el campo `tokens` mide `text`, no todo el envoltorio JSON. El presupuesto permitido es un entero entre 256 y 120.000; un mínimo válido todavía puede ser insuficiente para metadatos extensos.

El modo mapa de la CLI no consulta TEI/Qdrant. Con `--evidence`, busca y reúne fuente citada, declaraciones relacionadas y memoria persistida en una sola respuesta. Puede consultar TEI, Qdrant y el reranker; si faltan, informa la degradación y conserva FTS5/grafo. No ejecuta un LLM generativo.

```bash
repolead context "cómo se valida un reembolso" --evidence --tokens 8000
repolead context --questions consultas.json --types symbol,summary --tokens 10000
repolead context "reglas del producto" --evidence --no-source
```

`consultas.json` contiene un array de 1–8 textos (máximo 1000 caracteres por texto y 4000 combinados). No se combina con la consulta posicional ni con `--symbols`. `--types` restringe los tipos de conocimiento y `--include-tests` permite tests, excluidos por defecto en este modo.

`--known-blocks recibos.json` es opcional y requiere modo evidencia. El archivo contiene un array de hasta 128 hashes SHA-256; `[]` activa la entrega de recibos sin reutilizar nada. La salida JSON añade `blocks` con `id`, `hash`, `partial` y `reused`, además del contador `reusedBlocks`. En MCP se usa `context_pack` con `mode=evidence, knownBlocks=[]` y después se pasan los recibos de los bloques anteriores que el cliente aún conserva completos en la conversación. Un bloque puede ser un extracto parcial de código: su recibo identifica todo el texto entregado, no todo el símbolo ni el archivo.

Antes de reutilizarlo, el servidor vuelve a recuperar y validar el bloque. Si coincide exactamente, devuelve `UNCHANGED` con el recibo; si cambió, entrega el texto nuevo. Los recibos están ligados al repositorio, contenido, ubicación y advertencias del bloque. Un archivo modificado sin refrescar sigue produciendo un error de fuente desactualizada, aunque se presente un recibo previo. Esto no guarda sesiones en el servidor ni ejecuta un LLM. Si el cliente perdió el texto por compactación o abrió otra conversación, debe omitir esos recibos para recuperar los bloques completos. No debe tratar una referencia `UNCHANGED` como evidencia disponible si ya no conserva el texto. El comportamiento habitual se mantiene cuando no se pasa esta opción.

Cada consulta recupera hasta cuatro candidatos, deduplicados entre consultas. El presupuesto incluye cabeceras, avisos y omisiones. Los fragmentos de fuente conservan líneas originales, hash del archivo y la distinción entre símbolo completo y extracto parcial. Cuando no cabe el símbolo, selecciona sentencias AST con condiciones envolventes y salidas tempranas pequeñas. Esto no es un análisis semántico de dependencias: el código omitido puede cambiar la interpretación y no permite concluir que algo no existe. La selección textual de fragmentos tampoco garantiza cobertura semántica de consultas en cualquier idioma. Si no encuentra una sentencia válida que quepa, indica la omisión.

La memoria conserva la base de sus afirmaciones, incertidumbres y procedencia registrada; esas ubicaciones no se presentan como nuevas lecturas de código. Cada archivo se comprueba contra el hash indexado al leerlo; un snapshot o una proyección de conocimiento que cambie durante la consulta obliga a reintentar. No vigila cambios del working tree posteriores a cada lectura. `--no-source` excluye las nuevas lecturas de código crudo; no borra datos previamente persistidos en documentos o resúmenes.

Código: [context.ts](../packages/retrieval/src/context.ts), [ranking.ts](../packages/retrieval/src/ranking.ts) y [evidence-context.ts](../packages/retrieval/src/evidence-context.ts).

### 4.11 `benchmark-tokens`: medir tamaño y cobertura

```bash
cd "$REPOLEAD_ROOT"
repolead benchmark-tokens --cases benchmarks/token-cases.json --tokens 2000
```

Opciones: `--cases <path>` obligatorio, `--db`, `--tokens` (2000).

El archivo de casos es un arreglo JSON. Por ejemplo, para una base que indexa RepoLead:

```json
[
  {
    "name": "Entender la búsqueda híbrida",
    "symbols": ["hybridSearch"]
  }
]
```

También admite `module`, pero utiliza IDs cuando un nombre no sea único en el repositorio: la resolución de objetivos del benchmark requiere identificarlos sin ambigüedad global.

Por cada caso compara los archivos relevantes completos, numerados, contra un contexto con código de los objetivos. Informa tokens, ahorro positivo o negativo, cobertura de cuerpos completos, omisiones y hashes de archivos. Los símbolos objetivo ya están dados: no mide el costo de descubrirlos.

Necesita una base actualizada y los archivos originales disponibles. No ejecuta modelos, evalúa respuestas ni consulta precios. Consulta la sección 6 para interpretar los resultados.

Código: [benchmark.ts](../packages/retrieval/src/benchmark.ts).

### 4.12 `serve`: publicar la base mediante MCP

```bash
repolead serve --db /ruta/a/mi-proyecto/.repolead/repolead.db
repolead serve --dir /ruta/a/proyectos
```

Opciones: `--db`, `--dir`, `--http`, `--port` (3939; 0 permite un puerto libre), `--host` (`127.0.0.1`), `--allow-origin` (repetible), `--token`, `--no-source`, `--tool-profile all|context`.

`--tool-profile context` publica solo `repo_overview`, `context_pack`, `search` y `get_evidence`, tanto por stdio como por HTTP. Reduce el catálogo de esquemas enviado al agente cuando solo necesita consultar conocimiento. `all` es el valor predeterminado y conserva las 14 herramientas, incluidas diagnóstico, impacto y oportunidades. Los recursos MCP siguen disponibles en ambos perfiles; este selector no es una barrera de confidencialidad. El ahorro de esquemas no garantiza ahorro de toda la sesión: también cuentan las consultas elegidas, la salida y el razonamiento del cliente.

Por defecto usa stdio: el cliente MCP lanza el proceso y habla por entrada/salida estándar. Los mensajes de diagnóstico van a stderr. Ejecutarlo a mano puede parecer que queda esperando; está esperando a un cliente, no mostrando una interfaz web.

`--dir` busca bases en el directorio indicado y sus subdirectorios **inmediatos**, no recursivamente a cualquier profundidad. Tiene prioridad sobre `--db`. La lista de repositorios se descubre al arrancar: agregar otra base requiere reiniciar ese servidor.

Con `--http`, expone MCP Streamable HTTP stateless en `/mcp`, con autenticación Bearer obligatoria mediante `--token` o `REPOLEAD_TOKEN`. Escucha en localhost; `--host 0.0.0.0` permite acceso desde otras interfaces. Si llega un header `Origin`, debe coincidir con un `--allow-origin https://producto.example`; los demás reciben 403. El preflight permitido no exige token, pero la petición MCP posterior sí. El cuerpo tiene un máximo de 1 MiB y se decodifica como UTF-8 después de reunir los chunks. Los valores siguen los [requisitos de transporte MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). No incorpora TLS ni permisos por repositorio.

Las bases deben tener aliases únicos. Un nombre ambiguo de símbolo o módulo devuelve las alternativas; se puede pedir el ID exacto del símbolo o el ID/ruta del módulo. Si dos bases comparten esos IDs, hay que indicar `repo`. Los recursos y hallazgos se consultan sobre el snapshot actual: un finding histórico no provoca una lectura de la fuente nueva usando sus líneas antiguas.

`--no-source` impide nuevas lecturas de fuente cruda a través de las herramientas, incluido `context_pack`. Los nombres, firmas, resúmenes y excerpts ya almacenados pueden seguir siendo visibles: no es un anonimizado del proyecto.

Código: [serve.ts](../apps/cli/src/commands/serve.ts), [server.ts](../apps/mcp-server/src/server.ts) y [http.ts](../apps/mcp-server/src/http.ts).

### 4.13 `install-hooks [path]`: orientar a Claude Code

```bash
repolead install-hooks .
repolead install-hooks . --remove
```

Opciones: `[path]` por defecto `.`, `--remove`.

Instala `.claude/repolead-hook.cjs` y registra un `PreToolUse` en `.claude/settings.json` para `Read|Grep|Glob`, conservando las demás entradas de configuración.

El hook sugiere consultar RepoLead, como máximo dos veces por sesión. Busca una base cercana, usa una heurística de fechas para evitar orientar hacia un índice aparentemente antiguo y deja continuar ante errores. No bloquea lecturas ni garantiza frescura por hash.

`--remove` quita la entrada correspondiente y el script instalado. **Es un hook de Claude Code, no de Codex**, y no registra el servidor MCP en ninguno de los dos clientes.

Código: [install-hooks.ts](../apps/cli/src/commands/install-hooks.ts).

### 4.14 `metrics`: mediciones de calidad y cobertura

```bash
repolead metrics --tools none --json
repolead metrics --tools jscpd,ruff,radon --coverage coverage/lcov.info --json
```

Opciones: `--db`, `--tools <lista>`, `--coverage <ruta>`, `--json`. Sin `--tools` aplica la configuración del repositorio; `none` permite consultar sin ejecutar herramientas ni importar la cobertura configurada. Un `--coverage` explícito sí se importa. Las rutas relativas del reporte y sus entradas `SF` se interpretan desde la raíz del repositorio; no se adivinan rutas por nombre de archivo.

Las métricas de Tree-sitter y del grafo ya se generan en `scan`. Para habilitar herramientas externas y cobertura también durante `scan`, `onboard` y `refresh`:

```yaml
metrics:
  tools: [jscpd, ruff, radon]
  coverage: coverage/lcov.info
```

Instala las herramientas opcionales desde la raíz de la instalación de RepoLead:

```bash
bun install
python3 -m venv .repolead-tools/python
.repolead-tools/python/bin/pip install -r services/quality/requirements.txt
repolead doctor
```

jscpd está fijado como dependencia de desarrollo. Ruff y Radon se instalan en un entorno Python separado. Los analizadores leen copias temporales de la fuente guardada en SQLite; no usan el código modificado después del scan. Ruff no aplica correcciones, Radon no importa los módulos del proyecto y ninguna herramienta ejecuta sus tests.

Los reportes se normalizan, sus rutas/rangos se validan y se guardan métricas e incidencias con analizador y procedencia. La caché incluye repositorio, versión de herramienta, perfil y hashes de las fuentes relevantes. Si una herramienta falla o falta, se registra `failed` o `unavailable`; sus resultados anteriores de ese snapshot se retiran. Un error no se convierte en cero incidencias. `metrics` devuelve código 1 para herramientas solicitadas no disponibles o fallidas, o una importación fallida.

LCOV debe existir antes de importarlo. Un archivo ausente del reporte conserva cobertura desconocida. `lineRate` y `branchRate` son proporciones entre 0 y 1 de los puntos instrumentados reportados, no de todas las líneas físicas. Sin checksums, la correspondencia con el código queda como `unverified`; si todos los puntos de línea contienen checksums válidos se registra `reported-lines-verified`. Esto verifica esas líneas, no la vigencia de todo el build. Un checksum incompatible descarta la cobertura del archivo.

`metrics` no genera dossiers ni juzga hallazgos. Después de nuevas mediciones ejecuta `analyze` y `audit` para actualizar sus interpretaciones; sus claves de caché incluyen los hechos de calidad. `refresh --analyze` realiza la actualización del contexto técnico/producto. MCP entrega las métricas actuales en `symbol_context`/`module_context` y el estado en `repo_overview`.

Código: [normalización](../adapters/quality/src/normalize.ts), [LCOV](../adapters/quality/src/coverage.ts), [ejecución](../adapters/quality/src/runner.ts) y [orquestación](../packages/code-graph/src/quality.ts).

### 4.15 `impact`: alcance y puntaje de un cambio

```bash
repolead impact --change 'Agregar reintentos a OrderRepository.save' --json
repolead impact --symbol OrderRepository.save --limit 10 --json
repolead impact --path src/payments --fact schemaChange=true --fact reversible=false --json
```

Lee el snapshot actual y calcula símbolos, archivos y módulos potencialmente afectados, contratos públicos, tests candidatos, cobertura reportada, efectos registrados y hallazgos confirmados. No necesita generar dossiers antes de usarlo. El alcance es potencial: no afirma que todos los dependientes deban modificarse.

La selección acepta `--symbol` y `--path` repetibles. Un path debe existir en el índice; los directorios abarcan sus archivos. `--change` reconoce menciones exactas de identificadores indexados, prefiriendo el nombre cualificado más largo. Si no encuentra un identificador o existe ambigüedad, devuelve candidatos para elegir en vez de inventar el objetivo. La descripción no demuestra que el cambio propuesto ya esté implementado.

El recorrido inverso sigue llamadas, referencias, herencia e implementaciones. Una clase o archivo seleccionado incluye sus declaraciones. Si hay referencias de compilador, un import no convierte automáticamente todas las funciones del archivo en dependientes; cuando falta una definición resuelta, se usa un alcance conservador por archivo/contenedor y se declara esa incertidumbre. Otro recorrido sigue llamadas salientes para incluir efectos de callees que quizá no deban editarse.

El puntaje `observed-impact-v1` suma estos factores hasta 100:

| Factor | Peso máximo | Evidencia o contexto |
|---|---:|---|
| Símbolos afectados | 10 | Conteo observado; satura en 20. |
| Dependientes transitivos | 10 | Fuera de las declaraciones seleccionadas directamente; satura en 40. |
| API pública | 10 | Exports, endpoints y métodos públicos de clases exportadas. |
| Esquema | 10 | Artefactos SQL/Prisma/Proto/GraphQL en el alcance o dato del cambio. |
| Contratos | 10 | Interfaces/tipos expuestos en el alcance o dato del cambio. |
| Autorización | 10 | Contexto explícito; no se deduce solo del nombre del símbolo. |
| Concurrencia | 8 | Contexto explícito; `async` no basta para determinarla. |
| Efectos externos | 8 | Relaciones de efecto registradas o dato del cambio. |
| Persistencia | 8 | Relaciones `READS_FROM`/`WRITES_TO` o dato del cambio. |
| Brecha de cobertura | 8 | Proporción de líneas reportadas sin ejecutar, ponderada por cantidad de líneas. |
| Irreversibilidad | 4 | Dato explícito de reversibilidad. |
| Módulos | 4 | Dueños de archivos afectados; satura en cuatro. |

Una señal de exposición pública no demuestra un cambio incompatible. La fórmula es una heurística versionada de priorización, no probabilidad de defectos ni estimación calibrada de esfuerzo. `score.observed` suma los factores conocidos; `score.range.maximum` conserva el peso de los desconocidos y amplía los conteos si el recorrido se truncó. Un valor desconocido tiene `points: null`, no “riesgo cero”.

La cobertura solo contribuye si todos los archivos de código afectados tienen hash coincidente y `reported-lines-verified`; las rutas de tests conocidas se excluyen de ese denominador. Un recorrido truncado deja la cobertura global desconocida. Verificar líneas del LCOV no demuestra la vigencia de todo el build ni la calidad de sus assertions.

`--fact nombre=true|false` acepta `publicApiChange`, `schemaChange`, `contractChange`, `authorizationChange`, `concurrencyChange`, `externalEffects`, `persistenceChange` y `reversible`. Se marcan como datos aportados por quien consulta, sin convertirlos en hechos verificados. El workflow sugerido usa el puntaje observado: menos de 25, coder + reviewer; de 25 a 59, coder + cleaner + architect; desde 60, especificación y seis roles. Es provisional cuando faltan factores, hay fallback o datos incompletos. No lanza agentes ni tests.

Opciones comunes: `--db`, `--json`, `--max-depth` (12; 0–32), `--max-nodes` (500; 1–5000), `--max-edges` (2000; 1–20.000). `--limit` (20; 1–200) y `--offset` paginan independientemente cada categoría: símbolos, archivos, módulos, contratos, tests, efectos, riesgos, cobertura y relaciones. Cada una devuelve `total`, `items` y `nextOffset`; el score usa el recorrido acotado completo, no solo esa página. Los límites por cantidad no son un presupuesto de tokens.

Código: [impact.ts](../packages/change-analysis/src/impact.ts) y [recorrido compartido](../packages/change-analysis/src/graph.ts).

### 4.16 `trace`: caminos estáticos con evidencia

```bash
repolead trace 'POST /payments' OrderRepository.save --json
repolead trace 'POST /payments' persistOrder --max-paths 5 --max-depth 12 --json
repolead trace 'POST /payments' --json
```

Acepta nombres inequívocos o IDs exactos. Con destino, devuelve caminos mínimos hacia ese nodo; sin destino, busca relaciones de efecto registradas (`READS_FROM`, `WRITES_TO`, `EMITS`, `CONSUMES`). El recorrido BFS utiliza `CALLS` y esas relaciones; no trata imports ni referencias de tipos/callbacks como ejecución. Los ciclos no provocan un recorrido infinito y pueden devolverse varios caminos mínimos. Cada salto conserva analizador, confianza y ubicaciones de evidencia; no entrega el cuerpo de las funciones.

La confianza del camino es el mínimo de la mejor confianza registrada por salto; no es una probabilidad de ejecución. `unknowns` advierte sobre indexación incompleta, reflexión/despacho dinámico y relaciones no observadas. No se enumeran alternativas más largas ni se demuestra viabilidad de ramas, orden temporal o flujo de datos. Si no aparece un camino, no significa que sea imposible en runtime.

Usa las mismas opciones de recorrido que `impact`, más `--max-paths` (10; 1–100). Cada límite alcanzado se informa por separado. Los handlers Express importados con alias se enlazan usando la identidad SCIP y la posición exacta del argumento registrado. Una referencia a un parámetro que oculta una función del mismo nombre no crea una llamada a esa función.

El catálogo actual no clasifica automáticamente todos los sinks externos. Un método llamado `save` no prueba acceso a base de datos: puedes trazar hasta ese símbolo y revisar su evidencia; los efectos no registrados permanecen desconocidos. Para flujo de datos usa `dataflow` y `trace_flow engine=joern`; se describe en 4.20.

Código: [flow.ts](../packages/change-analysis/src/flow.ts). [Aceptación con SCIP, CLI compilada y MCP](../benchmarks/change-analysis-acceptance.json).

### 4.17 `hotspots`: dónde conviene investigar primero

```bash
repolead hotspots --json
repolead hotspots --module payments --limit 10 --offset 0 --json
```

Un hotspot es una función o método con señales medibles que justifican revisión. El comando consulta SQLite sin ejecutar tests ni llamar al modelo. Excluye símbolos de archivos reconocidos como tests; no deduce importancia de negocio por el nombre del archivo.

Opciones: `--db` (por defecto `.repolead/repolead.db`), `--module` (nombre, ruta o ID del módulo propietario exacto), `--offset` (0), `--limit` (10, entre 1 y 200) y `--json`. El filtro de módulo no incluye implícitamente sus submódulos; un nombre ambiguo exige ruta o ID. `nextOffset` permite continuar el ranking completo.

Un símbolo entra en el ranking si cumple al menos una condición: complejidad ciclomática ≥10, al menos cinco fuentes de referencia observadas, cinco cambios de su archivo en la ventana Git, o al menos la mitad de sus líneas reportadas sin cobertura verificable. No tener reporte no satisface la última condición.

El score `observed-hotspots-v1` combina cuatro multiplicadores entre 1 y 4:

| Factor | Medición | Saturación del multiplicador |
|---|---|---|
| Complejidad | Ciclomática del AST; cuerpos de funciones anidadas se miden aparte | 1 → 1; ≥20 → 4 |
| Fan-in | Fuentes distintas de referencias, incluidos callbacks; no solo llamadas | 0 → 1; ≥20 → 4 |
| Cambios | Commits que tocaron el archivo entre los últimos 500 commits del repo | 0 → 1; ≥20 → 4 |
| Brecha de cobertura | Fracción no cubierta de líneas reportadas dentro del símbolo | 0 → 1; 1 → 4 |

La fórmula es `100 × (raíz cuarta del producto − 1) / 3`, redondeada a dos decimales. Un factor desconocido usa 1 para el extremo inferior y 4 para el superior. Las referencias con indexación semántica incompleta también conservan incertidumbre. Se ordena por el extremo inferior: los símbolos con información incompleta pueden quedar debajo de otros mejor medidos. El score no es probabilidad de fallo ni estimación de esfuerzo.

La cobertura solo se acepta cuando el hash del archivo coincide y el importador verificó los checksums de las líneas reportadas. Un reporte antiguo, sin checksums o sin líneas dentro del símbolo produce `unknown`. El número de commits corresponde al archivo completo, no a cada función ni a una tasa anual. La cobertura no prueba la calidad de las aserciones. Este comando solo prioriza; `mutation --run` ejecuta Stryker con un plan derivado del ranking.

### 4.18 `opportunities`: convertir evidencia en trabajo revisable

```bash
repolead opportunities --json
repolead opportunities --module payments --limit 10 --json
```

Actualiza la proyección de oportunidades del snapshot y devuelve una página ordenada. Acepta las mismas opciones que `hotspots`. La regeneración abarca todo el snapshot antes de aplicar el filtro de lectura; no elimina las oportunidades de otros módulos.

Cada entrada deriva de un hallazgo `confirmed` con evidencia válida o de un hotspot. Conserva `sourceKind`, `sourceId`, módulo, prioridad y evidencia por archivo o módulo. Los candidatos sin juicio y los hallazgos rechazados no se presentan como oportunidades confirmadas. Los hallazgos sin evidencia ubicable se omiten con un contador explícito. El esfuerzo y el impacto de negocio permanecen desconocidos.

Para hallazgos se usa la severidad: `info=5`, `low=20`, `medium=45`, `high=75`, `critical=100`; la confianza se informa aparte. Los hotspots conservan su fórmula. Esta escala compartida es orientativa y no está calibrada entre ambas categorías. Un mismo problema puede tener una entrada de hallazgo y otra de hotspot; sus orígenes permiten distinguirlas, sin afirmar que sean dos defectos.

`scan`, `refresh`, la recolección de métricas y `audit` regeneran esta proyección. Una repetición con iguales entradas reutiliza la versión guardada. La publicación reemplaza únicamente las oportunidades de este generador y sus evidencias, en una transacción; conserva registros históricos y entradas de otros productores. La migración 13 agrega prioridad y procedencia a la tabla existente.

MCP consulta con `improvement_opportunities`; si cambiaron las entradas devuelve `stale` sin servir oportunidades antiguas. `get_evidence` acepta `opportunityId` únicamente vigente y respeta `--no-source`. Las evidencias de módulo conservan su procedencia sin intentar leer una carpeta como archivo. Estas consultas no hacen llamadas generativas. La proyección aún no forma parte del índice híbrido de `search`; se consulta mediante su herramienta específica.

Código: [prioritization.ts](../packages/change-analysis/src/prioritization.ts). [Aceptación con Git, SCIP, CLI y MCP](../benchmarks/prioritization-acceptance.json).

### 4.19 `mutation`: mutaciones dirigidas por hotspots

```bash
repolead mutation --module payments --limit 3 --json
repolead mutation --module payments --limit 3 --run --test-command 'node --test test/*.test.js'
repolead mutation --results --page-size 20
repolead mutation --module payments --report /ruta/mutation.json
```

Sin `--run` ni `--report` prepara el plan. Selecciona hasta tres hotspots JS/TS por defecto (1–20), con rangos exactos por función. Python, símbolos sin rangos y rutas incompatibles se omiten con motivos. `--run` exige `--test-command`: **ejecuta tests del proyecto** mediante Stryker `10.1.1`, Node ≥22. Usa configuración generada, sandbox propio, un worker, análisis de cobertura desactivado y salida JSON. No modifica los originales ni carga la configuración Stryker del proyecto. `--timeout-ms` limita el proceso (600.000 por defecto; máximo 3.600.000).

Verifica todos los archivos indexados antes y después de ejecutar, además de la vigencia/integridad del plan. Los artefactos quedan en `.repolead/mutation-runs/`. `--report` importa un reporte compatible sin ejecutar tests: exige fuente original con hash coincidente y mutantes dentro de las funciones seleccionadas. Mutantes externos marcados `Ignored` se cuentan aparte; cualquier otro estado fuera del alcance invalida el reporte. No puede verificar cuándo se ejecutaron los tests de un reporte externo.

La migración 14 guarda `mutation_reports` con origen, plan y resultado normalizado; no persiste código original ni reemplazos de mutantes en esa tabla. El score es `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`. Errores de compilación/runtime, ignorados y pendientes se informan por separado; denominador cero produce `null`. No demuestra ausencia de mutantes equivalentes ni corrección funcional completa.

`--results` consulta el snapshot actual; `--report-id`, `--offset` y `--page-size` (20; máximo 200) permiten paginar. MCP `mutation_results` ofrece la misma consulta sin ejecutar tests. No sirve resultados de otro snapshot. [Prueba real de Stryker](../benchmarks/mutation-acceptance.json): cuatro mutantes detectados, dos sobrevivientes, 66,67 %, originales intactos.

### 4.20 `dataflow`: flujo de datos opcional con Joern

Instala una distribución fijada de [Joern](https://github.com/joernio/joern/releases), verifica su checksum y configura `REPOLEAD_JOERN_BIN` con la ruta absoluta del launcher. La aceptación usa `4.0.666`; `doctor` verifica el intérprete y, si encuentra el JAR del núcleo, informa su versión declarada; no sustituye la verificación del checksum del instalador.

```bash
repolead dataflow entry sink --run --language javascript
repolead dataflow entry sink --language javascript
repolead dataflow entry sink --run --language python --max-paths 10
```

La primera forma construye un proyecto temporal solo con fuentes JS/TS o Python capturadas en SQLite. Ejecuta el frontend y `run.ossdataflow`, sin ejecutar los tests ni la aplicación. La consulta fija usa nombres exactos: parámetros explícitos de `entry` → argumentos explícitos de llamadas `sink`, mediante `reachableByFlows`. Los nombres son parámetros del script, no fragmentos Scala ejecutables. Se eliminan los temporales al terminar.

`--max-paths` va de 1 a 100 (10 por defecto); `--timeout-ms` de 1000 a 600.000 (300.000 por defecto). El input admite hasta 5000 archivos y 100 MiB; se reserva un heap de 2 GiB. El reporte conserva ubicaciones y hashes de archivo/línea, límites y advertencias; rechaza ubicaciones fuera de la fuente capturada. Se guarda por consulta y snapshot en metadatos SQLite. Sin `--run`, solo consulta el reporte previo.

MCP: `trace_flow {"engine":"joern","from":"entry","to":"sink","language":"javascript"}`. En modo multi-repo exige `repo`. Los límites `maxDepth`, `maxNodes` y `maxEdges` se rechazan en modo Joern; corresponden al grafo de llamadas. No lanza Joern; tras un refresh devuelve `not_available` hasta recalcular. `engine=graph` sigue siendo el recorrido de llamadas predeterminado. El flujo estático depende del frontend y la semántica de bibliotecas de Joern: no prueba alcanzabilidad runtime ni vulnerabilidades. Cero caminos tampoco demuestra ausencia de flujo. Véanse [data-flow steps](https://docs.joern.io/cpgql/data-flow-steps/), [scripts](https://docs.joern.io/interpreter/) y la [aceptación real JS/Python](../benchmarks/joern-acceptance.json).

## 5. MCP y conexión con agentes

### 5.1 Qué agrega MCP

MCP permite que el agente solicite herramientas estructuradas. Aquí todas las herramientas están diseñadas para consultar: no ofrecen `scan`, `refresh`, `analyze` ni escritura de código. Preparar y actualizar los datos sigue siendo responsabilidad de la CLI o de una automatización externa.

| Herramienta | Entrada principal | Respuesta y límites relevantes |
|---|---|---|
| `context_pack` | `mode?`, `query?`, `queries?`, `types?`, `includeTests?`, `symbols?`, `module?`, `maxTokens?`, `includeSource?`, `knownBlocks?`, `repo?` | `map`: navegación. `evidence`: búsqueda por lotes, fuente citada y memoria; `knownBlocks` permite reutilizar bloques conservados en la conversación. Ambos usan 120.000 tokens por defecto. Ambos admiten 256–120.000. |
| `repo_overview` | `repo?`, `audience?` (`technical` o `product`) | Conteos, contexto de la audiencia y URI del recurso; sin repositorio en modo múltiple lista los disponibles. |
| `module_context` | `module`, `repo?` | Dossier y previews de hallazgos confirmados del módulo. |
| `symbol_context` | `symbol`, `repo?` | ID o nombre inequívoco; ficha, firma, ubicación, métricas y hasta 20 relaciones por dirección, con aviso de truncamiento. |
| `find_callers` | `symbol`, `transitiveDepth?`, `repo?` | Recorrido por relaciones `CALLS`; profundidad 1 por defecto, máximo 5. |
| `find_references` | `symbol`, `includeDefinitions?`, `limit?`, `offset?`, `repo?` | Referencias SCIP con líneas desde 1 y columnas UTF-16 desde 0, fin exclusivo. Páginas de 50, máximo 200, con `nextOffset`. Incluye estado del indexador y avisa si no se mapeó la definición. |
| `impact_analysis` | `change?`, `symbols?`, `paths?`, `facts?`, límites de recorrido, `limit?`, `offset?`, `repo?` | Alcance potencial, score con incertidumbre y workflow provisional. Detalles paginados, sin modelo generativo. |
| `trace_flow` | `engine?`, `language?`, `from`, `to?`, `maxDepth?`, `maxNodes?`, `maxEdges?`, `maxPaths?`, `repo?` | Caminos mínimos de llamadas/efectos registrados, con evidencia por salto y límites explícitos. |
| `mutation_results` | `reportId?`, `offset?`, `limit?`, `repo?` | Reporte Stryker normalizado del snapshot actual; nunca ejecuta tests. |
| `hotspots` | `module?`, `limit?`, `offset?`, `repo?` | Ranking de funciones/métodos con factores, procedencia e incertidumbre. Páginas de 10, máximo 200. |
| `improvement_opportunities` | `module?`, `limit?`, `offset?`, `repo?` | Oportunidades persistidas desde hallazgos y hotspots; rechaza proyecciones desactualizadas. |
| `architecture_findings` | `severity?`, `module?`, `repo?` | Solo hallazgos confirmados; severidades como arreglo, por ejemplo `["high"]`. |
| `get_evidence` | `evidenceId?`, `documentId?`, `findingId?`, `opportunityId?`, `path?` o `ranges?`, `maxTokens?`, líneas, `repo?` | Procedencia o fuente. `ranges` agrupa hasta 20 rangos con un presupuesto global de 120.000 tokens por defecto. `path` también solicita hasta EOF si no se indica `endLine`. |
| `search` | `query`, `limit?`, `type?`, `language?`, `module?`, `kind?`, `repo?` | Código, resúmenes, documentos, hallazgos y tests. Devuelve IDs, ubicaciones y recursos; informa degradación de servicios. |

Hay 14 herramientas MCP. El presupuesto de `context_pack` no se aplica a todas las otras herramientas. Por ejemplo, una consulta de muchos hallazgos o callers puede producir una respuesta más grande. Las lecturas vinculadas a hallazgos limitan cada rango; ese límite no incluye todo el JSON de una colección de evidencias.

Para leer implementación extensa, agrupa las fuentes necesarias en una llamada:

```json
{
  "ranges": [
    {"path": "src/service.ts"},
    {"path": "src/repository.ts", "startLine": 40, "endLine": 180}
  ],
  "maxTokens": 12000
}
```

`get_evidence ranges` cuenta todo el texto devuelto, incluidos encabezados, hashes, líneas y avisos, dentro de `maxTokens` (256–120.000; proxy `o200k_base`). Omitir `endLine` solicita hasta el final del archivo. No tiene el antiguo corte fijo de 200 líneas: sirve rangos en orden hasta agotar el presupuesto y conserva coordenadas para continuar. Una línea que no cabe queda omitida, nunca se presenta como completa. Se puede ampliar también una lectura individual con `path`, líneas y `maxTokens`. El modo agrupado no se combina con otros selectores; respeta `--no-source`, repositorio explícito cuando es ambiguo y hashes del snapshot. Una fuente modificada después del índice se rechaza y exige `refresh`.

Además de herramientas, el servidor publica recursos MCP de los niveles símbolo, archivo, módulo y repositorio, más documentos y contexto de producto. Los documentos originales también pueden leerse por `get_evidence documentId=...` desde SQLite, incluso con `--no-source`, con rangos paginados. El cliente puede listar los recursos y leer sus URIs para obtener conocimiento ya generado, sus IDs de evidencia e incertidumbres. Las URIs resuelven contra el snapshot actual: si todavía no tiene ese análisis, se devuelve un error en vez de entregar un dossier antiguo. Esto permite consumir contexto precalculado, pero no fuerza su carga automática en todas las conversaciones.

Con varios repositorios, `context_pack`, `impact_analysis`, `hotspots`, `mutation_results`, `improvement_opportunities` y `get_evidence` por ruta exigen seleccionar `repo`. `search` y `architecture_findings` pueden agregar resultados. Las herramientas de símbolo/módulo intentan resolver el repositorio cuando el objetivo pertenece a uno solo; `trace_flow` usa su origen para esa resolución. Los nombres ambiguos producen un error con alternativas. No se trazan relaciones entre bases independientes.

En modo `map` (predeterminado por compatibilidad), una consulta MCP `context_pack` con solo `query` busca primero hasta tres símbolos mediante búsqueda híbrida, sin reranker en esa ruta, y los usa como objetivos. Con `symbols` o `module`, construye directamente el contexto. El motor compartido usa selección léxica y de grafo si necesita elegir objetivos sin resultados de búsqueda. Para responder una pregunta de varias partes, `mode=evidence` admite `queries` con hasta ocho subconsultas y devuelve evidencia bajo un presupuesto común; pasar `queries` también activa este modo. `includeSource` es verdadero por defecto en evidencia y siempre respeta `serve --no-source`. La cobertura informada cuenta bloques recuperados, no demuestra que todas las partes de la pregunta estén resueltas.

### 5.2 Conectar Codex

Registra el comando real usando rutas absolutas:

```bash
codex mcp add repolead -- bun /ruta/a/repolead/apps/cli/src/index.ts serve --db /ruta/a/mi-proyecto/.repolead/repolead.db
codex mcp list
```

Si Bun no está en el `PATH` del cliente, usa también su ruta absoluta. Abre una sesión nueva de Codex y revisa `/mcp` en la interfaz de terminal. La configuración MCP se almacena normalmente en `~/.codex/config.toml`; también existe configuración por proyecto. Consulta la [documentación oficial de OpenAI sobre MCP en Codex](https://developers.openai.com/es-419/docs/extend/mcp?surface=cli) para las opciones del cliente.

Ejemplo de petición al agente:

> Usa RepoLead `context_pack` para ubicar la autenticación con `maxTokens=2000`. Comprueba las omisiones. Después pide el código completo de los símbolos relevantes y amplía el presupuesto si no caben. Verifica las dependencias antes de proponer un cambio.

El servidor recomienda ese flujo en sus instrucciones MCP, pero no obliga al agente a seguirlo.

### 5.3 Otros clientes y varios repositorios

El comando de registro que imprime `onboard` para Claude Code tiene esta forma:

```bash
claude mcp add repolead -- bun /ruta/a/repolead/apps/cli/src/index.ts serve --db /ruta/a/mi-proyecto/.repolead/repolead.db
```

Para un directorio de proyectos ya indexados, sustituye `--db ...` por `--dir /ruta/a/proyectos`. El proceso necesita permisos de lectura de las bases y de las fuentes que vaya a servir. Revisa permisos de escritura si el driver necesita abrir SQLite y sus archivos auxiliares.

## 6. Presupuestos de tokens y medición

### 6.1 Qué significa el presupuesto de 120.000

120.000 es el máximo y valor predeterminado del **texto devuelto por una llamada de contexto**, contado con `gpt-tokenizer` y la codificación `o200k_base`. No es la ventana total del agente ni el presupuesto de toda una conversación.

También es el presupuesto predeterminado por paquete para generar memoria técnica, documentos y contexto de producto. El límite de fuente por paquete pasa a 100.000 líneas, siempre subordinado al presupuesto de tokens. Los bloques recuperados reparten ese presupuesto sin el antiguo tope fijo de 1.200 tokens por bloque. `maxTokens`/`--tokens` y `--context-tokens` permiten reducirlo explícitamente. El cambio no altera el máximo de salida del proveedor ni evita sus límites de contexto.

Los modelos de embeddings y reranking tienen una ventana nativa de 32K por entrada/par, independiente del paquete agregado de 120K. RepoLead recupera múltiples registros y los reúne para el agente. No intenta enviar 120K a un único embedding ni recorta en silencio una entrada demasiado grande: informa la omisión y conserva la búsqueda léxica. En Ollama, el máximo local de 131.072 posiciones reserva además espacio para esquema, instrucciones y salida; el guard de bytes es conservador y puede rechazar antes de ese máximo.

La selección conserva unidades de código y referencias. No hay un modelo que reescriba el código para “comprimirlo”; se omite información menos prioritaria y se informa de ello. Los conteos `symbols X/Y` y `relations X/Y` describen el ámbito candidato seleccionado, no un porcentaje de cobertura de todo el repositorio.

El presupuesto no rellena el contexto ni garantiza ahorro: devuelve únicamente evidencia seleccionada que cabe. Para tareas pequeñas puedes reducirlo explícitamente; los siguientes valores son opciones, no los defaults:

| Tarea | Presupuesto inicial orientativo | Qué revisar |
|---|---|---|
| Ubicar una función o un módulo | 2000 | Que el objetivo sea el correcto y aparezca su ubicación. |
| Entender una función con dependencias | 4000–8000 | Que entren el cuerpo completo y las dependencias necesarias. |
| Investigar varios módulos | Consultas separadas o presupuesto mayor | Que los límites de módulo y selección no oculten partes del flujo. |

Un presupuesto mayor no expande automáticamente el alcance semántico: un contexto filtrado a un módulo sigue filtrado, y la vecindad de símbolos sigue siendo inmediata. Para un flujo transversal, consulta otros objetivos o herramientas.

El aumento adaptativo del presupuesto **no está automatizado** en RepoLead. Lo decide quien llama o el agente cliente. Una respuesta más pequeña que obliga a realizar muchas consultas puede costar más en total.

### 6.2 Presupuesto de análisis: otra cosa distinta

`--context-tokens 4000` limita la evidencia por petición, no el número de análisis ni sus salidas. En modo `files`, las llamadas mínimas son secciones completas de archivos + síntesis de archivos divididos + módulos + un brief; las síntesis jerárquicas y reintentos pueden añadir llamadas. En modo `symbols`, se añaden las fichas individuales. Documentos y contexto de producto tienen sus propias llamadas. Revisa `analyze --dry-run` antes del alta de un proyecto grande. El [plan de access-service](../benchmarks/file-mode-plan.json), calculado en lectura sola, pasa de 6.664 tareas exhaustivas a un mínimo de 880 tareas por archivo y cubre 78.459 líneas de fuente. Es una reducción del plan base del 86,8 %, no una medición equivalente de tiempo o calidad.

La [comprobación con Ollama real](../benchmarks/file-mode-acceptance.json) verificó permiso `access.create`, obligatoriedad y longitud de un campo, edad mínima, mensajes, estados literales y evento de auditoría en una fixture pequeña. La repetición de `refresh` añadió cero llamadas. La primera salida omitió los estados literales y motivó una corrección del prompt; los mensajes se comprobaron también en la lista de errores del dossier, sin exigir que se duplicaran en `productFacts`. Esta comprobación no demuestra equivalencia de calidad universal ni mide la duración completa de WLT.

La selección intenta reservar aproximadamente una cuarta parte del espacio para relaciones y otros metadatos, evitando dedicar todo a firmas. Ese reparto es heurístico; el límite total sí se comprueba. Las relaciones cuyos extremos quedaron fuera también cuentan como omitidas.

Los antiguos topes predeterminados de 50 símbolos y 200 relaciones se sustituyeron por este presupuesto. Los topes por cantidad siguen disponibles como opciones de la biblioteca, no como flags actuales de la CLI.

### 6.3 Qué demuestra el benchmark incluido

El [reporte guardado](../benchmarks/token-results.json) contiene cinco casos sobre RepoLead:

| Medición agregada | Tokens |
|---|---:|
| Archivos relevantes completos | 6016 |
| Contexto con cuerpos objetivo completos | 4424 |
| Ahorro | 1592, equivalente a 26,5 % |

Los cinco cuerpos solicitados entraron completos. Un caso consumió 1,2 % más, porque el mapa y sus metadatos pueden superar el ahorro de recortar un archivo pequeño.

Estos son conteos de `o200k_base`, no facturación exacta de Astra, Fable u otro modelo. No miden descubrimiento de símbolos, historial de conversación, esquemas MCP, razonamiento, salida, caché del proveedor, costo de alta ni calidad de la respuesta final. Tener los cuerpos completos no demuestra que la evidencia sea suficiente para cualquier pregunta.

`mapOnlyTokens` mide navegación sin fuente; no es una comparación equivalente a entregar código completo. El reporte incluye hashes del contenido medido. Nuevos snapshots, cambios de fuente o de formato pueden variar los conteos, incluso si el SHA de `HEAD` no cambia.

Detalles de diseño y atribución: [CONTEXT.md](../CONTEXT.md). La selección se inspira en Aider y la invalidación/reutilización en CocoIndex, con implementación independiente; `gpt-tokenizer` sí es una dependencia directa. No se incorporaron sus proyectos completos.

### 6.4 Sesiones reales: ahorro, costo inicial y límites

Se compararon sesiones de Claude Code con Sonnet 5 y operaciones auxiliares Haiku, usando la misma pregunta, fuente y esquema de respuesta dentro de cada comparación. Los números son totales reportados por el SDK, incluyendo entrada en caché, salida, operaciones auxiliares y reintentos de formato; no son una factura ni una medición de Astra/Fable.

La [corroboración con memoria precargada](../benchmarks/preloaded-savings-corroboration.json) usa el módulo real completo `adapters/git`: ocho fichas de símbolos, dos de archivos y una de módulo, generadas con Haiku y `batchSize: 1`. Se fijaron tres preguntas antes de ejecutar los modelos; cada pareja compara lectura directa con MCP sobre una captura idéntica, excluyendo scripts y resultados de evaluación. El orden alterna manual/MCP, MCP/manual y manual/MCP. No se impuso un mínimo de lecturas ni un máximo artificial de longitud de respuesta.

| Pregunta | Tokens manuales | Tokens MCP | Reducción con MCP |
| --- | ---: | ---: | ---: |
| Archivos versionados y cambios | 23.786 | 18.264 | 23,2 % |
| Cálculo de co-cambios | 16.149 | 16.675 | −3,3 % |
| Autoría, fechas y commits grandes | 26.161 | 20.367 | 22,1 % |
| **Total de consultas** | **66.096** | **55.306** | **16,3 %** |

Los hechos solicitados y sus citas se contrastaron con el código en ambos brazos. Las seis respuestas usaron un único intento de salida estructurada, sin errores de herramientas registrados. Cada consulta MCP recibió memoria y código pertinente en una llamada `context_pack`; esta medición no separa cuánto aporta la memoria y cuánto la extracción de fuente, ni valida todas las afirmaciones de los dossiers. El reporte conserva una nota de precisión: la explicación manual de historial abrevia los separadores del argumento `--format`, sin alterar los hechos solicitados.

**Hubo menos tokens de consulta, pero mayor costo estimado:** USD 0,218253 con lectura directa frente a USD 0,313251 con MCP (+43,5 %). La composición explica por qué no deben confundirse ambos indicadores:

| Categoría del SDK | Manual | MCP |
| --- | ---: | ---: |
| Entrada sin caché | 2.158 | 2.229 |
| Escritura de caché | 21.312 | 36.237 |
| Lectura de caché | 37.447 | 10.771 |
| Salida | 5.179 | 6.069 |

Preparar la memoria consumió **144.114 tokens**, USD 0,314480 estimados y unos 293 segundos; repetir el análisis sin cambios hizo **cero llamadas**. Preparación más las tres consultas suma **199.420 tokens y USD 0,627731**, frente a 66.096 y USD 0,218253 en lectura directa. El índice local se mide aparte mediante tiempos y conteos, sin atribuirle un cargo remoto. La proyección aritmética de amortización por cantidad de tokens es 41 consultas si persiste el promedio observado; no se ejecutaron 41 consultas, combina preparación Haiku con consultas Sonnet y **no existe amortización económica con los costos observados**. Son tres preguntas de un módulo pequeño, sin intervalo de confianza ni garantía para otros repositorios.

Para repetir esta corroboración, con los servicios de embeddings/Qdrant/reranking disponibles y Claude Code autenticado:

```bash
bun run build
REPOLEAD_ACCEPTANCE_MODEL=sonnet REPOLEAD_PREPARATION_MODEL=haiku \
  bun scripts/verify-preloaded-savings.ts --real
```

El script conserva captura, manifiesto, memoria, llamadas, resultados de herramientas y uso en `.repolead/acceptance/workflow-*/.repolead/corroboration`; escribe el reporte agregado en `benchmarks/preloaded-savings-corroboration.json`. Una nueva ejecución deja la revisión de explicaciones pendiente hasta contrastarlas con la fuente. No almacena bloques de razonamiento del modelo. Las mediciones anteriores también se conservan:

| Caso | Lectura manual | RepoLead MCP | Resultado |
| --- | ---: | ---: | --- |
| [Código de RepoLead con SCIP](../benchmarks/repo-workflow-acceptance.json), perfil `context`, sin dossiers generativos previos | 605.674 | 235.292 | 61,2 % menos tokens |
| [Fixture pequeña con contexto técnico/producto precargado](../benchmarks/token-workflow-acceptance.json), perfil `context` y flujo guiado | 26.713 | 56.927 | 113,1 % más tokens |

La primera comparación verifica doce hechos, incluida invalidación de dependencias, síntesis superiores y producto, y conserva una revisión contra fuentes. Hubo tres intentos de salida estructurada en el brazo manual y dos con MCP; sus costos permanecen incluidos. El [reporte original](../benchmarks/repo-workflow-cascade-raw.json) conserva el fallo inicial de un chequeo demasiado literal: rechazaba la explicación manual por decir «padre/nivel superior» sin nombrar literalmente archivo y módulo. Se corrigió ese chequeo de sinónimos tras contrastar la explicación con el código, sin modificar respuestas ni conteos. Son ejecuciones individuales, con variación de modelo y caché; no aíslan causalmente cada optimización. Estas primeras copias incluían artefactos de evaluación dentro del repositorio consultable, una posible contaminación. La comparación nueva usa `capture-workflow.ts` para excluir resultados y scripts de evaluación de ambos brazos y conserva la copia y su manifiesto.

La [comparación con captura limpia y modo evidencia](../benchmarks/repo-workflow-evidence.json) usó 737.073 tokens manuales frente a 724.296 con MCP (1,73 % de diferencia bruta). **No pasó la aceptación**: la respuesta MCP omitió el mecanismo por el que una dependencia modificada invalida una ficha de su llamador y no explicó la excepción de coordenadas absolutas en el texto cacheado. Ambos brazos excluyeron resultados/scripts de evaluación, usaron la misma fuente y esquema, y contaron los reintentos de formato (tres manuales, dos MCP). No se presenta esa diferencia como ahorro con calidad equivalente.

En la fixture pequeña, preparar inicialmente la memoria consumió 563.146 tokens remotos y 1762 locales; actualizarla tras un cambio consumió otros 163.511 remotos. Repetir el análisis sin cambios hizo cero llamadas. La generación inicial tardó unos 10,6 minutos y la actualización generativa 6,5 minutos; el `refresh` determinista tardó 327 ms. Como la consulta con MCP fue más cara que la directa, esa ejecución no tiene punto de amortización. La preparación de memoria puede ser útil por persistencia, evidencia y vistas de producto, pero este caso no prueba ahorro económico.

El [catálogo MCP reducido](../benchmarks/mcp-catalog-acceptance.json) pasa de 2868 a 1121 tokens `o200k_base` en el JSON de `tools/list`, un 60,9 % menos **solo en esquemas**. La lectura agrupada evita cortes artificiales de 200 líneas y permite pedir rangos completos con un presupuesto compartido. Ninguna de estas mejoras garantiza un porcentaje de ahorro en todas las tareas.

El roadmap tiene **21 de 22 puntos completos** según su alcance y comprobaciones acotadas. Queda abierto el criterio de responder con menos del 10 % de los tokens de exploración manual: la corroboración nueva usó el 83,7 % en consultas y más al incluir la preparación. La ejecución histórica del repositorio usó el 38,8 %, con las limitaciones indicadas arriba. Se conservan también las mediciones [anteriores sin ahorro](../benchmarks/repo-workflow-before.json), la [comparación preliminar con explicación incompleta](../benchmarks/repo-workflow-batched.json) y la [fixture pequeña sin flujo guiado](../benchmarks/token-workflow-before.json).

## 7. Arquitectura interna

### 7.1 Mapa de componentes

```text
Git + archivos del proyecto
        │
        ▼
adapters/                 Git, Tree-sitter, TypeScript, Python, SCIP
        │ hechos
        ▼
packages/code-graph        coordina scan y refresh
        │
        ▼
packages/knowledge-store   SQLite + FTS5, fuente de verdad indexada
        ├───────────────────────────────┐
        ▼                               ▼
packages/retrieval                 packages/lead-analyzer
 búsqueda + contexto                evidencia → Claude → resúmenes
        │                               │
        ├─ TEI embeddings               │
        ├─ Qdrant                       ▼
        └─ Reranker local          SQLite
                                        ▲
packages/policy-engine ─ detectores → juez → hallazgos + evidencia
packages/change-analysis ─ impacto + caminos estáticos + scoring explicable

apps/cli                  operaciones explícitas y consultas de terminal
apps/mcp-server           consultas stdio / HTTP para agentes
packages/domain           contratos, entidades e identidades compartidas
```

Qdrant es un índice derivado, no la autoridad para archivos, relaciones o resúmenes. Se reconstruye desde el conocimiento y la fuente textual guardados en SQLite. Se conserva contenido de archivos reconocidos de hasta 1 MiB, no una copia integral del repositorio ni sus binarios. El análisis y reindexado usan esa captura; las herramientas que solicitan fuente actual todavía comprueban el árbol de trabajo.

### 7.2 Extracción y construcción del grafo

Tree-sitter proporciona estructura sintáctica. Los adaptadores la convierten en símbolos, imports/exports, tests y rutas Express/Nest/FastAPI. El coordinador asigna IDs y persiste los resultados. Los offsets y columnas UTF-16 permiten separar dos funciones escritas en una misma línea sin mezclar sus cuerpos. Los tests modernos conservan el cuerpo completo para búsqueda; registros antiguos sin rango necesitan `refresh`.

Las exportaciones guardan nombre público, nombre local, módulo de origen, condición de tipo y símbolo resuelto cuando existe. Se reconocen declaraciones y aliases ESM, reexports, bindings CommonJS y declaraciones públicas Python con `__all__` literal. Los comodines y namespaces no se convierten en un único símbolo ficticio; un `__all__` dinámico se informa como no resuelto. Esto no cubre todas las exportaciones construidas en ejecución.

Las rutas registran framework, método, path declarado y handler nombrado cuando se reconoce. Nest combina prefijos literales de `Controller` con decoradores HTTP importados de Nest. Express admite factories, aliases y cadenas `route(...).get(...)`. No se infieren prefijos globales ni montajes dinámicos; las declaraciones dinámicas reconocidas se diagnostican.

SCIP añade referencias entre definiciones que se pueden mapear a los símbolos propios. La implementación cruza ruta, nombre y rango exacto, normaliza columnas y relaciona cada referencia con el contenedor más interno. Conserva también imports fuera de funciones, referencias recursivas y ubicaciones repetidas; las coincidencias ambiguas no se resuelven arbitrariamente.

Una referencia resuelta se clasifica como `CALLS` solo cuando coincide con una invocación identificada por el AST. Guardar una función como callback produce una dependencia, no una llamada directa. La sintaxis distingue `EXTENDS` de `IMPLEMENTS`, incluso al implementar una clase. Esto describe estructura estática, no una traza de ejecución. `find_references` pagina las ubicaciones y `doctor --db ... --json` expone los desacuerdos; no disponer de definición SCIP no prueba ausencia de referencias.

Las relaciones llevan analizador, confianza y evidencia. Los tipos definidos en `domain` expresan un vocabulario amplio; que exista un tipo como `READS_FROM` no significa que los adaptadores actuales lo produzcan para cualquier lenguaje.

Los módulos se deducen de manifiestos y directorios con barrels `index.*` que reexportan otros módulos; `.repolead.yaml` puede declararlos explícitamente. La propiedad de un archivo se asigna al módulo más específico, evitando duplicar todos los símbolos de paquetes hijos en el dossier del padre. Si no se identifica otro límite se utiliza el módulo raíz.

`bun run verify-deterministic` compara las referencias de 20 funciones con el servicio de lenguaje de TypeScript, comprueba la paginación MCP y los diagnósticos de la CLI compilada, y verifica un inventario de símbolos del propio RepoLead. El [reporte](../benchmarks/deterministic-acceptance.json) declara el alcance y sus limitaciones; no sustituye la aceptación completa de SCIP para Python.

### 7.3 Búsqueda híbrida, paso a paso

1. **FTS5:** obtiene candidatos por título, ruta y contenido completo de los elementos de conocimiento.
2. **Vectores:** convierte la consulta en embedding, con instrucción de recuperación para Qwen, y filtra por repositorio, snapshot, revisión de modelo y filtros solicitados. Los hits se validan contra el contenido/hash de SQLite.
3. **Grafo:** prioriza candidatos que reciben más referencias, excluyendo `CONTAINS`; no hace una exploración semántica ilimitada.
4. **Fusión RRF:** combina posiciones de ranking con constante `60`, pesos `1` para texto/vectores y `0.5` para grafo.
5. **Cobertura de términos:** añade una bonificación cuando coinciden varias palabras de la consulta.
6. **Reranking:** sobre hasta 20 candidatos por defecto, si el servicio está disponible.
7. **Salida:** devuelve los primeros resultados, 8 por defecto.

El contexto compacto usa otro ranking: coincidencias directas y semillas explícitas más un PageRank personalizado, con 20 iteraciones y amortiguación `0.85`. Ignora `CONTAINS` para no confundir pertenencia con uso. El número de tokens se comprueba durante la construcción del texto.

Si un servicio está ausente o falla durante la búsqueda, se conservan las señales disponibles. `query` y MCP `search` informan la degradación; una respuesta inválida del reranker también conserva el ranking fusionado. Los fallos de SQLite y errores de argumentos siguen siendo errores. El reindexado no aplica esta degradación: una avería de servicio interrumpe la sincronización.

### 7.4 Análisis de abajo hacia arriba

El flujo generativo es:

```text
fuente y relaciones → fichas de símbolos
fichas → dossiers de archivos → dossiers de módulos → brief JSON
```

Los esquemas de salida organizan propósito, entradas/salidas, efectos, invariantes, errores, responsabilidad, API pública y riesgos según el nivel. La síntesis intercala secciones de los dossiers hijos para que un dossier grande no oculte todos los demás. Si no cabe todo, registra omisiones. Las referencias desconocidas se rechazan antes de persistir la interpretación; eso valida la procedencia, no demuestra automáticamente la verdad semántica de cada conclusión.

La API directa configura una salida estructurada y un máximo de salida propio; el Agent SDK solicita JSON estructurado con herramientas desactivadas y hasta tres turnos. Ninguno de esos valores convierte `--context-tokens` en un techo de facturación. Los campos de uso reportados suman también las categorías de entrada asociadas a caché cuando el proveedor las entrega. El SDK aporta totales por modelo para el pipeline, incluidas sus operaciones auxiliares; RepoLead los suma sin volver a añadir el contador general. Su costo estimado no equivale a un cargo de la suscripción. La evaluación de auditoría registró 224 209 tokens de entrada, 7 788 de salida y USD 1,372743 estimados por el SDK; no demuestra ahorro de una conversación completa.

### 7.5 Detectores y juez no cumplen el mismo papel

Los detectores producen candidatos reproducibles a partir del índice. Las policies declaran versión, evidencia requerida, detectores, parámetros, severidad y pregunta para el juez. El juez interpreta los candidatos; no ejecuta las pruebas del repositorio ni demuestra formalmente una violación.

La implementación registra únicamente candidatos con evidencia. Los rechazados por el juez no se guardan como findings en este flujo. Los confirmados conservan su evidencia, pero el estado `confirmed` significa “confirmado por este proceso”, no certeza absoluta.

### 7.6 Qué significan las métricas

| Origen | Mediciones | Alcance |
|---|---|---|
| Tree-sitter | LOC físicas, código, blancos, comentarios; complejidad ciclomática; estimación cognitiva; anidación; catches vacíos | TS/JS/Python. Las decisiones de funciones anidadas no se cargan a su función contenedora. La complejidad se omite si hay errores sintácticos. |
| Grafo observado | Fan-in/out de símbolos, acoplamiento entre módulos y con destinos externos, inestabilidad, componentes de archivos | Deduplica referencias y excluye autorrecursión. Sin SCIP no prueba ausencia de llamadas. La conectividad es una señal de cohesión, no una medida semántica definitiva. |
| jscpd | Bloques exactos y unión de líneas participantes por archivo | Perfil estricto: mínimo 5 líneas y 50 tokens; TS/JS/TSX/JSX/Python. La unión de líneas no es el porcentaje global del reporte de jscpd. |
| Ruff | Incidencias por regla y conteo por archivo Python | Perfil aislado `E9,F,B`, sin correcciones ni configuración del proyecto. |
| Radon | Complejidad por bloque Python y métricas raw de archivo | API instalada en Python aislado; se conserva su identidad de analizador, sin mezclar sus definiciones con Tree-sitter. |
| LCOV | Cobertura de líneas/ramas por archivo y líneas reportadas dentro de cada símbolo | Reporte externo; no ejecuta tests. No se asigna 0 % a archivos ausentes. |

La complejidad ciclomática propia parte de 1 y añade decisiones como ramas, bucles, capturas y operadores lógicos. La estimación cognitiva añade penalización por anidación; no se declara equivalente a Sonar. LOC usa comentarios del AST para no confundir una URL o cadena con un comentario; los docstrings Python siguen siendo código en esta métrica. Radon conserva sus métricas raw por separado.

Integramos las herramientas existentes mediante adaptadores, sin copiar sus motores. Referencias de formato/semántica: [JSON de jscpd](https://jscpd.dev/reference/reporters/json), [Ruff](https://docs.astral.sh/ruff/configuration/), [métricas Radon](https://radon.readthedocs.io/en/stable/intro.html) y [LCOV](https://github.com/linux-test-project/lcov/blob/master/docs/man/geninfo.rst).

## 8. Datos, identidad e invalidación

### 8.1 Qué persiste SQLite

| Grupo | Tablas principales | Uso |
|---|---|---|
| Identidad y tiempo | `repositories`, `snapshots` | Proyecto y captura indexada. |
| Hechos | `files`, `modules`, `symbols`, `edges`, `tests`, `metrics` | Código extraído, relaciones y señales Git. |
| Calidad y cobertura | `quality_issues`, `quality_report_cache`, `coverage` | Diagnósticos externos, caché de reportes, líneas ejecutadas, hashes y procedencia del reporte. |
| API y referencias | `exports`, `symbol_references` | Bindings exportados y cada ubicación resuelta por SCIP; los spans exactos y rutas se guardan junto a símbolos/tests. |
| Interpretación | `summaries`, `analysis_runs` | Dossiers, brief, claves de caché y uso reportado. |
| Procedencia de resúmenes | `evidence_records`, `summary_evidence` | Referencias por contenido y enlaces entre evidencia suministrada y resúmenes, conservados al reutilizar caché. |
| Documentación de producto | `documents`, `documents_fts` | Texto versionado, título, hash y búsqueda textual, disponibles desde la base sin montar el repo. |
| Incrementalidad | `file_extractions`, `snapshot_metadata` | Caché sintáctica por archivo/hash/versión y configuración aplicada a cada snapshot. |
| Auditoría | `findings`, `evidence` | Hallazgos y referencias que los respaldan. |
| Priorización | `opportunities`, `snapshot_metadata`, `evidence` | Ranking derivado por snapshot, productor, hash de entradas, factores y referencias al hallazgo o símbolo original. |
| Juicios de policies | `policy_judgments`, `finding_judgments` | Caché de veredictos, versión/hash de policy, candidato y razonamiento asociado al hallazgo. |
| Fuente por snapshot | `source_blobs`, `file_sources` | Texto inmutable deduplicado por hash y vinculado a cada archivo/captura. |
| Recuperación unificada | `knowledge_items`, `knowledge_fts`, `vector_index_leases` | Proyección reconstruible de todas las clases de conocimiento, FTS5 y exclusión de indexadores concurrentes. Los FTS anteriores siguen disponibles. |

`metrics --coverage` importa cobertura y `opportunities` materializa sugerencias determinísticas con evidencia. Las oportunidades incluidas dentro de dossiers siguen siendo contenido generado de esos resúmenes, separado de esta proyección.

El historial Git se limita a los últimos 500 commits. Para co-cambios excluye commits de más de 30 archivos, exige al menos tres coincidencias y conserva hasta 50 pares. Son heurísticas de señal histórica, no dependencias semánticas demostradas.

Código: [migrations.ts](../packages/knowledge-store/src/migrations.ts), [store.ts](../packages/knowledge-store/src/store.ts) y [adaptador Git](../adapters/git/src/index.ts).

### 8.2 Identidad estable no significa contenido inmutable

El ID de un símbolo se deriva del repositorio, ruta, tipo, nombre cualificado y firma. No utiliza su número de línea. Mover líneas sin cambiar esos componentes puede conservar el ID; renombrar, mover de archivo o cambiar la firma puede cambiarlo.

Separadamente, el hash de contenido permite detectar modificaciones del cuerpo. Los datos se asocian a snapshots para distinguir capturas. Los comandos no ofrecen actualmente una política automática de retención/purga de snapshots.

### 8.3 Dos cachés distintas

**Resúmenes:** el paquete contiene una huella de archivos propios, cuerpos de símbolos, relaciones incidentes y dependencias identificadas, incluso evidencia que no entró en el prompt. Luego se combina el paquete con la versión de política de análisis, prompt y nombre del modelo para buscar un resumen reutilizable. Los dossiers hijos y sus referencias forman parte de las entradas de los niveles superiores.

Así, cambiar el cuerpo de un símbolo omitido puede invalidar el análisis aunque su firma no haya cambiado. Un módulo padre no necesita duplicar todos los cuerpos de sus hijos para rastrear su propia evidencia. La síntesis puede permanecer cacheada si los dossiers resultantes no cambian.

El contenido de dependencias salientes participa hasta `max_reanalysis_depth`; las relaciones entrantes conservan su estructura, pero editar el cuerpo de un consumidor no invalida automáticamente una dependencia intacta. Los ciclos se recorren sin repetir sujetos. Una reubicación de un símbolo sin cambios semánticos reutiliza su ficha y reasigna los IDs de evidencia a las nuevas coordenadas; las evidencias históricas permanecen intactas. La migración 15 guarda el orden de esos IDs en `summary_cache_bindings`. Se vuelve a analizar si cambia la evidencia semántica o si el texto cacheado contiene referencias reconocibles a líneas absolutas. Los dossiers de archivo y superiores pueden regenerarse porque cambió el archivo. Restaurar una configuración/modelo/policy anterior vuelve a publicar el resultado cacheado correspondiente como dossier actual, sin entregar por error la interpretación más reciente de otra configuración.

**Embeddings:** la caché depende del texto completo enviado y de la identidad de TEI. Un cambio solo en el cuerpo ahora invalida su vector. Una actualización del snapshot sin cambios de contenido reutiliza el embedding y actualiza solo los metadatos necesarios.

Una identidad de modelo basada en un nombre mutable no equivale a pesos fijados. Para embeddings se exige información de revisión (`model_sha`) antes de reutilizar; para análisis la clave sigue usando el nombre del modelo.

### 8.4 Fuente exacta y frescura

Para leer fuente, `readIndexedSource` comprueba que:

1. La ruta real permanezca dentro del repositorio, incluidos enlaces simbólicos.
2. El archivo esté indexado en el snapshot.
3. No exceda 1 MiB.
4. El hash actual coincida con el registrado.

Si el código cambió, se rechaza la lectura como evidencia actual y se indica actualizar el índice. Esto evita devolver líneas nuevas con ubicaciones antiguas. No sustituye una política de exclusión de secretos antes de indexar.

## 9. Operación, seguridad y diagnóstico

### 9.1 Variables de entorno

| Variable | Valor predeterminado / uso |
|---|---|
| `REPOLEAD_TEI_URL` | `http://localhost:8080`, embeddings. |
| `REPOLEAD_QDRANT_URL` | `http://localhost:6333`, índice vectorial. |
| `REPOLEAD_RERANKER_URL` | `http://localhost:8081`, reordenamiento. |
| `REPOLEAD_OLLAMA_TIMEOUT_MS` | Sobrescribe `local_model.timeoutMs` para las generaciones locales del CLI (entero de 1.000 a 600.000 ms). Sin esta variable se usa la configuración del repo o 180.000 ms. |
| `REPOLEAD_TOKEN` | Sin valor predeterminado; autenticación de `serve --http`. |
| `REPOLEAD_JSCPD_BIN` / `REPOLEAD_RUFF_BIN` | Ejecutable alternativo de la herramienta, sin argumentos de shell. |
| `REPOLEAD_QUALITY_PYTHON` | Intérprete Python con Radon instalado; se ejecuta con `-I`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Credenciales del backend remoto explícito; su presencia no cambia el backend local predeterminado. |

`--backend ollama` selecciona generación local; `--backend claude-code` y `--backend api` seleccionan generación remota. Las opciones CLI tienen prioridad sobre `model.backend` en `.repolead.yaml`; sin selección explícita se usa Ollama incluso si existen credenciales Anthropic. Una configuración antigua que declare Claude conserva esa elección. No existe respaldo remoto automático.

No asumas que un archivo `.env` en cualquier carpeta será leído por todos los procesos. Asegura que las variables lleguen al proceso CLI o al servidor MCP que las necesita. Si cambias URLs de servicios, “local” puede dejar de significar que el código permanece en tu máquina.

### 9.2 Qué datos salen de cada frontera

- `scan` y `context` de CLI no necesitan enviar evidencia a un modelo generativo.
- `reindex` envía cuerpos completos de símbolos y texto de documentos/resúmenes/hallazgos al servicio de embeddings; envía vectores y metadatos a Qdrant.
- `query` puede enviar consultas y contenido completo de los candidatos a TEI y al reranker.
- `analyze` y `audit` envían evidencia al backend generativo seleccionado.
- El cliente MCP recibe contexto, resúmenes o fuente según herramientas y configuración; puede incorporarlos al contexto de su propio modelo.

Usar embeddings locales no implica que toda la solución sea offline. Tampoco `--no-source` elimina nombres internos, firmas o excerpts ya guardados.

### 9.3 Servidor remoto

Con `REPOLEAD_TOKEN` definido mediante tu mecanismo de secretos:

```bash
repolead serve --dir /srv/proyectos --http --host 0.0.0.0 --port 3939 --no-source
```

El cliente debe enviar `Authorization: Bearer ...` al endpoint `/mcp`. Protege el servicio con controles de red y un proxy TLS; no publiques el HTTP sin cifrar directamente en Internet. Un token da acceso a los repositorios servidos: no hay autorización granular por repositorio ni aislamiento de usuarios implementados aquí.

Los puertos de Qdrant y TEI publicados por el Compose tampoco deben asumirse privados o autenticados. Antes de un despliegue compartido revisa bindings, firewall, límites de petición, credenciales y acceso a las bases. Esta configuración no es una plataforma multiusuario endurecida por defecto.

### 9.4 Problemas frecuentes

| Síntoma | Qué comprobar |
|---|---|
| “No hay snapshots” | Directorio actual y `--db`; ejecuta `scan` sobre el proyecto correcto. |
| Una función nueva no aparece | Que el archivo esté rastreado por Git, use un lenguaje soportado y se haya actualizado el índice. |
| Pocas relaciones o callers vacíos | Si SCIP pudo ejecutarse; ausencia de edges no prueba ausencia de llamadas. |
| La búsqueda conceptual no encuentra nada | Salud de TEI/Qdrant y `reindex` para el snapshot actual; prueba también un nombre exacto. |
| Fuente “stale” o modificada | Ejecuta `refresh`; confirma que el archivo no cambió después de indexarlo. |
| Dossier/brief ausente después de actualizar | Ejecuta `analyze`; `brief` solo lee lo ya almacenado para el snapshot actual. |
| `refresh --analyze` no crea resúmenes | Si dice “sin cambios”, ejecuta `analyze` explícitamente. |
| Audit no encuentra `policies` | Pasa `--policies "$REPOLEAD_ROOT/policies"` o tu directorio de reglas. |
| Audit produjo candidatos pero MCP no los muestra | `architecture_findings` filtra confirmados; `--no-judge` guarda candidatos. |
| `context` omite fuente | Revisa presupuesto, objetivos, frescura y `--no-source` del servidor; pide el detalle por separado. |
| MCP no inicia | Verifica rutas absolutas de Bun, entrypoint y base; revisa stderr y la configuración del cliente. |

### 9.5 Límites que conviene recordar

El índice no cubre todas las construcciones de todos los lenguajes. El código dinámico, resolución incompleta de imports y referencias no mapeadas pueden producir huecos. El filtro a un módulo también puede excluir dependencias externas a ese módulo aunque se aumente el presupuesto.

Los facts estáticos, la confianza numérica y los resúmenes generados no reemplazan pruebas de comportamiento. Para cambios críticos, abre la evidencia necesaria, sigue las dependencias pertinentes y ejecuta las pruebas del proyecto objetivo.

## 10. Cómo extender la solución

### 10.1 Agregar un lenguaje

Usa los adaptadores TypeScript/Python como referencia. Necesitas extraer símbolos con ubicaciones y firmas, imports y tests cuando corresponda; integrar el adaptador en `scan`; resolver imports; y agregar fixtures/pruebas. Si añades referencias semánticas, define cómo se alinean sus identidades con las de Tree-sitter.

No basta con agregar una extensión a `LANGUAGES`: eso solo identifica metadatos de archivo.

### 10.2 Agregar una policy

Si la regla puede expresarse con un detector existente, agrega un YAML al pack con `id`, `severity`, `candidate_detectors` y la pregunta del juez. Para lógica nueva, implementa un detector en [detectors.ts](../packages/policy-engine/src/detectors.ts), regístralo en `DETECTORS` y prueba positivos, negativos y evidencia faltante.

Valida primero con `audit --no-judge`; después evalúa la utilidad del juicio generativo. No confundas reducir falsos positivos con demostrar que no existen falsos negativos.

### 10.3 Agregar un backend generativo

Implementa la interfaz `TechLeadModel`: nombre y `complete({system, prompt, schema})`, con JSON y uso reportado. Intégralo en [model-select.ts](../apps/cli/src/model-select.ts). Verifica compatibilidad de salida estructurada, autenticación y qué identidad debe entrar en la caché.

El servidor de embeddings no cumple este contrato: producir vectores y producir dossiers son tareas diferentes.

### 10.4 Agregar una herramienta MCP o cambiar contexto

Registra la herramienta en [server.ts](../apps/mcp-server/src/server.ts), define su esquema de entrada y resolución multi-repo, y conserva las restricciones de fuente. Para contexto, prueba presupuestos pequeños, símbolos ambiguos, código modificado, enlaces externos y omisiones. No agregues herramientas de escritura bajo la suposición de que el servidor sigue siendo solo de consulta.

Para evaluar una mejora de recuperación, mide tanto tokens como cobertura y utilidad de las respuestas. Evita optimizar solo el tamaño si se pierde información necesaria para la tarea.

### 10.5 Comandos de desarrollo de RepoLead

Ejecutados desde la instalación, no desde el proyecto objetivo:

```bash
bun run dev --help
bun run doctor
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
bun run verify-memory
bun run verify-evidence-reuse # MCP compilado; reutilización y cambios en una copia aislada de código real
bun run verify-deterministic
bun run verify-incremental
bun run verify-quality    # requiere jscpd y el entorno Python opcional
bun run verify-mcp-http   # CLI compilada, dos repositorios y clientes HTTP reales
bun run verify-change-analysis # referencias SCIP reales, impacto, trace, CLI y MCP
bun run verify-policy-quality # llamadas REALES a Claude Code: consume cuota
bun run verify-retrieval  # requiere TEI/Qdrant/reranker locales
```

`dev` invoca la CLI fuente; `doctor` ejecuta su diagnóstico; `lint` usa Rslint; `typecheck` ejecuta Rslint y `tsc --noEmit`; `test` usa Rstest; `build` compila la CLI con Rsbuild. `check` encadena lint, tipos, pruebas y build, deteniéndose ante un fallo.

`verify-quality` ejecuta jscpd, Ruff y Radon reales; importa un LCOV sintético de resultados conocidos, comprueba caché, consumo por análisis/policies, CLI compilada y MCP stdio. El [reporte](../benchmarks/quality-acceptance.json) separa las mediciones reales del modelo de contrato usado para comprobar orquestación; no acredita calidad generativa ni ahorro facturado.

`verify-mcp-http` levanta el CLI compilado con dos bases, abre dos clientes del SDK oficial y verifica 20 recursos, ambas audiencias, resolución de IDs compartidos, restricción de fuente, documentos persistidos y cambios de snapshot visibles sin reiniciar. El [reporte HTTP](../benchmarks/mcp-http-acceptance.json) registra protocolo `2025-11-25`; no declara compatibilidad con el transporte 2026. Usa un modelo de contrato y no mide ahorro de tokens de respuestas.

`verify-change-analysis` utiliza SCIP real, una ruta con handler importado, dos ramas hacia una función de persistencia, un callback referenciado sin llamada, miembros públicos/privados y un test vinculado. Comprueba cada salto contra SQLite, imports que no arrastran funciones ajenas, cobertura LCOV con checksums, CLI compilada, MCP sin fuente y cambios visibles tras `refresh`. El [reporte](../benchmarks/change-analysis-acceptance.json) incluye tamaño de respuestas en tokens proxy; no compara facturación ni afirma ahorro integral. Los contadores de ejecución del LCOV son prescritos: no se ejecuta el código ni los tests del fixture.

`verify-policy-quality` sí usa un modelo generativo real mediante Claude Code. El script directo exige `--real`; no forma parte de `check`. Guarda los veredictos y contadores del SDK, contrasta los resultados con casos esperados y exige cero llamadas nuevas al repetir. No ejecuta herramientas del proyecto objetivo mediante el modelo.

`verify-memory` usa Bun y la CLI compilada contra repositorios temporales. Comprueba las dos vistas, caché sin llamadas repetidas, recursos a través de un cliente MCP stdio real, bloqueo de fuente y actualización de snapshots. También mide scan/refresh sobre 1000 funciones sintéticas, con SCIP desactivado. El [reporte](../benchmarks/memory-acceptance.json) identifica las limitaciones: usa un modelo de contrato, no evalúa la calidad semántica de respuestas ni mide facturación real o recuperación TEI/Qdrant.

`verify-evidence-reuse` copia cinco archivos reales de RepoLead en un repositorio temporal y consulta la CLI compilada mediante el SDK MCP oficial, con recuperación léxica y sin inferencia generativa. Verifica reutilización exacta, recuperación del texto perdido, rechazo de fuente desactualizada y entrega selectiva tras un cambio. El [reporte](../benchmarks/evidence-reuse-acceptance.json) mide 10.193 tokens de petición y respuesta iniciales frente a 1.221 al repetir con nueve recibos: 88,02 % menos. La respuesta por sí sola baja 91,90 %, pero ese porcentaje excluye el envío de recibos. Son tokens proxy del transporte: no prueba ahorro de facturación, calidad de respuestas ni el objetivo del roadmap de menos del 10 % de una exploración manual equivalente. La primera consulta y los bloques retenidos en el historial siguen teniendo costo para el modelo.

`verify-incremental` usa SCIP real en una cadena `price → invoice → checkout`, con módulos independientes, configuración y documentos de producto. Cambia una función manteniendo sus líneas y comprueba fichas regeneradas, dossiers intactos, actualización de documentación vinculada y ausencia de recursos antiguos tras un rename. El [reporte incremental](../benchmarks/incremental-acceptance.json) mide llamadas al modelo de contrato y tiempos de orquestación; no equivale a latencia de un modelo real ni a ahorro de tokens facturados.

El reporte histórico de `verify-retrieval` utiliza Qwen3-Embedding-0.6B, BGE reranker y Qdrant reales, una colección temporal aislada y 28 funciones en inglés. El [reporte de recuperación](../benchmarks/retrieval-acceptance.json) registra 8/8 consultas español/inglés con el objetivo en primer lugar; repetir el índice genera cero embeddings y cambiar una función genera uno, reutilizando 30. Comprueba filtros, reconstrucción sin montar la fuente, purga física y MCP sin fuente. Los resúmenes/hallazgos de esta prueba son fixtures manuales: no mide calidad generativa ni ahorro de tokens facturados.

`verify-mutation` ejecuta Stryker y verifica selección, integridad, importación y MCP. `verify-python` comprueba SCIP Python, siete posiciones exactas, alias, herencia, recursión, callback frente a llamada y flujo FastAPI con Ruff/Radon reales. `verify-joern` ejecuta ambos frontends y un contraejemplo sin flujo. `verify-clean-install` copia solo los archivos versionables a una carpeta vacía, instala con lock congelado y ejecuta los gates de CI; no afirma haber ejecutado GitHub Actions remoto.

Las evaluaciones generativas se ejecutan explícitamente: `REPOLEAD_ACCEPTANCE_MODEL=haiku bun scripts/verify-generative.ts --real` y, después, `bun scripts/verify-token-workflow.ts --real`. La primera necesita Ollama con Qwen y Claude Code autenticado; conserva la fixture para la segunda. La segunda compara dos sesiones equivalentes con el mismo modelo: lectura manual frente a MCP. Registra corrección, uso total del SDK, costo estimado y costo de preparación por separado. No fuerza un mínimo de lecturas manuales ni considera una respuesta incorrecta como ahorro. `REPOLEAD_ACCEPTANCE_MODEL=sonnet bun run verify-repo-workflow` repite la comparación sobre una copia del propio RepoLead, con índice determinista y sin dossiers generativos previos. `REPOLEAD_ACCEPTANCE_SCIP=1` instala las dependencias congeladas de esa copia y activa SCIP; `REPOLEAD_ACCEPTANCE_PROFILE=context` selecciona el catálogo reducido. En la fixture pequeña, `REPOLEAD_ACCEPTANCE_GUIDED=1` añade las instrucciones de empezar por producto y agrupar evidencia. Los reportes distinguen esas variantes y los resultados pueden incumplir el objetivo del roadmap.

Punto de entrada de la interfaz: [program.ts](../apps/cli/src/program.ts). Contratos: [domain](../packages/domain/src/entities.ts). Scripts y workspaces: [package.json](../package.json).

---

La regla práctica es: **indexar hechos, recuperar contexto suficiente, verificar la evidencia y actualizar cuando cambia el código**. El ahorro proviene de reutilizar trabajo y seleccionar información pertinente; no de imponer siempre el menor número posible de tokens.
