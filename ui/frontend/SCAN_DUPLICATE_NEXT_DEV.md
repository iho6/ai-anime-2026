# Scan: duplicate Next.js dev server (`Another next dev server is already running`)

**Scan date:** 2026-04-27 (evidence captured on the machine where commands ran).

## Summary

Next.js 16 allows **one** `next dev` per project directory. A second start (e.g. `npm run dev` on port **3000**) fails with the singleton message while any first instance remains, **even on a different port**.

## Process evidence

| PID   | Image    | Role |
|-------|----------|------|
| **6588** | `node.exe` (Cursor-bundled: `d:\Work\cursor\...\helpers\node.exe`) | Next **HTTP worker**: `...\next\dist\server\lib\start-server.js` |
| **24060** | `node.exe` (project `node_modules`) | Next **CLI**: `next dev --port 3999` |
| **13208** | `cmd.exe` | `cmd /d /s /c next dev --port 3999` |
| **19932** | `node.exe` (`C:\Program Files\nodejs\node.exe`) | **`npx`** → `npx-cli.js next dev --port 3999` |

**Conclusion:** The blocking instance was started with **`npx next dev --port 3999`** (not `scripts/dev.ps1`, which defaults to port **3000** via `npm run dev -- --port 3000`). Typical source: an **ad-hoc / agent / Cursor terminal** smoke test, not repo scripts.

## Ports

- **3999:** `LISTENING` on PID **6588** (matches Next’s reported PID).
- **3000:** No `LISTENING` line returned at scan time (nothing bound on 3000 for this check).

This matches **singleton-by-directory**, not “port 3000 already in use.”

## `.next/dev` artifacts

- **Lock file:** [`.next/dev/lock`](.next/dev/lock) (JSON), example content at scan time:

  `{"pid":6588,"port":3999,"hostname":"localhost","appUrl":"http://localhost:3999","startedAt":...}`

  Documents the active dev PID, port, and URL for this project root.

- **Log:** [`.next/dev/logs/next-development.log`](.next/dev/logs/next-development.log) — large NDJSON stream; early lines include slow-filesystem warning, `proxyTimeout: 1800000`, compile `/`; no need to treat as second-server proof (process table is authoritative).

- **Tree:** Under `.next/dev/` — `cache/`, `logs/`, `server/`, `static/`, `types/`, manifests, **`lock`**, `trace/`, etc. (standard Next 16 dev output.)

## Operational resolution (no repo change)

1. Stop the existing dev: e.g. `taskkill /PID 6588 /F` (Next may suggest this), or stop the parent **24060** / the terminal running **`npx next dev --port 3999`** cleanly with Ctrl+C.
2. Then start your usual dev on **3000** (from [`services/ui/frontend`](.): `npm run dev`, or from repo root: `.\dev.ps1` / [`scripts/dev.ps1`](../../../scripts/dev.ps1) as you prefer).

## Repo launcher reference

[`scripts/dev.ps1`](../../../scripts/dev.ps1) starts the frontend with **`npm run dev -- --port $FrontendPort`** (default **3000**). Port **3999** is **not** configured there; it came from explicit **`--port 3999`** on the command line.
