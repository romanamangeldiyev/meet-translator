// Runs the live end-to-end test against the REAL ElevenLabs + Anthropic APIs using the keys in .env.
// Usage: npm run test:live            (all steps)
//        npm run test:live -- models  (only the Claude model latency comparison)
// Costs a few cents. Keys are read locally and never printed.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(os.tmpdir(), 'meet-translator-live');
await mkdir(out, { recursive: true });
const outfile = path.join(out, 'live.mjs');
await build({
  entryPoints: [path.join(root, 'scripts', 'live-test.entry.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error',
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
