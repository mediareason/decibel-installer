/**
 * Tests the PACKED ARTIFACT, not the source tree.
 *
 * This file exists because bundle.test.mjs cannot catch packaging faults. It runs
 * server/bootstrap.mjs out of the repo, where node_modules is complete and correct
 * — so it passes whether or not those files made it into the .mcpb.
 *
 * Three releases (2.1.4–2.1.6) shipped a bundle with every dist/ directory stripped
 * out, including the entire server, because .mcpbignore's "dist/" matched at any
 * depth. Every test passed the whole time. The install succeeded and exposed no
 * tools, and diagnosing it cost two trips to a physical Windows machine.
 *
 * So: unzip the real bundle into a temp dir and boot it from there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUNDLE = path.join(ROOT, 'dist', `decibeltools-${PKG.version}.mcpb`);

const FORBIDDEN = ['terminal', 'senken', 'mother', 'deck', 'voice', 'studio', 'corpus', 'agentic'];

function unpack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decibel-packed-'));
  execFileSync('unzip', ['-qq', BUNDLE, '-d', dir]);
  return dir;
}

/** Boot the unpacked bundle the way the host would, and list its tools. */
function listTools(extRoot, env) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extRoot, 'manifest.json'), 'utf8'));
  const args = manifest.server.mcp_config.args.map((a) => a.replace('${__dirname}', extRoot));

  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { env: { PATH: process.env.PATH, ...env }, stdio: 'pipe' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out.\nstderr:\n${stderr}`));
    }, 30_000);

    child.stdout.on('data', (d) => {
      stdout += d;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer); child.kill();
          resolve({ tools: (msg.result?.tools ?? []).map((t) => t.name), stderr });
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code} before listing tools.\nstderr:\n${stderr}`));
      }
    });

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'packed-test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

test('the packed .mcpb is complete and boots', async (t) => {
  assert.ok(fs.existsSync(BUNDLE), `bundle not built: ${BUNDLE} — run npm run build first`);

  const extRoot = unpack();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decibel-proj-'));
  const projectFolder = path.join(tmp, 'proj');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(projectFolder); fs.mkdirSync(home);
  t.after(() => {
    fs.rmSync(extRoot, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(extRoot, 'manifest.json'), 'utf8'));

  await t.test('contains the manifest entry point', () => {
    assert.ok(
      fs.existsSync(path.join(extRoot, manifest.server.entry_point)),
      `entry_point "${manifest.server.entry_point}" is not in the bundle`
    );
  });

  await t.test('contains the server package main file', () => {
    // The exact failure of 2.1.4–2.1.6: package.json present, dist/ stripped.
    const pkgJson = path.join(extRoot, 'server/node_modules/@decibelsystems/tools/package.json');
    assert.ok(fs.existsSync(pkgJson), '@decibelsystems/tools missing from bundle');
    const main = path.join(path.dirname(pkgJson), JSON.parse(fs.readFileSync(pkgJson, 'utf8')).main);
    assert.ok(fs.existsSync(main), `server main "${main}" missing — bundle is a hollow shell`);
  });

  await t.test('kept dependency dist/ directories', () => {
    const distFiles = execFileSync('sh', ['-c',
      `find ${JSON.stringify(extRoot)}/server/node_modules -type d -name dist | wc -l`,
    ]).toString().trim();
    assert.ok(Number(distFiles) > 0, 'every dependency dist/ directory was stripped');
  });

  const { tools, stderr } = await listTools(extRoot, {
    ...Object.fromEntries(
      Object.entries(manifest.server.mcp_config.env).map(([k, v]) => [
        k, v.replace('${user_config.project_folder}', projectFolder)
            .replace('${user_config.license_key}', ''),
      ])
    ),
    HOME: home,
    USERPROFILE: home,
  });

  await t.test('serves tools from the packed bundle', () => {
    assert.ok(tools.length > 0, `packed bundle exposed no tools.\nstderr:\n${stderr}`);
  });

  await t.test('leaks no pro or apps facades', () => {
    const leaked = tools.filter((n) => FORBIDDEN.some((f) => n === f || n.startsWith(`${f}_`)));
    assert.deepEqual(leaked, [], `packed bundle exposed: ${leaked.join(', ')}`);
  });

  await t.test('initializes the project from the packed bundle', () => {
    assert.ok(
      fs.existsSync(path.join(projectFolder, '.decibel', 'sentinel', 'issues')),
      'bootstrap did not create the project skeleton'
    );
  });
});
