#!/usr/bin/env node
/**
 * Build the Decibel .mcpb bundle.
 *
 *   node build/build.mjs [--skip-install]
 *
 * Steps:
 *   1. Install the pinned @decibelsystems/tools (prod deps only) into server/
 *   2. Stamp the bundle version + record the pinned server version
 *   3. Assert the project skeleton in bootstrap.mjs still matches the server
 *   4. Validate the manifest, then pack
 *
 * We deliberately copy node_modules rather than esbuild-bundling. The dependency
 * set includes pg and @supabase/supabase-js, which have optional/native resolution
 * paths that bundlers handle badly, and at ~35 MB of prod deps the size saving
 * isn't worth the breakage risk.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const PKG = '@decibelsystems/tools';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

const step = (msg) => console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);

/**
 * Two distinct versions, both from package.json:
 *
 *   version               the BUNDLE's own version — what users see and upgrade past
 *   decibel.serverVersion the pinned @decibelsystems/tools release inside it
 *
 * They are separate because bundle-only fixes exist: v2.1.4 shipped a Windows
 * boot bug in bootstrap.mjs with a perfectly good server inside it, and needed a
 * new user-facing version without the server changing at all.
 */
function versions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const server = pkg.decibel?.serverVersion;
  if (!server) throw new Error('package.json is missing decibel.serverVersion');
  if (!pkg.version) throw new Error('package.json is missing version');
  return { bundle: pkg.version, server };
}

/**
 * bootstrap.mjs hardcodes the .decibel/ folder layout. If the server ever changes
 * DECIBEL_STRUCTURE, our copy would silently produce a skeleton the tools no longer
 * recognise. Fail the build instead.
 */
function assertStructureInSync() {
  const bootstrapSrc = fs.readFileSync(path.join(SERVER_DIR, 'bootstrap.mjs'), 'utf8');
  const registryPath = path.join(
    SERVER_DIR, 'node_modules', PKG, 'dist', 'tools', 'registry', 'index.js'
  );

  if (!fs.existsSync(registryPath)) {
    throw new Error(`cannot verify folder layout — ${registryPath} not found`);
  }

  const extract = (src) => {
    const block = src.match(/DECIBEL_STRUCTURE\s*=\s*\[([\s\S]*?)\]/);
    if (!block) return null;
    return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  };

  const ours = extract(bootstrapSrc);
  const theirs = extract(fs.readFileSync(registryPath, 'utf8'));

  if (!ours || !theirs) throw new Error('could not parse DECIBEL_STRUCTURE from both sides');

  if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
    const missing = theirs.filter((d) => !ours.includes(d));
    const extra = ours.filter((d) => !theirs.includes(d));
    throw new Error(
      'server/bootstrap.mjs DECIBEL_STRUCTURE has drifted from the packaged server.\n' +
        (missing.length ? `  missing from bootstrap: ${missing.join(', ')}\n` : '') +
        (extra.length ? `  stale in bootstrap: ${extra.join(', ')}\n` : '') +
        '  Update the list in server/bootstrap.mjs to match.'
    );
  }

  console.log(`  folder layout in sync (${ours.length} directories)`);
}

/**
 * The whole point of this bundle is that a non-technical user gets a safe, small
 * tool surface. Assert the manifest never ships the pro/apps facades — `terminal`
 * alone reads DX_WALLET_PRIVATE_KEY. See the tier-leak issue in the server repo:
 * with NODE_ENV unset the server enables all 34 facades by default.
 */
function assertFacadeAllowlist(manifest) {
  const env = manifest.server?.mcp_config?.env ?? {};
  const FORBIDDEN = [
    'terminal', 'senken', 'mother', 'deck',
    'voice', 'studio', 'corpus', 'agentic',
  ];

  if (env.NODE_ENV !== 'production') {
    throw new Error('manifest must set NODE_ENV=production (tier gating fails open without it)');
  }
  if (!env.DECIBEL_FACADES) {
    throw new Error('manifest must set DECIBEL_FACADES to an explicit allowlist');
  }

  const allowed = env.DECIBEL_FACADES.split(',').map((s) => s.trim());
  const leaked = allowed.filter((f) => FORBIDDEN.includes(f));
  if (leaked.length) {
    throw new Error(`manifest allowlists non-core facades: ${leaked.join(', ')}`);
  }

  console.log(`  facade allowlist clean (${allowed.length} facades, no pro/apps)`);
}

// ---------------------------------------------------------------------------

const skipInstall = process.argv.includes('--skip-install');
const { bundle: version, server: serverVersion } = versions();

if (!skipInstall) {
  step(`Installing ${PKG}@${serverVersion} (prod deps only)`);
  fs.rmSync(path.join(SERVER_DIR, 'node_modules'), { recursive: true, force: true });
  for (const f of ['package.json', 'package-lock.json']) {
    fs.rmSync(path.join(SERVER_DIR, f), { force: true });
  }
  run('npm', [
    'install', `${PKG}@${serverVersion}`,
    '--omit=dev', '--prefix', SERVER_DIR,
    '--no-audit', '--no-fund',
  ]);
} else {
  step('Skipping install (--skip-install)');
}

step('Stamping manifest version');
const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;

// Keep the bundled server version visible to the user. The bundle and the server
// version move independently, so "which server is in this?" must not need a git log.
manifest.long_description = manifest.long_description
  .replace(/\n\nBundled server:.*$/s, '')
  + `\n\nBundled server: @decibelsystems/tools ${serverVersion}`;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`  manifest.version = ${version}  (server ${serverVersion})`);

step('Checking bundle safety');
assertFacadeAllowlist(manifest);
assertStructureInSync();

step('Validating manifest');
run('npx', ['--yes', '@anthropic-ai/mcpb', 'validate', 'manifest.json']);

step('Packing bundle');
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join('dist', `decibel-${version}.mcpb`);
run('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', '.', out]);

const sizeMb = (fs.statSync(path.join(ROOT, out)).size / 1024 / 1024).toFixed(1);
console.log(`\n\x1b[32m✓ ${out} (${sizeMb} MB)\x1b[0m\n`);
