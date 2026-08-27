/**
 * End-to-end checks on the packed bundle's entry point.
 *
 * These run bootstrap.mjs exactly as Claude Desktop would — same env, same command —
 * against a throwaway project folder, and speak real MCP over stdio.
 *
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Facades that must never reach a Claude Desktop user via this bundle. */
const FORBIDDEN = ['terminal', 'senken', 'mother', 'deck', 'voice', 'studio', 'corpus', 'agentic'];

/**
 * Resolve the manifest's env the way the MCPB host does, substituting
 * ${__dirname}, ${HOME} and ${user_config.*}.
 */
function resolveEnv({ projectFolder, home }) {
  const subs = {
    '${__dirname}': ROOT,
    '${HOME}': home,
    '${user_config.project_folder}': projectFolder,
    '${user_config.license_key}': '',
  };
  const out = {};
  for (const [k, v] of Object.entries(MANIFEST.server.mcp_config.env)) {
    out[k] = Object.entries(subs).reduce((s, [from, to]) => s.split(from).join(to), v);
  }
  return out;
}

/** Boot the server over stdio, run initialize + tools/list, return the tool names. */
function listTools(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(ROOT, 'server', 'bootstrap.mjs')], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out.\nstderr:\n${stderr}`));
    }, 30_000);

    child.stdout.on('data', (d) => {
      stdout += d;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ tools: (msg.result?.tools ?? []).map((t) => t.name), stderr });
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bundle-test', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

test('bootstraps an empty folder and exposes only the allowlisted facades', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decibel-bundle-'));
  const projectFolder = path.join(tmp, 'my-new-project');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const env = resolveEnv({ projectFolder, home });
  const { tools, stderr } = await listTools(env);

  await t.test('creates the .decibel skeleton', () => {
    assert.ok(fs.existsSync(path.join(projectFolder, '.decibel')), '.decibel/ was not created');
    for (const dir of ['sentinel/issues', 'architect/adrs', 'friction', 'provenance/events']) {
      assert.ok(
        fs.existsSync(path.join(projectFolder, '.decibel', dir)),
        `missing .decibel/${dir}`
      );
    }
    const manifestYaml = fs.readFileSync(
      path.join(projectFolder, '.decibel', 'manifest.yaml'), 'utf8'
    );
    assert.match(manifestYaml, /id: my-new-project/);
  });

  await t.test('registers the project', () => {
    const registryPath = path.join(home, '.decibel', 'projects.json');
    assert.ok(fs.existsSync(registryPath), 'projects.json was not written');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const entry = registry.projects.find((p) => p.id === 'my-new-project');
    assert.ok(entry, 'project not present in registry');
    assert.equal(entry.path, projectFolder);
  });

  await t.test('boots and serves tools', () => {
    assert.ok(tools.length > 0, `no tools returned.\nstderr:\n${stderr}`);
  });

  // The regression guard. With NODE_ENV unset the server enables all 34 facades,
  // including `terminal` (reads DX_WALLET_PRIVATE_KEY) and the Postgres trading
  // facades. This asserts the manifest's env actually closes that off.
  await t.test('leaks no pro or apps facades', () => {
    const leaked = tools.filter((n) => FORBIDDEN.some((f) => n === f || n.startsWith(`${f}_`)));
    assert.deepEqual(leaked, [], `bundle exposed forbidden facades: ${leaked.join(', ')}`);
  });

  await t.test('exposes the allowlisted facades', () => {
    for (const expected of ['sentinel', 'architect', 'oracle']) {
      assert.ok(
        tools.some((n) => n === expected || n.startsWith(`${expected}_`)),
        `expected facade "${expected}" missing from: ${tools.join(', ')}`
      );
    }
  });

  await t.test('writes nothing but JSON-RPC to stdout', () => {
    assert.doesNotMatch(stderr, /^\s*$/, 'expected bootstrap diagnostics on stderr');
  });
});

test('is idempotent on an already-initialized folder', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decibel-bundle-'));
  const projectFolder = path.join(tmp, 'existing');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(projectFolder);
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const env = resolveEnv({ projectFolder, home });
  await listTools(env);

  // Drop a file in, run again, confirm the second boot doesn't clobber it.
  const canary = path.join(projectFolder, '.decibel', 'sentinel', 'issues', 'ISS-0001.md');
  fs.writeFileSync(canary, 'do not delete me\n');

  const { tools } = await listTools(env);
  assert.ok(tools.length > 0, 'second boot returned no tools');
  assert.equal(fs.readFileSync(canary, 'utf8'), 'do not delete me\n', 'second boot clobbered data');

  const registry = JSON.parse(fs.readFileSync(path.join(home, '.decibel', 'projects.json'), 'utf8'));
  const matches = registry.projects.filter((p) => p.id === 'existing');
  assert.equal(matches.length, 1, 'project was registered twice');
});
