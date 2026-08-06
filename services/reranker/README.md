# Reranker

Se sirve con **TEI** y **BAAI/bge-reranker-v2-m3** (multilingüe, XLM-RoBERTa
sequence-classification — soportado nativamente por TEI CPU), vía el servicio
`reranker` de `docker-compose.yml` (endpoint `/rerank`, puerto 8081).

```bash
docker compose up -d reranker
curl http://localhost:8081/health
```

La conversión seq-cls de Qwen3-Reranker-0.6B quedó descartada para CPU: el
repo no publica pesos ONNX y candle no soporta esa arquitectura en CPU, así
que TEI no puede cargarla. Alternativas si se quiere Qwen3-Reranker: TEI con
GPU, o el servicio Python propio (diferido).
