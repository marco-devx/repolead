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
| Embedding | Un vector numérico usado para recuperar símbolos por similitud semántica. No es un resumen escrito. |

### Tres tipos de procesamiento diferentes

1. **Análisis determinista:** Git, Tree-sitter, SCIP, SQLite y selección de contexto. No necesita un modelo generativo.
2. **Recuperación con modelos locales:** TEI genera embeddings y puede reordenar resultados. Consume recursos de la máquina o del servidor al que apunten sus URLs.
3. **Interpretación generativa:** `analyze` y el juez de `audit` usan Claude mediante API o Claude Agent SDK. Pueden consumir cuota o tokens del proveedor.

Conectar Codex como cliente MCP **no convierte a Codex en el backend de `analyze`**. Son funciones separadas: Codex consulta; los backends de análisis implementados son los de Claude.

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
| `embeddings` | `Qwen/Qwen3-Embedding-0.6B` mediante TEI | `8080` |
| `reranker` | `BAAI/bge-reranker-v2-m3` mediante TEI | `8081` |

Los modelos pueden tardar en descargarse e inicializarse la primera vez. El Compose normal usa CPU; el [override GPU](../docker-compose.gpu.yml) requiere revisar la compatibilidad de la imagen y de tu hardware. RepoLead no arranca Docker al ejecutar `scan`, `onboard` o `serve`.

### 2.5 Alta completa con interpretación del proyecto

Configura previamente el acceso al backend de Claude que vas a usar. Luego:

```bash
cd /ruta/a/mi-proyecto
repolead onboard . --backend claude-code --context-tokens 4000
repolead brief
```

Si prefieres API, usa `--backend api` con las credenciales correspondientes. `--model` permite seleccionar el nombre de modelo que acepte ese backend; el valor predeterminado codificado para API es `claude-opus-5`.

Para hacer el alta sin interpretación generativa debes desactivar **ambas** etapas:

```bash
repolead onboard . --no-analyze --no-audit
```

Ese último comando todavía intentará indexar vectores si TEI y Qdrant están disponibles. Si quieres exclusivamente los hechos locales, usa `scan`.

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
       ├─ actualización vectorial si hay servicios
       └─ analyze, solo con --analyze
            └─ audit explícito si necesitas hallazgos actualizados
```

Secuencia habitual después de editar:

```bash
repolead refresh . --analyze --context-tokens 4000
repolead audit --policies "$REPOLEAD_ROOT/policies"
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
- Si `refresh` detecta que no hay cambios, retorna inmediatamente, incluso con `--analyze`. Usa `analyze` explícitamente para crear resúmenes pendientes o cambiar su presupuesto.
- Un snapshot nuevo no hereda automáticamente todos los resúmenes y hallazgos visibles. `analyze` recupera o genera los resúmenes para ese snapshot; `audit` produce sus hallazgos.

El servidor MCP no vigila archivos ni dispara `refresh` por sí mismo. Las consultas que resuelven el repositorio vuelven a comprobar el último snapshot, por lo que una conexión stdio puede consultar el índice actualizado sin reiniciarse.

## 4. Referencia técnica de todos los comandos

### Convenciones comunes

Consulta siempre `repolead <comando> --help` para la interfaz ejecutable. `repolead --help` lista los comandos, `repolead help <comando>` muestra su ayuda y `repolead --version` imprime la versión declarada por la CLI. Estas opciones no indexan ni analizan el proyecto.

`scan`, `onboard` y `refresh` calculan su base predeterminada desde el repositorio indicado por `[path]`. Los comandos de consulta y análisis usan `.repolead/repolead.db` **relativo al directorio actual**, salvo `--db` explícito. Una ruta relativa pasada en `--db` también se interpreta desde el proceso actual.

Los comandos trabajan normalmente sobre el snapshot más reciente; no hay una opción CLI general `--snapshot`. Usa una base por repositorio y `serve --dir` para agrupar varias bases.

| Comando | Efecto principal | Modelo generativo |
|---|---|---|
| `doctor` | Diagnostica binarios y servicios | No |
| `scan` | Escribe un nuevo snapshot de hechos | No |
| `onboard` | Orquesta scan, vectores, análisis y auditoría | Sí, salvo etapas desactivadas |
| `refresh` | Actualiza hechos y, si puede, vectores | Solo con `--analyze` y trabajo detectado |
| `reindex` | Escribe/actualiza vectores en Qdrant | No; usa embeddings |
| `analyze` | Escribe dossiers y brief, con caché | Sí, salvo caché o `--dry-run` |
| `audit` | Escribe hallazgos con evidencia | Sí, salvo `--no-judge` o sin candidatos |
| `brief` | Lee resúmenes almacenados | No |
| `query` | Busca símbolos | No; puede usar embeddings y reranker |
| `context` | Construye contexto acotado localmente | No |
| `benchmark-tokens` | Compara tamaños y cobertura | No |
| `serve` | Expone consultas por MCP | No; algunas consultas usan recuperación semántica |
| `install-hooks` | Modifica la configuración local de Claude Code | No |

Las consultas están pensadas para bases ya indexadas. Abrir una ruta SQLite inexistente puede crear una base vacía; comprueba `--db` si recibes “no hay snapshots”.

### 4.1 `doctor`: comprobar el entorno

```bash
repolead doctor
```

Comprueba Bun, Git, Docker, el ejecutable `scip-typescript` y los endpoints de salud de Qdrant, embeddings y reranker. No instala ni arranca servicios. Marca Bun y Git como obligatorios; los demás son opcionales. Devuelve código de error si falta un requisito obligatorio.

No valida credenciales de Claude ni confirma que un proyecto pueda compilarse. La búsqueda del ejecutable SCIP en `PATH` tampoco equivale a probar los indexadores que el adaptador puede resolver desde las dependencias locales.

Código: [checks.ts](../apps/cli/src/doctor/checks.ts).

### 4.2 `scan [path]`: construir los hechos

```bash
repolead scan .
repolead scan /ruta/a/mi-proyecto --name mi-api --db /ruta/a/mi-api.db --no-scip
```

Opciones: `[path]` por defecto `.`, `--db`, `--name`, `--no-scip`.

Pasos internos:

1. Obtiene `HEAD`, archivos rastreados e historial Git.
2. Crea el repositorio si corresponde y un snapshot nuevo en SQLite.
3. Lee archivos; calcula hashes, lenguaje y metadatos.
4. Extrae símbolos, imports y tests en TypeScript/TSX y Python.
5. Detecta módulos y relaciones de pertenencia.
6. Intenta ejecutar los indexadores SCIP aplicables, salvo `--no-scip`.
7. Persiste archivos, símbolos, relaciones, módulos, tests y métricas.

No crea embeddings, resúmenes ni hallazgos. Cada ejecución crea un snapshot; no es la alternativa que evita trabajo cuando no cambió nada. Los archivos superiores a 1 MiB no se parsean como fuente. Identificar una extensión no implica tener un extractor de símbolos para ese lenguaje.

Código: [scan.ts](../packages/code-graph/src/scan.ts).

### 4.3 `onboard [path]`: ejecutar el alta completa

```bash
repolead onboard . --backend claude-code --context-tokens 6000
repolead onboard . --no-analyze --no-audit --no-scip
```

Opciones: `[path]`, `--db`, `--name`, `--model`, `--backend api|claude-code`, `--context-tokens` (4000), `--policies`, `--no-scip`, `--no-analyze`, `--no-audit`.

Ejecuta secuencialmente:

1. **Scan:** crea el snapshot de hechos.
2. **Reindex:** comprueba TEI/Qdrant e indexa si están disponibles; si no, informa que omitió esa etapa.
3. **Analyze:** genera o recupera dossiers y brief, salvo `--no-analyze`.
4. **Audit:** ejecuta las policies con juez, salvo `--no-audit`; también puede omitirla si no encuentra el directorio de reglas.

Al terminar imprime comandos de conexión para Claude Code y Codex; **no los registra automáticamente**. Tampoco instala hooks. Para rules personalizadas usa `--policies`; por defecto intenta localizar el pack de la instalación de RepoLead.

No es una transacción global de cuatro etapas: si una etapa posterior falla, puede haber quedado un snapshot o índice ya generado. Puedes continuar con `reindex`, `analyze` o `audit` sin repetir todo el alta.

Código: [onboard.ts](../apps/cli/src/commands/onboard.ts).

### 4.4 `refresh [path]`: detectar cambios y actualizar

```bash
repolead refresh .
repolead refresh . --analyze --backend claude-code --context-tokens 6000
```

Opciones: `[path]`, `--db`, `--analyze`, `--model`, `--backend`, `--context-tokens` (4000), `--no-scip`.

Compara `HEAD` y `git diff --name-only <commit-del-snapshot>`. Si no detecta trabajo, retorna. Si lo detecta, vuelve a ejecutar el escaneo determinista y compara IDs/hashes de símbolos para informar cambios, eliminaciones y módulos afectados.

La parte incremental está principalmente en evitar escaneos innecesarios y reutilizar embeddings/resúmenes. **No hay un parser que actualice exclusivamente cada archivo cambiado.** Con modificaciones locales sin commit, el diff contra `HEAD` puede seguir detectando trabajo en ejecuciones consecutivas; las capas de caché aún pueden reutilizar resultados.

Si TEI/Qdrant están disponibles, actualiza todos los puntos vivos al snapshot actual, reutilizando los vectores válidos. Con `--analyze`, recorre el análisis y deja que su caché decida qué reutilizar. No vuelve a juzgar policies.

Si el repositorio se dio de alta con un `--name` distinto del nombre de su carpeta, ten cuidado: `refresh` no expone `--name` y deriva el nombre del directorio. Mantener el nombre predeterminado evita esa inconsistencia en el flujo habitual.

Código: [refresh.ts](../packages/code-graph/src/refresh.ts) y [comando refresh](../apps/cli/src/commands/refresh.ts).

### 4.5 `reindex`: sincronizar el índice vectorial

```bash
repolead reindex --db /ruta/a/mi-proyecto/.repolead/repolead.db
```

Opción: `--db`.

Necesita un snapshot y TEI/Qdrant accesibles. Para cada símbolo construye un texto con tipo, nombre, firma y ruta; **no vectoriza el cuerpo completo de la función**. Calcula embeddings faltantes y hace upsert en la colección `repolead-symbols`.

Puede reutilizar vectores si coinciden el hash de ese texto y la identidad de modelo/configuración obtenida de TEI. Si TEI no informa una identidad suficiente, se recalculan. Todos los símbolos actuales reciben el `snapshot_id` nuevo; los puntos antiguos de símbolos eliminados dejan de coincidir con el filtro del snapshot, aunque no se purgan físicamente en esta operación.

No escanea cambios en disco. Si cambió el código, primero actualiza SQLite con `refresh` o `scan`. Cambiar a un modelo con otra dimensión puede exigir gestionar una colección compatible; no hay un comando de migración de dimensiones.

Código: [indexer.ts](../packages/retrieval/src/indexer.ts) y [embeddings.ts](../packages/retrieval/src/embeddings.ts).

### 4.6 `analyze`: interpretar los hechos

```bash
repolead analyze --dry-run --context-tokens 4000
repolead analyze --backend claude-code --context-tokens 6000
repolead analyze --module retrieval --backend api --model nombre-del-modelo
```

Opciones: `--db`, `--model`, `--backend`, `--module`, `--dry-run`, `--context-tokens` (4000).

Construye un paquete de evidencia por módulo: archivos, firmas y ubicaciones de símbolos, relaciones, dependencias, tests y co-cambios. El modelo recibe ese paquete y un esquema de salida. No recibe automáticamente todos los cuerpos de funciones, y el backend Agent SDK desactiva sus herramientas de lectura/ejecución.

Sin `--module`, procesa secuencialmente los módulos y luego sintetiza el brief a partir de sus dossiers. Con `--module` filtra por nombre exacto y no genera el brief global. `--dry-run` muestra tamaños y omisiones de los paquetes de módulo; no imprime todos sus contenidos ni ejecuta la síntesis final.

La caché considera evidencia, versión del prompt y nombre del modelo. Un acierto evita la llamada y copia el resumen al snapshot actual si hace falta. El presupuesto acota cada paquete de evidencia, no el prompt completo, la salida ni la suma de todas las llamadas.

Código: [analyze.ts](../packages/lead-analyzer/src/analyze.ts), [evidence.ts](../packages/lead-analyzer/src/evidence.ts) y [prompts.ts](../packages/lead-analyzer/src/prompts.ts).

### 4.7 `audit`: evaluar reglas de arquitectura y diseño

```bash
repolead audit --policies "$REPOLEAD_ROOT/policies" --no-judge
repolead audit --policies "$REPOLEAD_ROOT/policies" --backend claude-code
```

Opciones: `--db`, `--policies`, `--model`, `--backend`, `--no-judge`.

Carga recursivamente archivos `.yaml` y `.yml`, ejecuta detectores registrados y descarta candidatos sin evidencia. Si hay modelo, envía los candidatos de cada policy al juez y guarda los confirmados. Sin juez los persiste con estado `candidate` y confianza inicial `0.5`; no son confirmaciones automáticas.

El pack incluido aborda dependencia entre capas, ciclos entre módulos, fan-in alto y módulos sin tests vinculados. “Sin tests vinculados” es una señal estructural, no una medición de cobertura ejecutada.

El directorio predeterminado de este comando es `policies` bajo el directorio actual. A diferencia de `onboard`, no busca automáticamente el pack de RepoLead: usa `--policies` cuando trabajes sobre otro proyecto.

`audit` no usa la caché de `analyze` ni acepta `--context-tokens`. Repetirlo puede repetir llamadas y añadir hallazgos al mismo snapshot; no hay deduplicación general implementada en este flujo. Las herramientas MCP de hallazgos muestran `confirmed`, no los `candidate` de `--no-judge`.

Código: [engine.ts](../packages/policy-engine/src/engine.ts), [detectors.ts](../packages/policy-engine/src/detectors.ts) y [policies](../policies).

### 4.8 `brief`: consultar resúmenes existentes

```bash
repolead brief
repolead brief --module retrieval --json
```

Opciones: `--db`, `--module`, `--json`.

Lee el brief del snapshot actual o el dossier del módulo indicado por nombre. No llama a un modelo ni genera un resumen faltante. `--json` devuelve el contenido estructurado; sin esa opción lo presenta por secciones con información del modelo y fecha.

Si no existe el resumen, ejecuta `analyze`; para el brief global, ejecútalo sin `--module`.

Código: [brief.ts](../apps/cli/src/commands/brief.ts).

### 4.9 `query <text...>`: encontrar símbolos

```bash
repolead query "validación de permisos" --limit 8
repolead query hybridSearch --db /ruta/a/repolead/.repolead/repolead.db
```

Opciones: `--db`, `--limit` (8).

Combina búsqueda FTS5, vectores cuando están disponibles y señal de grafo. Fusiona rankings, aplica una bonificación de coincidencia de términos y opcionalmente usa el reranker. Devuelve nombres, tipos, ubicaciones, puntuaciones y procedencia de las señales.

No genera una respuesta conversacional. Encontrar símbolos relacionados con “autenticación” no equivale a explicar correctamente todo el flujo de autenticación.

Código: [search.ts](../packages/retrieval/src/search.ts).

### 4.10 `context [query...]`: entregar contexto acotado

```bash
repolead context "autenticación" --tokens 2000
repolead context --module retrieval --tokens 4000
repolead context --symbols hybridSearch --source --tokens 6000 --json
```

Opciones: `--db`, `--module`, `--symbols <names...>`, `--tokens` (2000), `--source`, `--json`.

Selecciona símbolos usando nombres, consulta textual y ranking del grafo. `--symbols` acepta nombres cualificados exactos o IDs; ante ambigüedad usa un ID o limita el módulo. `--module` acepta nombre o ruta y restringe el contexto a su propiedad de archivos, sin incluir automáticamente todos sus módulos hijos.

Sin `--source`, entrega principalmente firmas, ubicaciones y relaciones cercanas. Con `--source`, prioriza los cuerpos completos de los objetivos si caben, además de sus dependencias salientes inmediatas. Si un cuerpo no cabe, se omite y se reporta; no se corta silenciosamente una función para presentarla como completa.

El texto completo, incluyendo metadatos, debe respetar el presupuesto. `--json` añade métricas y listas de IDs: el campo `tokens` mide `text`, no todo el envoltorio JSON. El presupuesto permitido es un entero entre 256 y 64.000; un mínimo válido todavía puede ser insuficiente para metadatos extensos.

La CLI `context` no consulta TEI/Qdrant. La herramienta MCP `context_pack` sí puede realizar una búsqueda híbrida inicial cuando recibe solo `query`; véase la sección 5.

Código: [context.ts](../packages/retrieval/src/context.ts) y [ranking.ts](../packages/retrieval/src/ranking.ts).

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

Opciones: `--db`, `--dir`, `--http`, `--port` (3939), `--token`, `--no-source`.

Por defecto usa stdio: el cliente MCP lanza el proceso y habla por entrada/salida estándar. Los mensajes de diagnóstico van a stderr. Ejecutarlo a mano puede parecer que queda esperando; está esperando a un cliente, no mostrando una interfaz web.

`--dir` busca bases en el directorio indicado y sus subdirectorios **inmediatos**, no recursivamente a cualquier profundidad. Tiene prioridad sobre `--db`. La lista de repositorios se descubre al arrancar: agregar otra base requiere reiniciar ese servidor.

Con `--http`, expone MCP Streamable HTTP en `/mcp`, con autenticación Bearer obligatoria mediante `--token` o `REPOLEAD_TOKEN`. Escucha en `0.0.0.0`; no incorpora TLS ni permisos por repositorio. Revisa la sección de seguridad antes de publicarlo.

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

## 5. MCP y conexión con agentes

### 5.1 Qué agrega MCP

MCP permite que el agente solicite herramientas estructuradas. Aquí todas las herramientas están diseñadas para consultar: no ofrecen `scan`, `refresh`, `analyze` ni escritura de código. Preparar y actualizar los datos sigue siendo responsabilidad de la CLI o de una automatización externa.

| Herramienta | Entrada principal | Respuesta y límites relevantes |
|---|---|---|
| `context_pack` | `query?`, `symbols?`, `module?`, `maxTokens?`, `includeSource?`, `repo?` | Mapa acotado y fuente opcional. 2000 tokens por defecto; 256–64.000; hasta 20 objetivos y 2000 caracteres de consulta. |
| `repo_overview` | `repo?` | Conteos, módulos y brief; sin repositorio en modo múltiple lista los disponibles. |
| `module_context` | `module`, `repo?` | Dossier y previews de hallazgos confirmados del módulo. |
| `symbol_context` | `symbol`, `repo?` | Firma, ubicación y hasta 20 relaciones por dirección, con aviso de truncamiento. |
| `find_callers` | `symbol`, `transitiveDepth?`, `repo?` | Recorrido por relaciones `CALLS`; profundidad 1 por defecto, máximo 5. |
| `architecture_findings` | `severity?`, `module?`, `repo?` | Solo hallazgos confirmados; severidades como arreglo, por ejemplo `["high"]`. |
| `get_evidence` | `findingId?` o `path` con líneas, `repo?` | Evidencia guardada y/o lectura del archivo; por rango, hasta 200 líneas y 2000 tokens de fuente. Sin rango final pide normalmente 20 líneas. |
| `search` | `query`, `limit?`, `repo?` | Búsqueda híbrida; límite 8 por defecto, entre 1 y 20. |

El presupuesto de `context_pack` no se aplica a todas las otras herramientas. Por ejemplo, una consulta de muchos hallazgos o callers puede producir una respuesta más grande. Los 2000 tokens de `get_evidence` son por rango de fuente, no por todo el JSON de una colección de evidencias.

Con varios repositorios, `context_pack` exige seleccionar `repo`; `get_evidence` por ruta también. `search` y `architecture_findings` pueden agregar resultados. Las herramientas de símbolo/módulo intentan resolver el repositorio cuando el objetivo pertenece a uno solo. Dentro de un repositorio, usa nombres cualificados y verifica ubicaciones; las herramientas antiguas de símbolo no tienen la misma resolución estricta por ID de `context_pack`.

Una consulta MCP `context_pack` con solo `query` busca primero hasta tres símbolos mediante búsqueda híbrida, sin reranker en esa ruta, y los usa como objetivos. Con `symbols` o `module`, construye directamente el contexto. El motor compartido usa selección léxica y de grafo si necesita elegir objetivos sin resultados de búsqueda.

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

### 6.1 Qué significa el límite de 2000

Es el límite predeterminado del **texto devuelto por una llamada de contexto**, contado con `gpt-tokenizer` y la codificación `o200k_base`. No es la ventana total del agente ni el presupuesto de toda una conversación.

La selección conserva unidades de código y referencias. No hay un modelo que reescriba el código para “comprimirlo”; se omite información menos prioritaria y se informa de ello. Los conteos `symbols X/Y` y `relations X/Y` describen el ámbito candidato seleccionado, no un porcentaje de cobertura de todo el repositorio.

Como punto de partida, no como garantía de suficiencia:

| Tarea | Presupuesto inicial orientativo | Qué revisar |
|---|---|---|
| Ubicar una función o un módulo | 2000 | Que el objetivo sea el correcto y aparezca su ubicación. |
| Entender una función con dependencias | 4000–8000 | Que entren el cuerpo completo y las dependencias necesarias. |
| Investigar varios módulos | Consultas separadas o presupuesto mayor | Que los límites de módulo y selección no oculten partes del flujo. |

Un presupuesto mayor no expande automáticamente el alcance semántico: un contexto filtrado a un módulo sigue filtrado, y la vecindad de símbolos sigue siendo inmediata. Para un flujo transversal, consulta otros objetivos o herramientas.

El aumento adaptativo del presupuesto **no está automatizado** en RepoLead. Lo decide quien llama o el agente cliente. Una respuesta más pequeña que obliga a realizar muchas consultas puede costar más en total.

### 6.2 Presupuesto de análisis: otra cosa distinta

`--context-tokens 4000` limita la evidencia de cada módulo y la evidencia de la síntesis final. No limita el número de módulos ni las salidas del modelo. Un proyecto con diez módulos puede requerir diez análisis y una síntesis si no hay caché.

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
        └─ TEI reranker            SQLite
                                        ▲
packages/policy-engine ─ detectores → juez → hallazgos + evidencia

apps/cli                  operaciones explícitas y consultas de terminal
apps/mcp-server           consultas stdio / HTTP para agentes
packages/domain           contratos, entidades e identidades compartidas
```

Qdrant es un índice derivado, no la autoridad para archivos, relaciones o resúmenes. Puede reconstruirse desde los símbolos de SQLite. SQLite tampoco es una copia completa de los archivos: las lecturas de fuente exacta necesitan el árbol de trabajo original.

### 7.2 Extracción y construcción del grafo

Tree-sitter proporciona estructura sintáctica. Los adaptadores de lenguaje la convierten en símbolos/imports/tests, con detección adicional de endpoints como rutas FastAPI en Python. El coordinador asigna IDs y persiste los resultados.

SCIP añade referencias entre definiciones que se pueden mapear a los símbolos propios. La implementación cruza ruta, línea y nombre, y relaciona cada referencia con el símbolo contenedor más interno.

Un detalle importante: una referencia SCIP cuyo destino es función o método se clasifica como `CALLS`; otros destinos se clasifican como `DEPENDS_ON`. Esto no es una traza de ejecución, y una referencia a una función no prueba por sí sola que se invoque en todos los caminos del programa.

Las relaciones llevan analizador, confianza y evidencia. Los tipos definidos en `domain` expresan un vocabulario amplio; que exista un tipo como `READS_FROM` no significa que los adaptadores actuales lo produzcan para cualquier lenguaje.

Los módulos se deducen de manifiestos. La propiedad de un archivo se asigna al módulo más específico, evitando duplicar todos los símbolos de paquetes hijos en el dossier del padre. Si no hay manifiestos se crea un módulo raíz.

### 7.3 Búsqueda híbrida, paso a paso

1. **FTS5:** obtiene candidatos por nombre cualificado, ruta y firma.
2. **Vectores:** convierte la consulta en embedding y busca en Qdrant filtrando por snapshot.
3. **Grafo:** prioriza candidatos que reciben más referencias; no hace una exploración semántica ilimitada.
4. **Fusión RRF:** combina posiciones de ranking con constante `60`, pesos `1` para texto/vectores y `0.5` para grafo.
5. **Cobertura de términos:** añade una bonificación cuando coinciden varias palabras de la consulta.
6. **Reranking:** sobre hasta 20 candidatos por defecto, si el servicio está disponible.
7. **Salida:** devuelve los primeros resultados, 8 por defecto.

El contexto compacto usa otro ranking: coincidencias directas y semillas explícitas más un PageRank personalizado, con 20 iteraciones y amortiguación `0.85`. Ignora `CONTAINS` para no confundir pertenencia con uso. El número de tokens se comprueba durante la construcción del texto.

Si un servicio está ausente al comprobar su salud, se omite esa vía. Un fallo posterior durante una petición no siempre se recupera silenciosamente: puede propagarse como error. “Degradación” no significa que cualquier avería de red esté absorbida.

### 7.4 Análisis de abajo hacia arriba

El flujo generativo es:

```text
hechos del módulo → paquete acotado → dossier JSON
todos los dossiers → síntesis acotada → brief JSON
```

Los esquemas de salida organizan responsabilidad, API pública, dependencias, riesgos y otras secciones. La síntesis reparte secciones entre módulos para que un dossier grande no consuma todo el espacio. Si no cabe todo, registra omisiones.

La API directa configura una salida estructurada y un máximo de salida propio; el Agent SDK solicita JSON estructurado con herramientas desactivadas y hasta tres turnos. Ninguno de esos valores convierte `--context-tokens` en un techo de facturación. Los campos de uso reportados suman también las categorías de entrada asociadas a caché cuando el proveedor las entrega.

### 7.5 Detectores y juez no cumplen el mismo papel

Los detectores producen candidatos reproducibles a partir del índice. Las policies declaran qué detectores usar, parámetros, severidad y la pregunta para el juez. El juez interpreta los candidatos; no ejecuta las pruebas del repositorio ni demuestra formalmente una violación.

La implementación registra únicamente candidatos con evidencia. Los rechazados por el juez no se guardan como findings en este flujo. Los confirmados conservan su evidencia, pero el estado `confirmed` significa “confirmado por este proceso”, no certeza absoluta.

## 8. Datos, identidad e invalidación

### 8.1 Qué persiste SQLite

| Grupo | Tablas principales | Uso |
|---|---|---|
| Identidad y tiempo | `repositories`, `snapshots` | Proyecto y captura indexada. |
| Hechos | `files`, `modules`, `symbols`, `edges`, `tests`, `metrics` | Código extraído, relaciones y señales Git. |
| Interpretación | `summaries`, `analysis_runs` | Dossiers, brief, claves de caché y uso reportado. |
| Auditoría | `findings`, `evidence` | Hallazgos y referencias que los respaldan. |
| Recuperación textual | `symbols_fts`, `findings_fts`, `summaries_fts` | Índices FTS5 sincronizados mediante triggers. |

El esquema también declara `coverage` y `opportunities`; su existencia no implica que haya comandos actuales para importar cobertura o gestionar oportunidades como un flujo completo. Las oportunidades de los dossiers son contenido de esos resúmenes.

El historial Git se limita a los últimos 500 commits. Para co-cambios excluye commits de más de 30 archivos, exige al menos tres coincidencias y conserva hasta 50 pares. Son heurísticas de señal histórica, no dependencias semánticas demostradas.

Código: [migrations.ts](../packages/knowledge-store/src/migrations.ts), [store.ts](../packages/knowledge-store/src/store.ts) y [adaptador Git](../adapters/git/src/index.ts).

### 8.2 Identidad estable no significa contenido inmutable

El ID de un símbolo se deriva del repositorio, ruta, tipo, nombre cualificado y firma. No utiliza su número de línea. Mover líneas sin cambiar esos componentes puede conservar el ID; renombrar, mover de archivo o cambiar la firma puede cambiarlo.

Separadamente, el hash de contenido permite detectar modificaciones del cuerpo. Los datos se asocian a snapshots para distinguir capturas. Los comandos no ofrecen actualmente una política automática de retención/purga de snapshots.

### 8.3 Dos cachés distintas

**Resúmenes:** el paquete contiene una huella de archivos propios, cuerpos de símbolos, relaciones incidentes y dependencias identificadas, incluso evidencia que no entró en el prompt. Luego se combina el paquete con la versión del prompt y el nombre del modelo para buscar un resumen reutilizable.

Así, cambiar el cuerpo de un símbolo omitido puede invalidar el análisis aunque su firma no haya cambiado. Un módulo padre no necesita duplicar todos los cuerpos de sus hijos para rastrear su propia evidencia. La síntesis puede permanecer cacheada si los dossiers resultantes no cambian.

**Embeddings:** la caché depende del texto enviado al embedding y de la identidad de TEI. Como ese texto usa metadatos del símbolo, un cambio solo en el cuerpo puede conservar el vector y, a la vez, invalidar el dossier. Son decisiones coherentes con entradas diferentes, no la misma caché aplicada dos veces.

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
| `REPOLEAD_TOKEN` | Sin valor predeterminado; autenticación de `serve --http`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Su presencia influye en la selección automática del backend API. |

`--backend claude-code` fuerza ese backend; `--backend api` fuerza API. Sin selección explícita, el código elige API cuando detecta credenciales y Agent SDK en caso contrario. Usa únicamente esos nombres documentados.

No asumas que un archivo `.env` en cualquier carpeta será leído por todos los procesos. Asegura que las variables lleguen al proceso CLI o al servidor MCP que las necesita. Si cambias URLs de servicios, “local” puede dejar de significar que el código permanece en tu máquina.

### 9.2 Qué datos salen de cada frontera

- `scan` y `context` de CLI no necesitan enviar evidencia a un modelo generativo.
- `reindex` envía metadatos de símbolos al servicio de embeddings y vectores/payloads a Qdrant.
- `query` puede enviar consultas y representaciones de símbolos a TEI y al reranker.
- `analyze` y `audit` envían evidencia al backend generativo seleccionado.
- El cliente MCP recibe contexto, resúmenes o fuente según herramientas y configuración; puede incorporarlos al contexto de su propio modelo.

Usar embeddings locales no implica que toda la solución sea offline. Tampoco `--no-source` elimina nombres internos, firmas o excerpts ya guardados.

### 9.3 Servidor remoto

Con `REPOLEAD_TOKEN` definido mediante tu mecanismo de secretos:

```bash
repolead serve --dir /srv/proyectos --http --port 3939 --no-source
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
```

`dev` invoca la CLI fuente; `doctor` ejecuta su diagnóstico; `lint` usa Rslint; `typecheck` ejecuta la comprobación de tipos configurada con Rslint; `test` usa Rstest; `build` compila la CLI con Rsbuild. `check` encadena lint, tipos, pruebas y build, deteniéndose ante un fallo.

Punto de entrada de la interfaz: [program.ts](../apps/cli/src/program.ts). Contratos: [domain](../packages/domain/src/entities.ts). Scripts y workspaces: [package.json](../package.json).

---

La regla práctica es: **indexar hechos, recuperar contexto suficiente, verificar la evidencia y actualizar cuando cambia el código**. El ahorro proviene de reutilizar trabajo y seleccionar información pertinente; no de imponer siempre el menor número posible de tokens.
