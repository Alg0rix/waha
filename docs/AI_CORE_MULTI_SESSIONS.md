# Custom AI Patch Notes

This file documents the locally maintained deviations from upstream WAHA Core so
future upgrades can be reconciled quickly. Whenever you rebase on a new upstream
release, re-apply or port the changes listed here.

## 1. Multi-session Core enablement

**Files**: `src/api/sessions.controller.ts`, `src/core/manager.core.ts`.

- **Controller (`create` endpoint)**: Accepts arbitrary session names for Core
  builds and generates a prefixed ULID when `name` is omitted. Upstream Core
  normally hardcodes `"default"`; we removed that guard to allow multiple
  sessions.
- **SessionManagerCore**: Replaced the single `default` session state with Maps
  keyed by session name, reworked lifecycle helpers (`exists`, `start`, `stop`,
  `getSessionInfo`, etc.), and rewired event fan-out to be per-session. All API
  routes now operate across multiple sessions.

> **Upgrade note:** When pulling future upstream changes, inspect the controller
> and manager diffs. Any upstream edits that assume a single session (e.g.
> `this.DEFAULT`, `onlyDefault`, references to `this.session`) must be adapted
> back to the map-based logic described above.

## 2. Persistent session configs for Core

**Files**: `src/core/manager.core.ts`, `src/core/storage/LocalSessionConfigRepository.ts`.

- Added `LocalSessionConfigRepository` usage in Core to keep each session's
  config in `.sessions/<engine>/<name>/.waha.session.config.json`.
- On boot (`init()`), the manager loads every stored config so `GET
  /api/sessions?all=true` and `start` work after a container restart.
- `upsert`/`delete` ensure config files are saved or removed in sync with API
  operations.

> **Upgrade note:** When upstream modifies session persistence or storage paths,
> verify that config repositories are still wired in the constructor and during
> `init()`. Re-apply the load/save hooks if upstream rewrites those sections.

### Auto-restart on bootstrap

- `SessionManagerCore.startPredefinedSessions` is overridden so that when
  `WAHA_WORKER_RESTART_SESSIONS` (default `true`) or
  `WHATSAPP_RESTART_ALL_SESSIONS` are enabled, every persisted session config is
  queued for restart. `WAHA_AUTO_START_DELAY_SECONDS` (if non-zero) inserts a
  delay between session restarts.
- This is what brings multi-session deployments back online automatically after
  a container restart.

> **Upgrade note:** If upstream reintroduces the original single-session version
> of `startPredefinedSessions`, reapply this override to keep auto-restart
> behavior intact.

## 3. Out-of-band documentation

- External-facing README changes were intentionally avoided per user
  preference. Refer to this file whenever you need to brief AI helpers on what
  must be reapplied after syncing with upstream.

## 4. Docker Compose layout

- `docker-compose.yaml` mirrors upstream.
- `docker-compose.dev.yaml` builds the image from the local workspace
  (`build: .` + `image: waha-local-dev`) and exposes `3000:3000` on all
  interfaces for easier testing.

> **Upgrade note:** When upstream updates `docker-compose.yaml`, copy any
> relevant changes into the dev variant while preserving the local build + port
> overrides.
