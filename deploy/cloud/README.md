# RepoLead compartido: PostgreSQL, pgvector y SSO corporativo

Esta variante publica en PostgreSQL el contexto preparado localmente y ofrece un MCP remoto autenticado con el mismo Keycloak de `tickets-portal`. La nube no necesita los checkouts originales, SQLite, Qdrant, TEI ni Ollama para recuperar el contexto funcional por texto. Las consultas vectoriales nuevas y la corroboración generativa se resuelven mediante un worker conectado a los modelos locales o a un servicio de inferencia separado.

## Qué cambia y qué se reutiliza

- Los análisis locales ya generados se conservan. **Cambiar de almacenamiento no requiere volver a ejecutar la generación con Ollama.**
- La migración inicial copia los vectores existentes de Qdrant a pgvector sin llamar a modelos de embeddings. Para incorporar cambios de código posteriores sí corresponde el refresh incremental habitual.
- El índice/grafo y la caché de análisis del equipo siguen en SQLite. Los vectores locales pueden vivir en PG con `REPOLEAD_VECTOR_BACKEND=pgvector`; los próximos `reindex`, `refresh` y `onboard` usan ese backend cuando la variable está cargada.
- La nube guarda registros nativos de PostgreSQL: publicaciones, contenido direccionado por hash, vínculos de filas, conocimiento, análisis funcionales, vectores, permisos y trabajos. No guarda un archivo SQLite dentro de PG. El worker reconstruye una caché SQLite privada y desechable en su propia máquina para reutilizar el investigador existente.
- La publicación compara la versión de contenido y reutiliza los blobs/vectores que ya están en PG. Una publicación idéntica devuelve `unchanged=true`. Una carga incompleta no reemplaza la activa. La activación es atómica por repositorio.
- Los vectores originales mantienen float32 y su identidad exacta de modelo/hash/dimensión. Para 2.560 dimensiones se crea un índice HNSW `halfvec`, conservando el vector completo. La recuperación funcional actual calcula la distancia sobre el vector float32 de la proyección autorizada.

## Componentes y recursos

| Componente | Ubicación | Función |
|---|---|---|
| PostgreSQL 17 + pgvector 0.8.7 | Nube; o PG administrado compatible | Contexto publicado, vectores, permisos, colas y caché de consultas |
| MCP `cloud serve` | Contenedor cloud | OAuth/OIDC, autorización por repositorio, cuatro herramientas de Producto |
| Proxy HTTPS | Ingress corporativo o perfil Caddy opcional | Dominio estable y terminación TLS |
| Análisis/indexado | Equipo local | Actualizar el contexto con los modelos y el código local |
| Worker | Equipo local o host de inferencia | Embeddings de consultas y corroboración de código con citas |

El Compose reserva **2 GiB y 1,25 CPU para PG**, **768 MiB y 0,5 CPU para MCP**, y **128 MiB y 0,25 CPU para el proxy opcional**. Es un perfil inicial para el servicio de consulta de diez personas diarias, con margen del sistema dentro de una máquina de 4 GiB y 2 vCPU; no es una medición de capacidad ni un SLA para diez investigaciones simultáneas. Mantener SSD y copias operativas según la política de Infraestructura; los datos de publicaciones históricas requieren seguimiento de crecimiento/retención.

Los modelos Qwen 4B/9B no están incluidos en ese presupuesto. El worker limita/encola investigaciones y usa inferencia fuera del servidor de consulta. Con el worker apagado, el contexto publicado sigue disponible por texto; los embeddings ya cacheados pueden seguir utilizándose. Una consulta semántica nueva o una corroboración nueva espera al worker. Para independencia total del equipo local, Arquitectura debe alojar ese worker y sus endpoints de inferencia en otro recurso.

## 1. Variables

En la instalación de RepoLead:

```bash
cp deploy/cloud/cloud.env.example .env.cloud
chmod 600 .env.cloud
bun install --frozen-lockfile
bun run build
```

Completar `.env.cloud`, que está excluido de Git:

| Variable | Valor a colocar |
|---|---|
| `AUTH_OIDC_ISSUER_URL` | **Exactamente el issuer del despliegue de tickets-portal**, incluida la ruta `/realms/<realm>`. No copiar los hosts de ejemplo de sus documentos. |
| `BASE_URL` | Origen HTTPS estable del MCP, sin `/mcp`; por ejemplo `https://contexto.empresa.com`. |
| `REPOLEAD_MCP_DOMAIN` | Ese hostname, si se usa el proxy Caddy incluido. |
| `REPOLEAD_PG_LOCAL_URL` | PG de preparación local: propietario con permiso sobre el índice vectorial. |
| `REPOLEAD_PG_PUBLISH_URL` | PG cloud: credencial de publicación/administración, usada solo en el equipo operador. |
| `REPOLEAD_PG_READ_URL` | PG cloud: credencial `repolead_app` para el contenedor MCP. |
| `REPOLEAD_PG_WORKER_URL` | PG cloud: credencial `repolead_worker`, con lectura de fuente e índices y actualización de la cola. |
| `REPOLEAD_VECTOR_BACKEND` | `pgvector`. |
| `REPOLEAD_LOCAL_PG_TLS` | `disable` para el PG local por loopback; `verify-full` si corresponde. |
| `REPOLEAD_PG_TLS` | `verify-full` para PG cloud por TCP con certificados válidos. `disable` solo para la red privada de Compose o loopback protegido por túnel SSH. |
| `REPOLEAD_PG_CA_FILE` | Opcional: CA corporativa/RDS; el archivo también debe montarse en el contenedor que la utilice. |
| `REPOLEAD_TEI_URL` | Endpoint de embeddings local, actualmente `http://127.0.0.1:8082`. Debe corresponder al modelo de los vectores publicados. |
| `REPOLEAD_RESEARCH_OLLAMA_URL` | Ollama local, normalmente `http://127.0.0.1:11434`. |
| `REPOLEAD_RESEARCH_MODEL` | Modelo local instalado; por defecto `qwen3.5:9b-q4_K_M`. |

La plantilla permite probar un PG autocontenido por loopback. Para un PG administrado se reemplazan las URLs y se habilita `verify-full`. Usar credenciales diferentes para preparación local, publicación, MCP y worker cuando se encuentren en hosts distintos. Los secretos del cliente OAuth se guardan en Keycloak/Claude, no en el plugin ni en Git.

Si se necesita una CA privada, definir `REPOLEAD_PG_CA_FILE` con la ruta dentro del contenedor y añadir un mount de solo lectura mediante un override de Compose, tanto para MCP como para worker. La plantilla no monta certificados del host automáticamente. En el proceso CLI esa variable apunta al archivo local.

## 2. PostgreSQL local y migración inicial

Si aún no existe PG local, el perfil `database` crea una instancia separada; no modifica los contenedores de los modelos:

```bash
docker compose --env-file .env.cloud -f docker-compose.cloud.yml --profile database up -d postgres
```

En ese perfil, `REPOLEAD_OWNER_PASSWORD`, `REPOLEAD_APP_PASSWORD` y `REPOLEAD_WORKER_PASSWORD` crean los roles iniciales. La contraseña de `REPOLEAD_PG_LOCAL_URL` debe coincidir con la del propietario local. Los scripts de inicialización solo corren sobre un volumen nuevo. No borrar volúmenes existentes para cambiar contraseñas.

La fuente Qdrant previa debe estar accesible durante la migración. Si su contenedor está detenido, iniciar únicamente ese servicio de la instalación original, conservando su volumen:

```bash
docker compose -f /ruta/repolead/docker-compose.yml up -d --no-deps --no-recreate qdrant
```

Desde `/home/marco-devx/companies/wlt`:

```bash
make producto-preparar
make producto-migrar-vectores
```

El primer comando valida las bases y muestra las publicaciones candidatas; no conecta a PG/Qdrant ni llama a modelos. El segundo copia los vectores existentes al PG local. Ambos reutilizan la selección Python/React/React Native de WLT y sus exclusiones. Un error de procedencia/modelo/snapshot exige terminar el índice correspondiente, no borrar toda la memoria ni regenerar todo.

Los wrappers de WLT pasan `--available-only`: informan y omiten repositorios sin base o con análisis/índice en curso, para publicar los ya completos. No ocultan errores de red, permisos o procedencia vectorial durante la transferencia. Si ninguno está listo, el comando falla. La CLI genérica es estricta sin esa opción.

Alternativa genérica desde RepoLead: crear un JSON con los aliases autorizados y ejecutar:

```bash
repolead cloud --env-file .env.cloud import-vectors --dir /ruta/repos --repos-file autorizados.json
```

## 3. Inicializar y publicar en PG cloud

Arquitectura habilita la extensión `vector` y crea los roles `repolead_app` y `repolead_worker`, o aplica permisos equivalentes. `migrate` concede a esos nombres los permisos definidos en `packages/cloud/src/schema.ts`: el MCP puede leer la proyección funcional y operar trabajos, pero **no leer los blobs de código ni las filas del índice capturado**. El worker sí puede leer ese material para corroborarlo. El perfil PG de Compose crea los roles automáticamente en una base nueva.

Desde RepoLead, con el propietario cloud configurado:

```bash
make cloud-init
```

Desde WLT:

```bash
make producto-publicar
```

La publicación incluye análisis, fuente capturada, grafo, índices de conocimiento y vectores. El servidor no necesita una copia del checkout. La primera transferencia puede tardar según volumen y red; repetirla sin cambios evita la carga. Las cargas nuevas reutilizan contenido/vectores por hash. Los vectores nuevos se generan durante el reindexado local, no al publicar en la nube.

Después de cambios de código, actualizar lo que corresponda y publicar:

```bash
make producto-refrescar
make producto-publicar
```

El refresh por fases de WLT carga la configuración PG, omite el arranque/healthcheck de Qdrant y mantiene la separación de generación/embeddings. La publicación no ejecuta un refresh implícito. El worker y el runner usan el mismo lock de GPU: los trabajos esperan durante las fases exclusivas y el refresh espera a que termine una investigación activa antes de cambiar servicios.

## 4. Contenedor del MCP y HTTPS

En el host cloud:

```bash
docker compose --env-file .env.cloud -f docker-compose.cloud.yml build mcp
docker compose --env-file .env.cloud -f docker-compose.cloud.yml up -d mcp
```

Con PG administrado solo hace falta el servicio MCP y el ingress. Con PG autocontenido se añade `--profile database`. Para usar el proxy incluido, añadir `--profile edge` y permitir la emisión del certificado del dominio configurado. Si la organización ya tiene ingress, dirigir `/mcp`, `/.well-known/oauth-protected-resource` y `/.well-known/oauth-protected-resource/mcp` al servicio; `/healthz` comprueba PG y el esquema. Conservar los encabezados Authorization y WWW-Authenticate.

El MCP se vincula a loopback en el host por defecto. PG se publica solo en loopback para operaciones por VPN/túnel; no se deben abrir puertos de base al público para conectar Claude. La imagen no contiene checkouts de WLT, archivos `.env`, `.repolead` ni los documentos internos de `docs/temps`.

## 5. SSO en el mismo Keycloak de tickets-portal

Se reutiliza el patrón del portal: identidad de Keycloak y permisos propios comprobados en PG. El portal tiene una sesión de navegador; MCP es un recurso OAuth protegido y recibe tokens del cliente Claude. No se reutilizan sus cookies ni su client secret.

1. Importar `keycloak-client.example.json` en **el mismo realm corporativo**, como cliente nuevo `repolead-producto-mcp`.
2. Reemplazar `included.custom.audience` por **`${BASE_URL}/mcp`**, exactamente. Mantener ese valor estable.
3. Conservar Authorization Code, PKCE S256, autenticación del cliente y los scopes profile/email. El cliente solicita openid. Mantener desactivados los grants directos, implícitos y de service account.
4. Mantener las callbacks de Claude indicadas en la plantilla y contrastarlas con la configuración vigente del cliente. Generar su secret desde Keycloak y entregarlo únicamente al administrador del conector.
5. Autorizar las cuentas de Producto en PG. Por ejemplo, desde RepoLead:

```bash
make cloud-grant EMAIL=producto@empresa.com
# O limitar repositorios:
repolead cloud --env-file .env.cloud grant producto@empresa.com --repos access-service,access-webapp
# Revocación inmediata en la siguiente petición:
repolead cloud --env-file .env.cloud grant producto@empresa.com --revoke
```

Opcionalmente `--subject <sub>` vincula el permiso también al identificador estable de Keycloak. La cuenta necesita email verificado. Los roles/grupos del token no conceden permisos automáticamente.

En Claude Desktop/Cowork, el administrador registra `${BASE_URL}/mcp`, selecciona **Iniciar sesión ahora** y **Usar tu propio cliente OAuth**, y configura el client ID y secret del cliente nuevo. Retirar el encabezado Authorization manual de la demo anterior para que Claude use el token OAuth obtenido al iniciar sesión. Cada persona se conecta con su cuenta corporativa y debe tener un grant local vigente.

La copia de prueba del plugin adaptada a este perfil está en `docs/temps/wlt-producto-pg-sso` y su archivo instalable `docs/temps/wlt-producto-pg-sso.plugin` dentro del workspace local. Conserva la plantilla Word y añade seguimiento de `semanticJobId`, corroboración y conexión SSO. Estos materiales internos no se incluyen en la imagen ni se versionan en el repositorio público.

El recurso publica metadata RFC 9728 y el desafío WWW-Authenticate; valida firma JWKS, issuer, audience del MCP, expiración, tipo de token, scope, email verificado y permisos actuales. Los tokens del portal o un token compartido de la demo no autorizan el MCP cloud. El issuer y los endpoints necesarios para el flujo deben ser accesibles según la red de Claude y de la organización.

## 6. Worker y comportamiento de las herramientas

Desde WLT, manteniendo disponibles los endpoints locales de TEI/Ollama:

```bash
make producto-worker
```

También existe un worker contenerizado para Linux. Desde RepoLead:

```bash
make producto-worker-container
```

Usa red host para acceder a los servicios loopback existentes y comparte el lock de GPU con el runner local. No inicia, detiene ni descarga modelos por su cuenta. Su caché `/data/worker` es local y privada. La cola PG usa leases y fencing para que un worker vencido no publique resultados; los trabajos persisten durante desconexiones y los fallos pueden reintentarse. La cola admite hasta cuatro investigaciones pendientes/en ejecución y limita los reintentos de leases vencidos.

- `product_catalog`: inventario autorizado y temas de la carga activa.
- `product_context`: FTS y pgvector sobre la proyección funcional. Si falta el embedding de una pregunta nueva, devuelve contexto léxico y `semanticJobId`. Consultar ese job y repetir la consulta cuando termine. La recuperación cloud no aplica reranker por defecto y lo informa en `retrieval.reranked`.
- `product_evidence`: ampliar un análisis funcional ya publicado.
- `product_investigate`: iniciar/consultar una investigación con fuente y dependencias. El worker hace borrador y revisión con el modelo local y publica hallazgos funcionales con citas. Nunca hay una herramienta de descarga de código. `sourceRefs` permite profundizar sin depender exclusivamente de resúmenes.

Las consultas repetidas reutilizan embeddings y resultados vigentes. Las publicaciones nuevas invalidan los jobs anteriores para responder sobre la carga actual. Las referencias de trabajos también están vinculadas al usuario autenticado.

Los cinco repositorios sin entradas generativas detectadas no ganan resúmenes por cambiar de base. Su fuente/grafo se publica y puede investigarse por palabras clave; ampliar sus selectores es una mejora separada. La corroboración continúa siendo una interpretación del código, no una prueba formal del comportamiento desplegado.

## Verificación y límites de la entrega

Se incluyen pruebas contra PostgreSQL/pgvector real con datos de ejemplo y un issuer OIDC/JWKS controlado: migración sin llamadas a modelos, dimensiones 2560, publicación incremental/atómica, caché de reindexado, aislamiento entre repositorios, rechazo de tokens inválidos/del portal/expirados, grants revocados, búsqueda semántica y trabajo de corroboración. Los tests crean su propia base temporal; no utilizan un realm corporativo ni generan con los modelos reales.

Para ejecutarlas, configurar `REPOLEAD_TEST_PG_URL` hacia un PG local de pruebas con permiso de crear bases y correr `bun run test packages/cloud/src/cloud.integration.test.ts`. Las comprobaciones de concurrencia/GPU usan un lock temporal y los tests del runner usan servicios falsos.

Antes de habilitar la organización faltan los recursos reales de PG, DNS/HTTPS y el cliente Keycloak importado/configurado por Arquitectura. El login en el realm real y el alta del conector en la cuenta de Producto se validan con esos datos; el código no los adivina ni crea recursos cloud automáticamente.

Referencia local del SSO: `/home/marco-devx/companies/wlt/tickets-portal/docs/02-keycloak-sso.md`.
Fuentes: [Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers), [autorización MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [pgvector](https://github.com/pgvector/pgvector) y [conectores Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
