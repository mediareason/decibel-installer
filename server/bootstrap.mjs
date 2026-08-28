#!/usr/bin/env node
/**
 * MCPB entry point for the Decibel MCP server.
 *
 * Claude Desktop launches this with the env declared in ../manifest.json. Its job is
 * to make sure the folder the user picked is a usable Decibel project *before* the
 * server boots, then hand off. Without this, a first-time user's folder has no
 * .decibel/ directory and every single tool call returns PROJECT_NOT_FOUND — the
 * worst possible first impression, and the one the onboarding friction logs keep
 * pointing at.
 *
 * Hard rule: nothing here may write to stdout. stdout is the MCP stdio channel and
 * any stray byte corrupts the protocol framing. All diagnostics go to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const log = (msg) => process.stderr.write(`[decibel-bootstrap] ${msg}\n`);

/**
 * Drop env vars the host failed to substitute.
 *
 * The manifest's env values are templates like ${user_config.project_folder}. If a
 * host doesn't substitute one — an optional setting left blank, a variable it
 * doesn't implement, a platform difference — the literal template string is passed
 * through. Downstream that reads as a real value: a project root named
 * "${user_config.project_folder}", or a garbage license key sent to the validator.
 * An unset var is always better than a nonsense one, since every consumer here has
 * a sane default. Empty strings go too, for the same reason.
 */
function dropUnsubstituted() {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DECIBEL_') && key !== 'NODE_ENV') continue;
    if (typeof value !== 'string') continue;
    if (value === '' || value.includes('${')) {
      log(`ignoring ${key} — value was not substituted by the host`);
      delete process.env[key];
    }
  }
}

/**
 * Mirrors DECIBEL_STRUCTURE in the server's src/tools/registry/index.ts.
 * build/build.mjs asserts this list still matches the packaged server, so a
 * server-side change to the layout fails the bundle build instead of silently
 * producing a project skeleton the tools don't recognise.
 */
const DECIBEL_STRUCTURE = [
  'architect/adrs',
  'architect/decisions',
  'architect/policies',
  'architect/roadmap',
  'designer/decisions',
  'designer/crits',
  'sentinel/issues',
  'sentinel/epics',
  'sentinel/tests',
  'dojo/experiments',
  'dojo/proposals',
  'dojo/wishes',
  'oracle/learnings',
  'context/facts',
  'context/events',
  'friction',
  'learnings',
  'provenance/events',
];

/** Create the .decibel/ skeleton if it isn't already there. Idempotent. */
function ensureProjectSkeleton(projectRoot, projectId) {
  const decibelPath = path.join(projectRoot, '.decibel');
  if (fs.existsSync(decibelPath)) return false;

  for (const dir of DECIBEL_STRUCTURE) {
    const full = path.join(decibelPath, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(
      path.join(full, '.gitkeep'),
      '# This file ensures the directory is tracked by git\n'
    );
  }

  const timestamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(decibelPath, 'manifest.yaml'),
    `# Decibel Project Manifest\n# Generated: ${timestamp}\n\n` +
      `id: ${projectId}\nname: ${projectId}\nversion: 1.0.0\n\n` +
      `created_at: ${timestamp}\ndecibel_version: "1.0"\n`
  );

  return true;
}

/**
 * Add the project to ~/.decibel/projects.json so tools can resolve it by id.
 * Shape matches projects.example.json in the server repo. Idempotent on id.
 */
function ensureRegistered(projectRoot, projectId, registryPath) {
  let registry = { version: 1, projects: [] };

  if (fs.existsSync(registryPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (parsed && Array.isArray(parsed.projects)) registry = parsed;
    } catch (err) {
      // A corrupt registry must not take the server down. Back it up and start
      // clean, so the user gets a working install instead of a hard failure.
      const backup = `${registryPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(registryPath, backup);
        log(`registry was unreadable (${err.message}); moved it to ${backup}`);
      } catch {
        log(`registry was unreadable and could not be moved: ${err.message}`);
      }
    }
  }

  const existing = registry.projects.find((p) => p && p.id === projectId);
  if (existing) {
    if (existing.path === projectRoot) return false;
    existing.path = projectRoot;
  } else {
    registry.projects.push({ id: projectId, name: projectId, path: projectRoot, aliases: [] });
  }

  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return true;
}

function main() {
  dropUnsubstituted();

  const projectRoot = process.env.DECIBEL_PROJECT_ROOT;

  // Only bootstrap when we've been given a real folder. If the user hasn't set one
  // yet we still boot the server — it can answer questions and run project_init
  // itself — rather than refusing to start with an error the user can't see.
  if (!projectRoot) {
    log('DECIBEL_PROJECT_ROOT is not set; skipping project bootstrap.');
    return;
  }

  if (!fs.existsSync(projectRoot)) {
    log(`project folder does not exist: ${projectRoot}; skipping bootstrap.`);
    return;
  }

  const projectId = path.basename(path.resolve(projectRoot));
  const registryPath =
    process.env.DECIBEL_REGISTRY_PATH || path.join(os.homedir(), '.decibel', 'projects.json');

  try {
    if (ensureProjectSkeleton(projectRoot, projectId)) {
      log(`initialized new Decibel project "${projectId}" at ${projectRoot}`);
    }
    if (ensureRegistered(projectRoot, projectId, registryPath)) {
      log(`registered "${projectId}" in ${registryPath}`);
    }
  } catch (err) {
    // Bootstrap is best-effort. A failure here should degrade to "tools report
    // PROJECT_NOT_FOUND", not "the extension won't start at all".
    log(`bootstrap failed (continuing anyway): ${err.message}`);
  }
}

main();

// Hand off. The server calls main() at module scope, so importing it boots the
// stdio transport in this same process — no exec, no stdio re-plumbing.
//
// pathToFileURL is load-bearing on Windows and must not be "simplified" away.
// require.resolve returns a native path; on Windows that is C:\...\server.js, and
// dynamic import() parses the leading "C:" as a URL scheme and throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME. POSIX paths happen to work unconverted, which is
// why this only ever fails on Windows — where it fails totally: the server never
// boots, so the extension installs fine and then exposes no tools at all.
const require = createRequire(import.meta.url);
const serverPath = require.resolve('@decibelsystems/tools');

try {
  await import(pathToFileURL(serverPath).href);
} catch (err) {
  // Boot failures are otherwise invisible: Claude Desktop shows the extension as
  // installed and simply lists no tools. Say what happened somewhere findable.
  log(`FATAL: could not start the Decibel server from ${serverPath}`);
  log(`${err?.stack ?? err}`);
  throw err;
}
