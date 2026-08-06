# Reranker — Qwen3-Reranker-0.6B

En la v1 el reranking se sirve con **TEI** y la conversión sequence-classification
de Qwen3-Reranker-0.6B (`tomaarsen/Qwen3-Reranker-0.6B-seq-cls`), vía el servicio
`reranker` de `docker-compose.yml` (endpoint `/rerank`, puerto 8081).

```bash
docker compose up -d reranker
curl http://localhost:8081/health
```

El servicio Python propio (FastAPI + modelo original) queda diferido: solo se
justifica si la conversión seq-cls muestra pérdida de calidad apreciable.
