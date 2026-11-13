// Builds the extension into dist/:
//  - bundles src/offscreen.js and src/options.js (they import the Anthropic SDK / engine modules),
//  - copies every other file under src/ as-is (engine/ is only bundled),
//  - turns the optional .env into dist/env.json (default settings, read by the extension at runtime).
import { build } from 'esbuild';
import { cp, mkdir, rm, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotEnv, envToSettings } from './scripts/env.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const BUNDLED = ['offscreen.js', 'options.js'];
const SKIP_DIRS = new Set(['engine']);

async function copyTree(from, to, rel = '') {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    const relPath = rel ? `${rel}/${name}` : name;
    const fromPath = path.join(from, name);
    const toPath = path.join(to, name);
    const info = await stat(fromPath);
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(relPath)) continue;
      await copyTree(fromPath, toPath, relPath);
    } else if (!BUNDLED.includes(relPath)) {
      await cp(fromPath, toPath);
    }
  }
}

async function main() {
  for (const f of [...BUNDLED, 'manifest.json']) {
    if (!existsSync(path.join(src, f))) throw new Error(`src/${f} bulunamadi.`);
  }

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  await build({
    entryPoints: BUNDLED.map((f) => path.join(src, f)),
    outdir: dist,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'warning',
  });

  await copyTree(src, dist);

  const envPath = path.join(root, '.env');
  if (existsSync(envPath)) {
    const settings = envToSettings(parseDotEnv(await readFile(envPath, 'utf8')));
    await writeFile(path.join(dist, 'env.json'), JSON.stringify(settings, null, 2));
    const keys = ['elevenKey', 'anthropicKey'].filter((k) => settings[k]);
    console.log(`.env okundu: ${Object.keys(settings).length} ayar (${keys.length}/2 API anahtari).`);
  } else {
    console.log('.env bulunamadi: anahtarlari eklentinin Ayarlar sayfasindan girin (veya .env.example dosyasini .env olarak kopyalayin).');
  }
  console.log('Build tamam: dist/ (Chrome > Uzantilar > Paketlenmemis oge yukle)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Build hatasi:', err.message || err);
    process.exit(1);
  });
}
