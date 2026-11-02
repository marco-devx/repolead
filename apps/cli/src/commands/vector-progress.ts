import type { IndexProgress } from '@repolead/retrieval';

export function printVectorProgress({ embedded, reused, metadataUpdated, incompleteSources, omitted }: IndexProgress): void {
  console.log(`  embeddings: ${embedded} nuevos · ${reused} reutilizados · ${metadataUpdated} payloads actualizados`);
  if (incompleteSources) { console.warn(`  ${incompleteSources} símbolos sin cuerpo persistido: usa refresh para snapshots antiguos.`); }
  for (const item of omitted) { console.warn(`  omitido ${item.itemId}: ${item.reason}`); }
}
