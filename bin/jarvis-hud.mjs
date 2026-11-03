#!/usr/bin/env node
// Runs the compiled CLI (npm run build) or falls back to tsx in a source checkout.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'dist-server', 'server', 'cli.js');
if (existsSync(compiled)) {
  await import(pathToFileURL(compiled).href);
} else {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'server', 'cli.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}
