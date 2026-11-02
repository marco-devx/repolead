import { once } from 'node:events';
import { createServer } from 'node:http';

import { expect, rstest, test } from '@rstest/core';
import { parseConfig } from '@repolead/config';
import { AgentSdkTechLeadModel, AnthropicTechLeadModel, OllamaTechLeadModel } from '@repolead/lead-analyzer';

import { backendLabel, pickAnalysisRouting, pickModel } from './model-select';

test('local is the default even with Anthropic credentials; explicit settings and model overrides select installed weights', async () => {
  const names = ['qwen3.5:9b-q4_K_M', 'custom-local'];
  let requests = 0;
  const server = createServer((req, res) => {
    expect(req.url).toBe('/api/tags'); requests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: names.map((name) => ({ name, digest: 'a'.repeat(64) })) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rstest.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-real-key');
  rstest.stubEnv('ANTHROPIC_AUTH_TOKEN', 'test-not-a-real-token');
  try {
    const config = parseConfig(`local_model:\n  url: ${url}\n`);
    expect(config.model.backend).toBe('ollama');
    const model = await pickModel(undefined, undefined, config.local_model);
    expect(model).toBeInstanceOf(OllamaTechLeadModel);
    expect(model.name).toContain('qwen3.5:9b-q4_K_M');
    expect(backendLabel(model)).toBe('Ollama local');
    expect((await pickModel('ollama', 'custom-local', config.local_model)).name).toContain('custom-local');
    const before = requests;
    expect((await pickAnalysisRouting(config, model)).leafModel).toBeUndefined();
    expect(requests).toBe(before);
    expect(await pickModel('claude-code', 'explicit-remote')).toBeInstanceOf(AgentSdkTechLeadModel);
    expect(await pickModel('api', 'explicit-remote')).toBeInstanceOf(AnthropicTechLeadModel);
    expect(requests).toBe(before);
    await expect(pickModel('ollama', 'missing', config.local_model)).rejects.toThrow('No se utilizará Claude');
    await expect(pickModel('unknown', undefined, config.local_model)).rejects.toThrow('Backend desconocido');
  } finally {
    rstest.unstubAllEnvs(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an unavailable local backend fails instead of selecting a paid backend', async () => {
  const connect = rstest.spyOn(OllamaTechLeadModel, 'connect').mockRejectedValue(new Error('offline'));
  rstest.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-real-key');
  try {
    await expect(pickModel(undefined, undefined)).rejects.toThrow('No se utilizará Claude como respaldo');
    expect(connect).toHaveBeenCalledTimes(1);
  } finally { connect.mockRestore(); rstest.unstubAllEnvs(); }
});

test('workspace timeout overrides config and rejects invalid values before contacting Ollama', async () => {
  const connect = rstest.spyOn(OllamaTechLeadModel, 'connect').mockRejectedValue(new Error('offline'));
  try {
    const config = parseConfig('local_model:\n  timeoutMs: 180000\n');
    rstest.stubEnv('REPOLEAD_OLLAMA_TIMEOUT_MS', '600000');
    await expect(pickModel('ollama', undefined, config.local_model)).rejects.toThrow('offline');
    expect(connect).toHaveBeenLastCalledWith({ ...config.local_model, timeoutMs: 600000 });
    for (const value of ['', 'NaN', '999', '600001', '1000.5', '1e4']) {
      rstest.stubEnv('REPOLEAD_OLLAMA_TIMEOUT_MS', value);
      await expect(pickModel('ollama', undefined, config.local_model)).rejects.toThrow('REPOLEAD_OLLAMA_TIMEOUT_MS');
    }
    expect(connect).toHaveBeenCalledTimes(1);
  } finally { connect.mockRestore(); rstest.unstubAllEnvs(); }
});
