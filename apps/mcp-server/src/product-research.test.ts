import { expect, test } from '@rstest/core';
import { contentHash, fileUri } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import type { TechLeadModel, ModelCompletion, ModelRequest } from '@repolead/lead-analyzer';
import { productView } from './product';
import { prepareResearchSources } from './product-research-sources';
import { ProductResearchHub } from './product-research';

async function fixture() {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'admin', rootPath: '/checkout-does-not-exist' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  const contents: Record<string, string> = {
    'src/application/use_cases/site/create_site.py': 'from src.application.services.site_guard import check\nfrom src.domain.ports.repositories.site_repository import SiteRepository\nfrom src.application.dtos.site import SiteDTO\nclass CreateSiteUseCase:\n    def execute(self, request):\n        check(request.unit)\n',
    'src/application/services/site_guard.py': 'def check(unit):\n    if not unit.is_active:\n        raise InactiveUnit()\n# CANARY_RAW_CODE\napi_key = "CANARY_PRIVATE_TOKEN_12345"\n',
    'src/application/dtos/site.py': 'class SiteDTO:\n    root_unit_id: int | None\n',
    'src/domain/ports/repositories/site_repository.py': 'class SiteRepository:\n    pass\n',
    'src/infrastructure/repositories/site_repository_impl.py': 'from src.infrastructure.models.site_model import SiteModel\nclass SiteRepositoryImpl:\n    pass\n',
    'src/infrastructure/models/site_model.py': 'class SiteModel:\n    root_unit_id: int | None\n',
    'src/pages/ManageSitePage.tsx': 'import { Form } from "../components/SiteForm";\nexport const ManageSitePage = () => <Form/>;\n',
    'src/components/SiteForm.tsx': 'export const Form = () => <input required />;\n',
    'src/unrelated/private.py': 'CANARY_UNRELATED_CODE = True\n',
  };
  store.insertFiles(Object.entries(contents).map(([path, content]) => ({ id: fileUri('admin', path), repositoryId: repository.id,
    snapshotId: snapshot.id, path, language: path.endsWith('.py') ? 'python' : 'tsx', contentHash: contentHash(content),
    lineCount: content.split('\n').length, lastAuthor: null, lastCommitAt: null })));
  store.insertSnapshotSources(snapshot.id, Object.entries(contents).map(([path, content]) => ({ path, content, contentHash: contentHash(content) })));
  store.setSnapshotMetadata(snapshot.id, 'synthesis_mode', 'entrypoints');
  store.setSnapshotMetadata(snapshot.id, 'knowledge_projection', 'projection');
  store.setSnapshotMetadata(snapshot.id, 'technical_analysis', JSON.stringify({ status: 'complete', synthesisMode: 'entrypoints', selectionComplete: true, entrypoints: 2 }));
  store.setSnapshotMetadata(snapshot.id, 'product_analysis', '{"status":"complete"}');
  const entries = [{ name: 'CreateSiteUseCase', path: 'src/application/use_cases/site/create_site.py', kind: 'usecase' },
    { name: 'ManageSitePage', path: 'src/pages/ManageSitePage.tsx', kind: 'page' }];
  store.setSnapshotMetadata(snapshot.id, 'entrypoint_catalog', JSON.stringify(entries.map((entry) => ({ ...entry, summarySubjectId: fileUri('admin', entry.path) }))));
  entries.forEach((entry, index) => store.insertSummary({ id: `s-${index}`, snapshotId: snapshot.id, subjectId: fileUri('admin', entry.path),
    level: 'file', contentJson: JSON.stringify({ responsibility: entry.name, businessRules: ['Calls a guard.'], unknowns: [] }),
    contentHash: 'summary', model: 'fixture', promptVersion: '7', createdAt: new Date().toISOString() },
  [{ id: `e-${index}`, kind: 'source', path: entry.path, startLine: 1, endLine: 3, contentHash: contentHash(contents[entry.path]!), parentIds: [] }]));
  const repo = { name: 'admin', store };
  const view = productView(repo)!;
  return { store, repo, view, snapshot, refs: view.records.filter((record) => record.kind === 'usecase').map((record) => record.ref) };
}

function completion(request: ModelRequest, injectBad = false): ModelCompletion {
  const prompt = JSON.parse(request.prompt) as { sources: { path: string; ref: string; numberedSource: string }[] };
  const source = prompt.sources.find((entry) => entry.path.endsWith('site_guard.py'))!;
  expect(source.numberedSource).not.toContain('CANARY_PRIVATE_TOKEN_12345');
  const finding = { statement: 'El control revisado rechaza unidades inactivas.', basis: 'supported-in-reviewed-code',
    evidenceKind: 'explicit-behavior',
    explanation: 'La condición está en el cuerpo del validador.', citations: [{ ref: source.ref, firstLine: 1, lastLine: 3 }] };
  return { inputTokens: 100, outputTokens: 20, json: {
    findings: [finding, ...(injectBad ? [{ ...finding, statement: 'password=CANARY_OUTPUT_SECRET' },
      { ...finding, citations: [{ ref: 'source:invented', firstLine: 1, lastLine: 99999 }] }] : [])],
    unknowns: ['No se comprobó la configuración del cliente.'], nextChecks: [],
  } };
}

async function settle(hub: ProductResearchHub, id: string) {
  for (let i = 0; i < 100; i++) {
    const value = hub.status('admin', id, 120000);
    if (['complete', 'failed'].includes(String(value['status']))) { return value; }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Research did not settle');
}

test('research follows captured validators, DTO and candidate implementation/model without checkout access', async () => {
  const { store, view, refs } = await fixture();
  try {
    const pack = prepareResearchSources(view, { question: 'Site root units', refs });
    const paths = pack.sources.map((source) => source.path);
    expect(paths).toContain('src/application/services/site_guard.py');
    expect(paths).toContain('src/application/dtos/site.py');
    expect(paths).toContain('src/infrastructure/repositories/site_repository_impl.py');
    expect(paths).toContain('src/infrastructure/models/site_model.py');
    expect(paths).not.toContain('src/unrelated/private.py');
    expect(pack.redactions).toBe(1);
    expect(pack.sources.map((source) => source.text).join('')).not.toContain('CANARY_PRIVATE_TOKEN_12345');
    const guardRef = pack.sources.find((source) => source.path.endsWith('site_guard.py'))!.ref;
    const focused = prepareResearchSources(view, { question: 'Guard', sourceRefs: [guardRef] });
    expect(focused.sources[0]!.reason).toBe('followed-source-reference');
    expect(() => prepareResearchSources(view, { question: 'Guard', sourceRefs: ['source:foreign'] })).toThrow();
    const withoutSummaries = prepareResearchSources({ ...view, records: [], subjects: new Map() }, { question: 'Site guard' });
    expect(withoutSummaries.sources.some((source) => source.reason === 'indexed-source-discovery-no-summary')).toBe(true);
    const page = view.records.find((record) => record.kind === 'page')!;
    expect(prepareResearchSources(view, { question: 'Form', refs: [page.ref] }).sources.map((source) => source.path)).toContain('src/components/SiteForm.tsx');
    expect(() => prepareResearchSources(view, { question: 'Site', refs: ['product:foreign'] })).toThrow();
    store.db.prepare('UPDATE source_blobs SET content = ? WHERE content_hash = ?').run('tampered', pack.sources.find((source) => source.path.endsWith('site_guard.py'))!.hash);
    const tampered = prepareResearchSources(view, { question: 'Site', refs });
    expect(tampered.omitted.some((item) => item.path.endsWith('site_guard.py') && item.reason.includes('inconsistent'))).toBe(true);
  } finally { store.close(); }
});

test('local investigation returns validated functional citations, caches results and isolates refs', async () => {
  const { store, repo, refs, snapshot } = await fixture(); let calls = 0;
  const model: TechLeadModel = { name: 'local-test', locality: 'local', complete: async (request) => { calls++; return completion(request, true); } };
  const hub = new ProductResearchHub([repo], productView, async () => model);
  try {
    const started = hub.start('admin', { question: 'Site guard active unit', refs }, 120000);
    expect(started['status']).toBe('queued');
    const done = await settle(hub, String(started['jobId']));
    const result = done['result'] as { findings: unknown[]; rejectedFindings: number };
    expect(result.findings).toHaveLength(1); expect(result.rejectedFindings).toBe(2);
    expect(JSON.stringify(done)).not.toContain('CANARY');
    expect(hub.start('admin', { question: 'Site guard active unit', refs }, 120000)['reused']).toBe(true);
    expect(calls).toBe(2);
    expect(hub.status('other', String(started['jobId']), 120000)['error']).toBeDefined();
    expect(hub.status('admin', String(started['jobId']), 512)['result']).toBeUndefined();
    store.setSnapshotMetadata(snapshot.id, 'technical_analysis', '{"status":"running"}');
    expect(hub.status('admin', String(started['jobId']), 120000)['status']).toBe('stale');
  } finally { store.close(); }
});

test('research rejects remote fallback and permits an explicit retry after failure', async () => {
  const { store, repo, refs } = await fixture(); let remote = true; let calls = 0;
  const hub = new ProductResearchHub([repo], productView, async () => ({ name: 'test', locality: remote ? 'remote' : 'local',
    complete: async (request) => { calls++; return completion(request); } }));
  try {
    const input = { question: 'Site root unit', refs };
    const first = hub.start('admin', input, 120000);
    expect((await settle(hub, String(first['jobId'])))['status']).toBe('failed');
    expect(calls).toBe(0);
    remote = false;
    const second = hub.start('admin', input, 120000);
    expect((await settle(hub, String(second['jobId'])))['status']).toBe('complete');
    expect(calls).toBe(2);
  } finally { store.close(); }
});

test('research queues at most four jobs and serializes local generations', async () => {
  const { store, repo, refs } = await fixture(); let active = 0; let maximum = 0;
  const hub = new ProductResearchHub([repo], productView, async () => ({ name: 'test', locality: 'local', complete: async (request) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--; return completion(request);
  } }));
  try {
    const jobs = Array.from({ length: 4 }, (_, index) => hub.start('admin', { question: `Site question ${index}`, refs }, 120000));
    expect(hub.start('admin', { question: 'Site fifth question', refs }, 120000)['status']).toBe('busy');
    for (const job of jobs) { expect((await settle(hub, String(job['jobId'])))['status']).toBe('complete'); }
    expect(maximum).toBe(1);
  } finally { store.close(); }
});

test('research publishes the source review instead of an uncorrected first draft', async () => {
  const { store, repo, refs } = await fixture(); let calls = 0;
  const hub = new ProductResearchHub([repo], productView, async () => ({ name: 'review-test', locality: 'local', complete: async (request) => {
    calls++;
    const output = completion(request);
    if (!JSON.parse(request.prompt).phase) {
      (output.json as { findings: { statement: string }[] }).findings[0]!.statement = 'El validador no hace ninguna comprobación.';
    }
    return output;
  } }));
  try {
    const started = hub.start('admin', { question: 'Site guard', refs }, 120000);
    const done = await settle(hub, String(started['jobId']));
    expect(JSON.stringify(done)).toContain('rechaza unidades inactivas');
    expect(JSON.stringify(done)).not.toContain('no hace ninguna comprobación');
    expect(calls).toBe(2);
  } finally { store.close(); }
});
