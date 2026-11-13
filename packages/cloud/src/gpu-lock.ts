import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

/** Same Linux flock protocol as the WLT phased refresh; keep the lock for one inference job. */
export async function tryGpuLock(path: string): Promise<(() => void) | null> {
  closeSync(openSync(path, 'a', 0o600));
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', path, process.execPath, '-e',
      'process.stdout.write("locked");process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let ready = false;
    child.once('error', () => reject(new Error('The local worker requires the flock utility for GPU phase coordination.')));
    child.stdout.once('data', () => { ready = true; resolve(() => child.stdin.end()); });
    child.once('exit', (code) => { if (!ready) { if (code === 1) { resolve(null); } else { reject(new Error('GPU phase lock could not be acquired.')); } } });
  });
}
