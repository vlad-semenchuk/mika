# Media Cleanup Design

**Date:** 2026-03-23
**Status:** Approved

## Problem

Media files downloaded to `groups/{name}/media/` accumulate indefinitely. Once a file has been processed (transcribed, analyzed, etc.) it is no longer needed — it can always be re-fetched from Telegram via `file_id` (permanent per bot) or re-downloaded from the source URL.

## Design

### Cleanup on container exit

In `src/container-runner.ts`, extract a `cleanupMediaDir(mediaDir)` helper that:
1. Deletes the directory with `fs.rmSync(mediaDir, { recursive: true, force: true })`
2. Recreates it with `fs.mkdirSync(mediaDir, { recursive: true })`

Call this helper from both `container.on('close')` and `container.on('error')`.

**Double-invocation is safe and intentional.** When a spawn fails, Node.js fires `error` then `close` in sequence — both handlers will call `cleanupMediaDir`. The second call is a no-op in effect: `force: true` suppresses the "not found" error on `rmSync`, and `{ recursive: true }` on `mkdirSync` is idempotent. The final state is always an empty directory.

### Mount stays flat

The mount remains `groups/{name}/media/` → `/workspace/group/media/` unchanged. This preserves compatibility with `src/channels/telegram.ts`, which downloads Telegram media (photos, voice, video, documents) to the flat directory before the container starts. No changes to `telegram.ts` or any other file.

### Why delete everything, not just "new" files

All files in the media directory at container exit have been consumed by the agent — either pre-downloaded by the host (Telegram media) or downloaded during the run (yt-dlp). None need to persist after the container exits.

### Parallel agents (future)

The current group queue serializes containers per group — at most one container runs per group at a time — so wiping the flat directory on exit is safe. When parallel per-group agents are introduced, this strategy will need revisiting: the likely approach is per-run subdirectories, which requires coordinating the write path in `telegram.ts` with the `containerName` generated in `container-runner.ts` at spawn time. That work is deferred.

## Changes

- `src/container-runner.ts` — two additions:
  1. A `cleanupMediaDir(mediaDir)` helper: delete the directory (`rmSync` with `recursive + force`), then recreate it (`mkdirSync` with `recursive`)
  2. Call `cleanupMediaDir` from both `container.on('close')` and `container.on('error')`

No other files change.

## Non-goals

- Cleanup of legacy files already accumulated in existing `groups/{name}/media/` directories (manual cleanup if needed)
- Per-run subdirectory isolation (deferred to parallel agents work)
