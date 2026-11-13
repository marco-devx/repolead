import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { QdrantRestClient, TeiEmbeddingsClient, TeiRerankerClient, hybridKnowledgeSearch, indexSnapshot, symbolIdToPointId } from '@repolead/retrieval';
import type { IndexProgress } from '@repolead/retrieval';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'repolead-retrieval-'));
const root = join(tempRoot, 'repository');
const dbPath = join(tempRoot, 'knowledge.db');
const collection = `repolead-acceptance-${randomUUID()}`;
const urls = {
  embeddings: process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8082',
  reranker: process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081',
  qdrant: process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333',
};
const embeddings = new TeiEmbeddingsClient(urls.embeddings);
const reranker = new TeiRerankerClient(urls.reranker);
const qdrant = new QdrantRestClient(urls.qdrant);
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
const sources = [
  ['billing', 'refundCapturedPayment', 'invoice, amount', 'if (invoice.status !== "captured") throw new Error("Cannot refund unsettled payment"); return paymentGateway.refund(invoice.chargeId, amount);'],
  ['security', 'resetAccountPassword', 'userId, newPassword', 'const hash = passwordHasher.hash(newPassword); database.updatePassword(userId, hash); return sessions.revokeAll(userId);'],
  ['inventory', 'reserveWarehouseStock', 'sku, quantity', 'const available = inventory.quantity(sku); if (available < quantity) throw new Error("Insufficient stock"); return inventory.reserve(sku, quantity);'],
  ['operations', 'createDailyBackup', 'database', 'const archive = database.exportSnapshot(); return backupStorage.upload("daily-backup", archive);'],
  ['notifications', 'publishWelcomeEmail', 'address', 'return mailer.send(address, "Welcome aboard", "Your account is ready. Complete the onboarding checklist.");'],
  ['security', 'enforceRequestRateLimit', 'ip', 'const requests = requestCounter.increment(ip, "one-minute"); if (requests > 100) throw new Error("Too many requests"); return true;'],
  ['billing', 'calculateInvoiceTax', 'subtotal, taxRate', 'return Math.round(subtotal * taxRate * 100) / 100;'],
  ['catalog', 'invalidateProductCache', 'productId', 'return cache.delete("catalog:product:" + productId);'],
  ['ui', 'renderHomepage', 'user', 'return templates.render("home", { user });'],
  ['maps', 'geoDistance', 'origin, destination', 'return haversine(origin.latitude, origin.longitude, destination.latitude, destination.longitude);'],
  ['media', 'compressImage', 'buffer', 'return imageEncoder.webp(buffer, { quality: 75 });'],
  ['media', 'resizeThumbnail', 'buffer', 'return imageProcessor.resize(buffer, 120, 120);'],
  ['imports', 'parseCSV', 'text', 'return text.split("\\n").map(line => line.split(","));'],
  ['validation', 'validateEmail', 'address', 'return /^[^@]+@[^@]+\\.[^@]+$/.test(address);'],
  ['presentation', 'formatCurrency', 'amount', 'return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);'],
  ['operations', 'rotateLogs', 'logFile', 'return filesystem.rename(logFile, logFile + ".old");'],
  ['orders', 'archiveCompletedOrders', 'orders', 'return archive.write(orders.filter(order => order.status === "completed"));'],
  ['shipping', 'generateShipmentLabel', 'shipment', 'return carrier.createLabel(shipment.address, shipment.weight);'],
  ['shipping', 'trackDelivery', 'trackingNumber', 'return carrier.deliveryStatus(trackingNumber);'],
  ['payroll', 'exportPayroll', 'employees', 'return spreadsheet.write(employees.map(employee => [employee.name, employee.salary]));'],
  ['profiles', 'uploadAvatar', 'userId, image', 'return objectStorage.put("avatars/" + userId, image);'],
  ['games', 'sortLeaderboard', 'players', 'return players.sort((left, right) => right.score - left.score);'],
  ['calendar', 'convertTimezone', 'timestamp, timezone', 'return new Date(timestamp).toLocaleString("en-US", { timeZone: timezone });'],
  ['contacts', 'normalizePhone', 'phone', 'return phone.replace(/[^0-9+]/g, "");'],
  ['subscriptions', 'checkSubscriptionPlan', 'account', 'return account.plan === "premium" && account.expiresAt > Date.now();'],
  ['messaging', 'serializeMessage', 'payload', 'return JSON.stringify({ version: 1, payload });'],
  ['security', 'verifyWebhookSignature', 'payload, signature', 'return crypto.constantTimeEqual(crypto.hmac(payload, webhookSecret), signature);'],
  ['search', 'filterSearchResults', 'results, keyword', 'return results.filter(result => result.title.includes(keyword));'],
] as const;
const questions = [
  ['¿Dónde se devuelve el dinero de un pago ya cobrado?', 'refundCapturedPayment', 'es'],
  ['¿Cómo cambiar la contraseña e invalidar las sesiones del usuario?', 'resetAccountPassword', 'es'],
  ['¿Qué función reserva existencias y evita vender más unidades de las disponibles?', 'reserveWarehouseStock', 'es'],
  ['¿Dónde se genera la copia de seguridad diaria de la base de datos?', 'createDailyBackup', 'es'],
  ['Where is the new customer welcome message sent?', 'publishWelcomeEmail', 'en'],
  ['How do we block an IP that sends over one hundred requests per minute?', 'enforceRequestRateLimit', 'en'],
  ['Where do we compute the sales tax amount on an invoice?', 'calculateInvoiceTax', 'en'],
  ['Which function evicts a stale catalog product from the cache?', 'invalidateProductCache', 'en'],
] as const;
try {
  const [embeddingInfo, rerankerInfo, qdrantInfo] = await Promise.all([
    fetch(`${urls.embeddings}/info`).then((response) => response.json()),
    fetch(`${urls.reranker}/info`).then((response) => response.json()),
    fetch(`${urls.qdrant}/`).then((response) => response.json()),
  ]);
  assert.ok(await embeddings.cacheKey(), 'Pin the TEI model revision before running acceptance');
  mkdirSync(root, { recursive: true });
  for (const [module, name, args, body] of sources) {
    mkdirSync(join(root, 'src', module), { recursive: true });
    writeFileSync(join(root, 'src', module, `${name}.ts`), `export function ${name}(${args}) {\n  ${body}\n}\n`);
  }
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, '.repolead.yaml'), 'version: 1\nmodules:\n  - name: billing\n    path: src/billing\n  - name: security\n    path: src/security\n');
  writeFileSync(join(root, 'package.json'), '{"name":"retrieval-acceptance"}');
  writeFileSync(join(root, 'docs/product.md'), '# Payment product\nSupport managers approve customer reimbursement requests.\n## Business rules\nOnly captured payments can be refunded.\n## Non-goals\nBank transfer reconciliation is not supported.\n');
  writeFileSync(join(root, 'src/billing/refund.test.ts'), 'test("refund rejects unsettled payments", () => { expect(() => refundCapturedPayment({ status: "pending" }, 12)).toThrow("Cannot refund unsettled payment"); });\n');
  git('init', '-b', 'main'); git('config', 'user.name', 'RepoLead acceptance'); git('config', 'user.email', 'acceptance@example.invalid'); git('add', '.'); git('commit', '-m', 'Retrieval fixture');
  const scan = await scanRepository({ rootPath: root, dbPath, repositoryName: 'Retrieval acceptance', scip: false });
  const store = await openStore(dbPath);
  const report: Record<string, unknown> = {};
  try {
    // These are labeled fixtures for retrieval, not outputs from a generative model or judge.
    const repository = store.getRepository(store.getLatestSnapshot()!.repositoryId)!;
    store.insertSummary({ id: 'fixture-product', snapshotId: scan.snapshotId, subjectId: repository.id, level: 'product', contentHash: 'fixture-product', model: 'handwritten-retrieval-fixture', promptVersion: 'fixture', createdAt: new Date().toISOString(),
      contentJson: JSON.stringify({ purpose: 'Payment refunds', userFlows: [{ description: 'Support managers approve customer reimbursements' }], unknowns: ['Handwritten acceptance fixture; product analysis quality is not evaluated.'] }) });
    store.insertFinding({ id: 'fixture-finding', snapshotId: scan.snapshotId, repositoryId: repository.id, ruleId: 'FIXTURE-AUTHORIZATION', severity: 'high', confidence: 1, claim: 'Refund handler has no explicit authorization check in its body', recommendation: null, module: 'billing', status: 'confirmed', supersededBy: null, createdAt: new Date().toISOString() },
      [{ id: 'fixture-evidence', ownerId: 'fixture-finding', ownerKind: 'finding', path: 'src/billing/refundCapturedPayment.ts', startLine: 1, endLine: 3, excerpt: 'The fixture handler checks payment status and calls the payment gateway.' }]);
    const base = { store, snapshotId: scan.snapshotId, repositoryName: repository.name, collection, embeddings, qdrant };
    let initial: IndexProgress | undefined;
    // Prove that reindex reads stored source rather than the current filesystem.
    renameSync(root, `${root}-unmounted`);
    try {
      await indexSnapshot({ ...base, onProgress: (value) => { initial = value; } });
    } finally { renameSync(`${root}-unmounted`, root); }
    assert.equal(initial!.incompleteSources, 0);
    assert.equal(initial!.omitted.length, 0);
    const testItem = store.listKnowledgeItems(scan.snapshotId, { entityKinds: ['test'] })[0];
    assert.ok(testItem?.text.includes('toThrow("Cannot refund unsettled payment")'), 'Test search must contain the complete indexed test body');
    let repeated: IndexProgress | undefined;
    await indexSnapshot({ ...base, onProgress: (value) => { repeated = value; } });
    assert.equal(repeated!.embedded, 0);
    assert.equal(repeated!.metadataUpdated, 0);
    const warnings: string[] = [];
    const results = [];
    for (const [query, expected, language] of questions) {
      const hits = await hybridKnowledgeSearch({ ...base, query, filters: { entityKinds: ['symbol'] }, reranker, limit: 5, onWarning: (message) => warnings.push(message) });
      const rank = hits.findIndex((hit) => hit.item.title === expected) + 1;
      results.push({ query, expected, language, rank: rank || null, top5: hits.map((hit) => hit.item.title), sources: hits.map((hit) => hit.sources) });
      console.log(`${language} top5=${rank > 0} rank=${rank}: ${expected}`);
    }
    assert.equal(warnings.length, 0, warnings.join('\n'));
    const filterChecks = [];
    for (const [type, kind, query] of [['document', 'documentation', 'Who approves customer refunds?'], ['summary', 'product', 'Who approves customer refunds?'], ['finding', 'FIXTURE-AUTHORIZATION', 'Missing permission check'], ['test', 'test', 'Refund rejects unsettled payments']] as const) {
      const hits = await hybridKnowledgeSearch({ ...base, query, filters: { entityKinds: [type], kind }, reranker, limit: 5, onWarning: (message) => warnings.push(message) });
      assert.ok(hits.length);
      assert.ok(hits.every((hit) => hit.item.entityKind === type && hit.item.kind === kind));
      filterChecks.push({ type, kind, ids: hits.map((hit) => hit.item.subjectId) });
    }
    const filtered = await hybridKnowledgeSearch({ ...base, query: 'refund payment tax', filters: { entityKinds: ['symbol'], module: 'billing', language: 'typescript' }, reranker, limit: 5 });
    assert.ok(filtered.length >= 2);
    assert.ok(filtered.every((hit) => hit.item.module === 'billing' && hit.item.language === 'typescript'));
    const pointsBefore = await qdrant.retrieve(collection, store.listKnowledgeItems(scan.snapshotId).map((item) => symbolIdToPointId(item.id)));
    const sentinelId = randomUUID();
    await qdrant.upsert(collection, [{ id: sentinelId, vector: pointsBefore[0]!.vector, payload: { repository: 'Other acceptance repository', index_generation: 'keep' } }]);
    const changedPath = join(root, 'src/billing/refundCapturedPayment.ts');
    writeFileSync(changedPath, readFileSync(changedPath, 'utf8').replace('paymentGateway.refund(', 'paymentGateway.refundWithReceipt('));
    rmSync(join(root, 'src/media/resizeThumbnail.ts'));
    const refreshed = await refreshRepository({ rootPath: root, dbPath, scip: false });
    let incremental: IndexProgress | undefined;
    await indexSnapshot({ ...base, snapshotId: refreshed.scan!.snapshotId, onProgress: (value) => { incremental = value; } });
    assert.equal(incremental!.embedded, 1);
    assert.ok(incremental!.reused > 20);
    const current = store.listKnowledgeItems(refreshed.scan!.snapshotId);
    const allPoints = await fetch(`${urls.qdrant}/collections/${collection}/points/scroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 1000, with_payload: true }) }).then((response) => response.json()) as { result: { points: { id: string; payload: Record<string, unknown> }[] } };
    assert.equal(allPoints.result.points.length, current.length + 1);
    assert.ok(allPoints.result.points.some((point) => point.id === sentinelId));
    assert.ok(allPoints.result.points.filter((point) => point.id !== sentinelId).every((point) => point.payload['snapshot_id'] === refreshed.scan!.snapshotId));
    const beforeById = new Map(pointsBefore.map((point) => [point.id, point]));
    const after = await qdrant.retrieve(collection, current.map((item) => symbolIdToPointId(item.id)));
    let unchangedVectors = 0;
    for (const point of after) {
      const previous = beforeById.get(point.id);
      if (previous?.payload['embedding_hash'] === point.payload['embedding_hash']) {
        assert.deepEqual(point.vector, previous.vector);
        unchangedVectors += 1;
      }
    }
    assert.equal(unchangedVectors, incremental!.reused);
    // Verify the compiled MCP wire contract in no-source mode, on this fixture only.
    const client = new Client({ name: 'retrieval-acceptance', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, 'apps/cli/dist/index.cjs'), 'serve', '--db', dbPath, '--no-source'], stderr: 'pipe',
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), REPOLEAD_TEI_URL: 'http://127.0.0.1:1', REPOLEAD_QDRANT_URL: 'http://127.0.0.1:1', REPOLEAD_RERANKER_URL: 'http://127.0.0.1:1' } });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'search', arguments: { query: 'manager', type: 'document', limit: 5 } });
      const text = (response.content as { text: string }[])[0]!.text;
      const parsed = JSON.parse(text) as { results: { type: string; title: string }[]; warnings: string[] };
      assert.ok(parsed.results.length);
      assert.ok(parsed.results.every((hit) => hit.type === 'document'));
      assert.ok(!text.includes('paymentGateway.refundWithReceipt'));
      assert.ok(parsed.warnings.length);
    } finally { await client.close(); }
    const empty = store.createSnapshot({ repositoryId: repository.id, commitSha: 'empty-acceptance' });
    assert.equal(await indexSnapshot({ ...base, snapshotId: empty.id }), 0);
    const remaining = await qdrant.retrieve(collection, [...current.map((item) => symbolIdToPointId(item.id)), sentinelId]);
    assert.deepEqual(remaining.map((point) => point.id), [sentinelId]);
    Object.assign(report, { generatedAt: new Date().toISOString(), scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
      services: { embeddings: embeddingInfo, reranker: rerankerInfo, qdrant: qdrantInfo }, corpus: { symbols: scan.counts.symbols, knowledgeItems: initial!.embedded },
      search: { queries: results, top5Hits: results.filter((result) => result.rank !== null).length, totalQueries: results.length, filterChecks, warnings },
      indexing: { initial, repeated, incremental, unchangedVectors, unmountedSourceRebuild: true, fullTestBody: true, physicalDeletion: true, otherRepositoryPreserved: true, emptySnapshotPurged: true },
      mcp: { compiledStdio: true, noSource: true, documentFilter: true, offlineWarnings: true },
      limits: ['Synthetic English-source fixture with Spanish/English queries; this does not establish accuracy on every repository.', 'Summaries and findings are handwritten retrieval fixtures; no generative-model quality or billed-token evaluation.', 'Modern test records retain exact spans and complete bodies; legacy records without spans require refresh for body search.'] });
    const reportPath = resolve(projectRoot, process.env['REPOLEAD_RETRIEVAL_REPORT'] ?? 'benchmarks/retrieval-acceptance.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(results.filter((result) => result.rank !== null).length, questions.length, 'Every acceptance query must retrieve its expected symbol in the top 5');
    console.log(JSON.stringify({ top5: `${results.filter((result) => result.rank !== null).length}/${questions.length}`, initial, repeated, incremental, report: reportPath }, null, 2));
  } finally { store.close(); }
} finally {
  // The UUID collection belongs exclusively to this script; never delete user collections.
  await fetch(`${urls.qdrant}/collections/${collection}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }).catch(() => undefined);
  rmSync(tempRoot, { recursive: true, force: true });
}
