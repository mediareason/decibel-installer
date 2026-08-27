# Decibel Installer

One-click install for [Decibel](https://github.com/decibelsystems/decibel-tools-mcp) — project intelligence for Claude.

---

## Install (Claude Desktop)

**1.** Download **`decibel.mcpb`** from [the latest release](https://github.com/mediareason/decibel-installer/releases/latest).

**2.** Double-click it. Claude Desktop opens and asks you to confirm.

**3.** Pick the folder you want Decibel to track, then click **Install**.

That's it. Quit Claude Desktop completely (**⌘Q** on Mac, **Alt+F4** on Windows — closing the window isn't enough) and reopen it.

You don't need Node.js, a terminal, admin rights, or a config file. Claude Desktop ships its own Node runtime and the bundle brings everything else.

### Check it worked

Ask Claude: *"What Decibel tools do you have?"* You should see `sentinel`, `architect`, `oracle` and a handful of others. Then try:

> Create an issue: the login button is misaligned on mobile

A file appears in `.decibel/sentinel/issues/` inside the folder you picked.

### Settings

Settings → Extensions → Decibel:

| Setting | What it does |
|---|---|
| **Project folder** | The folder Decibel tracks. It's set up automatically the first time it runs — you don't need to prepare anything. |
| **License key** | Optional. Unlocks Pro features. Leave blank for the free tier. |

Changing the project folder requires a full quit and reopen.

---

## Why a bundle instead of editing a config file

The documented way to add a local MCP server is to hand-edit `claude_desktop_config.json`. It fails often and fails silently:

- Claude Desktop launches servers with a **stripped PATH**, so a bare `npx` command exits with ENOENT. On Windows you need the full path to `npx.cmd` or a `cmd /c` wrapper; on macOS you need to wrap it in a login shell.
- Windows paths need **doubled backslashes** inside JSON.
- One misplaced comma **silently disables every server** in the file, with no error shown anywhere in the UI.

None of these tell you what went wrong. The `.mcpb` bundle removes the entire class of problem: no config file, no PATH resolution, no runtime to install.

---

## What's in the bundle

The bundle pins a published version of `@decibelsystems/tools` (currently **2.1.4** — see `decibel.serverVersion` in `package.json`) and ships it with its production dependencies. Packed size is about **2.6 MB**.

It deliberately exposes a **reduced tool surface** — 11 facades covering work tracking, decisions, design, and roadmap — rather than all 34 the server implements. Two reasons:

1. **Safety.** The server's tier gating reads `NODE_ENV`, and enables *everything* when it's unset — including facades that talk to Postgres trading databases and read a crypto wallet private key. The manifest pins `NODE_ENV=production` and passes an explicit `DECIBEL_FACADES` allowlist. `build/build.mjs` refuses to pack a bundle whose allowlist contains any of them, and `test/bundle.test.mjs` asserts it against a real running server.
2. **Onboarding.** Meeting 34 facades on day one is its own kind of failure.

---

## Development

```bash
npm run build        # install pinned server, validate, pack → dist/
npm run build:fast   # same, reusing the existing server/node_modules
npm test             # boot the bundle for real and assert its behaviour
npm run icon         # re-render icon.png from assets/icon.svg (needs cairosvg)
```

`npm test` runs `server/bootstrap.mjs` exactly as Claude Desktop would — same command, same env — against a throwaway folder, speaks real MCP over stdio, and checks that the project skeleton is created, the project is registered, the tool list is correct, and a second run doesn't clobber existing data.

### Bumping the server version

Change `decibel.serverVersion` in `package.json` and run `npm run build`. The build stamps `manifest.json`'s version from that one value, so the two can't drift.

The build also asserts that the `.decibel/` folder layout hardcoded in `server/bootstrap.mjs` still matches `DECIBEL_STRUCTURE` in the packaged server — if the server changes its layout, the build fails loudly instead of quietly producing a project skeleton the tools don't recognise.

### Layout

```
manifest.json              MCPB manifest — server config, user settings, allowlist
icon.png                   512×512, rendered from assets/icon.svg
server/bootstrap.mjs       entry point: prepares the project, then boots the server
build/build.mjs            install → stamp → safety checks → validate → pack
test/bundle.test.mjs       end-to-end behaviour tests
```

---

## Roadmap

**Phase 2 — native installer app.** Covers what an `.mcpb` structurally cannot: Claude Code, Cursor, and the background daemon. Gated on obtaining Apple Developer ID and Windows code-signing certificates — shipping unsigned binaries would put Gatekeeper and SmartScreen warnings in front of exactly the non-technical users this exists to help.
