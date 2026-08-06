# Embeddings — Hugging Face TEI + Qwen3-Embedding-0.6B

Este servicio no tiene código propio: es Text Embeddings Inference (TEI) servido vía
`docker-compose.yml` en la raíz del repo (servicio `embeddings`).

```bash
docker compose up -d embeddings
curl http://localhost:8080/health
```

El cliente TypeScript con batching vive en `packages/retrieval` (Fase 4).
