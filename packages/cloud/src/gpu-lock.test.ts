import { expect, test } from '@rstest/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryGpuLock } from './gpu-lock';

test('local inference lock excludes a phased refresh until the owning job releases it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'repolead-cloud-gpu-lock-'));
  let release: (() => void) | null = null;
  try {
    const path = join(directory, 'gpu.lock');
    release = await tryGpuLock(path); expect(release).not.toBe(null);
    expect(await tryGpuLock(path)).toBe(null);
    release!(); release = null;
    for (let i = 0; i < 100 && !release; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5)); release = await tryGpuLock(path);
    }
    expect(release).not.toBe(null);
  } finally { release?.(); rmSync(directory, { recursive: true, force: true }); }
});
