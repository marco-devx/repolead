import type { HierarchicalPack } from '../src/hierarchy';
import type { TechLeadModel } from '../src/model';

/** Records orchestration inputs. It makes no assertion about generative quality or billing. */
export class ContractModel implements TechLeadModel {
  readonly packs: HierarchicalPack[] = [];
  constructor(readonly name = 'contract-only-no-semantic-evaluation') {}
  complete(request: { prompt: string; schema: Record<string, unknown> }): ReturnType<TechLeadModel['complete']> {
    const pack = JSON.parse(request.prompt.split('Evidence pack:\n')[1]!.split('\n\nReturn ')[0]!) as HierarchicalPack;
    this.packs.push(pack);
    const empty = (schema: Record<string, unknown>): unknown => {
      if (schema['type'] === 'array') { return []; }
      if (schema['type'] === 'object') {
        return Object.fromEntries(Object.entries(schema['properties'] as Record<string, Record<string, unknown>>)
          .map(([key, value]) => [key, empty(value)]));
      }
      return 'Contract fixture; semantic quality not evaluated.';
    };
    const json = empty(request.schema) as Record<string, unknown>;
    json['evidenceIds'] = pack.evidence.map((entry) => entry.id);
    return Promise.resolve({ json, inputTokens: 0, outputTokens: 0 });
  }
}
