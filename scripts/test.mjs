// Runs every test file in test/:
//  - *.test.mjs (engine, ESM imports from src/) are bundled with esbuild and executed with node,
//  - *.test.cjs (page scripts, loaded into a vm with fake DOM/WebAudio/chrome) run directly.
import { build } from 'esbuild';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');
const out = path.join(os.tmpdir(), 'meet-translator-tests');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const files = (await readdir(testDir)).filter((f) => /\.test\.(mjs|cjs)$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  let target = path.join(testDir, f);
  if (f.endsWith('.mjs')) {
    target = path.join(out, f);
    await build({
      entryPoints: [path.join(testDir, f)],
      outfile: target,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'error',
    });
  }
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [target], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    failed++;
    console.log(`!!! ${f} FAILED (exit ${r.status})`);
  }
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
