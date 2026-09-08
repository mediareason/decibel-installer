# Decibel Tools — Installer

One-click install for [Decibel](https://github.com/decibelsystems/decibel-tools-mcp) — project intelligence for Claude.

---

## Install (Claude Desktop)

**0.** **Install Node.js 18 or newer** if you don't have it — [nodejs.org](https://nodejs.org). Check with `node --version`.

**1.** Download **`decibeltools.mcpb`** from [the latest release](https://github.com/decibelsystems/decibeltools-installer/releases/latest).

**2.** Double-click it. Claude Desktop opens and asks you to confirm.

**3.** Pick the folder you want Decibel to track, then click **Install**.

**4.** Quit Claude Desktop **completely** — **⌘Q** on Mac; on Windows, end every Claude process in Task Manager, because closing the window leaves one running. Then reopen it.

You don't need a terminal, admin rights, or a config file. The bundle brings the server and all its dependencies.

> **Node.js is a real prerequisite, despite what Anthropic's docs say.**
> Claude Desktop does **not** ship a Node runtime — v1.34493.1 contains only
> native `.node` addons, no node executable — and this bundle's manifest
> launches `node`, which is a PATH lookup. If Node is missing, the extension
> installs successfully and then exposes **no tools at all**, with no error
> anywhere in the UI. That silent-success failure is the single most likely
> thing to go wrong, so rule it out first.
>
> Installing Node *after* Claude Desktop is already running does not help on
> Windows: PATH is fixed at process start. End all Claude processes and relaunch.

### Check it worked

Ask Claude: *"What Decibel tools do you have?"* You should see `sentinel`, `architect`, `oracle` and a handful of others. Then try:

> Create an issue: the login button is misaligned on mobile

A file appears in `.decibel/sentinel/issues/` inside the folder you picked.

### Settings

Settings → Extensions → Decibel Tools:

| Setting | What it does |
|---|---|
| **Project folder** | The folder Decibel tracks. It's set up automatically the first time it runs — you don't need to prepare anything. |
| **License key** | Optional. Unlocks Pro features. Leave blank for the free tier. |

Changing the project folder requires a full quit and reopen.

---

## Windows: Microsoft Store build

If you installed Claude Desktop from the **Microsoft Store**, extensions fail with
"Server disconnected" no matter what is in the bundle. This is an upstream Claude
Desktop bug, not something an extension can fix.

The Store build is MSIX-packaged, which virtualizes `%APPDATA%`. Extensions
physically land under:

```
C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\
```

but `${__dirname}` is handed to the spawned server as the *virtual* path
(`%APPDATA%\Claude\...`). Child processes run outside the container, so that path
does not exist for them and the server dies instantly — surfacing as
`MODULE_NOT_FOUND` or "Server disconnected". Tracked upstream as
[anthropics/claude-code#47977](https://github.com/anthropics/claude-code/issues/47977).

**Fix A — pre-create the real directory, then reinstall.** Creating the folder
before installing stops MSIX from virtualizing it:

```powershell
New-Item -ItemType Directory -Path "$env:APPDATA\Claude\Claude Extensions" -Force
```

Then uninstall and reinstall the extension, and fully quit Claude Desktop.

**Fix B — use the direct download instead of the Store build.** The installer at
[claude.com/download](https://claude.com/download) is not MSIX-packaged and does not
have this problem.

To check which build you have, look for a
`AppData\Local\Packages\Claude_pzs8sxrjxfjjc` folder — if it exists, you are on
the Store build.

---

## Why a bundle instead of editing a config file

The documented way to add a local MCP server is to hand-edit `claude_desktop_config.json`. It fails often and fails silently:

- Claude Desktop launches servers with a **stripped PATH**, so a bare `npx` command exits with ENOENT. On Windows you need the full path to `npx.cmd` or a `cmd /c` wrapper; on macOS you need to wrap it in a login shell.
- Windows paths need **doubled backslashes** inside JSON.
- One misplaced comma **silently disables every server** in the file, with no error shown anywhere in the UI.

None of these tell you what went wrong. The `.mcpb` bundle removes the entire class of problem: no config file, no PATH resolution, no runtime to install.

---

## What's in the bundle

The bundle pins a published version of `@decibelsystems/tools` (see `decibel.serverVersion` in `package.json`) and ships it with its production dependencies. Packed size is about **2.6 MB**.

**Two version numbers, deliberately.** `version` in `package.json` is the *bundle's* version — what users see and upgrade past. `decibel.serverVersion` is the pinned server inside it. They move independently because bundle-only fixes happen: v2.1.4 shipped a Windows boot bug in `bootstrap.mjs` around a perfectly good server. The build stamps the bundle version into the manifest and appends the server version to the description, so a shipped bundle always says what's in it.

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

Change `decibel.serverVersion` in `package.json`, bump `version` too, and run `npm run build`. For a bundle-only fix, bump `version` alone.

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
