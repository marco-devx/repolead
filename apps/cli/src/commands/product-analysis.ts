import { analyzeProductContext } from '@repolead/lead-analyzer';
import type { AnalyzeOptions } from '@repolead/lead-analyzer';

export async function analyzeProductAndPrint(options: AnalyzeOptions): Promise<void> {
  const result = await analyzeProductContext(options);
  console.log(`✓ producto: ${result.documentsAnalyzed} análisis de documentación · ${result.documentsCached} desde caché · contexto ${result.productCached ? 'desde caché' : 'generado'}`);
  console.log(`  tokens de producto: ${result.inputTokens} in / ${result.outputTokens} out`);
}
