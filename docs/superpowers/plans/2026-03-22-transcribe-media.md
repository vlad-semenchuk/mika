# Transcribe-Media Skill + Media Download Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save all Telegram media to disk and provide an on-demand transcription skill for the agent.

**Architecture:** Telegram media handlers download files to `groups/{name}/media/` and store workspace paths in messages. A `transcribe-media` bash script in the container calls the Whisper API (Groq or OpenAI) on demand. Environment variables are forwarded to containers via a config whitelist, read from `.env` using the existing `readEnvFile` utility.

**Tech Stack:** Node.js, TypeScript, Vitest, Grammy (Telegram), OpenAI SDK (Whisper), Docker

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/config.ts` | Exports `CONTAINER_ENV_FORWARD` whitelist |
| `src/container-runner.ts` | Reads whitelist, reads `.env` via `readEnvFile`, passes env vars as `-e` flags |
| `src/channels/telegram.ts` | `downloadTelegramMedia` helper + `handleMediaDownload` higher-level handler for all media types |
| `src/channels/telegram.test.ts` | Tests for media download (success, failure, all media types) |
| `src/container-runner.test.ts` | Test for env forwarding |
| `container/transcribe-media/transcribe-media.mjs` | Standalone Node.js transcription script |
| `container/transcribe-media/package.json` | Declares `openai` dependency for the script |
| `container/Dockerfile` | Installs transcribe-media script and its dependency |
| `container/skills/transcribe-media/SKILL.md` | Agent skill documentation |
| `src/transcription.ts` | Deleted (transcription moves to container) |

---

### Task 1: Add `CONTAINER_ENV_FORWARD` to config

**Files:**
- Modify: `src/config.ts:80-88` (append after `TELEGRAM_ONLY`)

- [ ] **Step 1: Add the whitelist constant**

In `src/config.ts`, add after the `TELEGRAM_ONLY` export (line 88):

```ts
// Environment variables to forward to agent containers.
// These are third-party API keys read from .env and passed directly
// (not via credential proxy, which is Anthropic-only).
export const CONTAINER_ENV_FORWARD: string[] = [
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
];
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add CONTAINER_ENV_FORWARD whitelist to config"
```

---

### Task 2: Forward whitelisted env vars to containers

**Important:** The codebase keeps secrets out of `process.env` by design. API keys live in `.env` and are read via `readEnvFile()` from `src/env.ts`. The forwarding must use `readEnvFile`, not `process.env`.

**Files:**
- Modify: `src/container-runner.ts:215-264` (`buildContainerArgs` function)
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/container-runner.test.ts`, add `CONTAINER_ENV_FORWARD` to the config mock (line 19):

```ts
CONTAINER_ENV_FORWARD: ['GROQ_API_KEY', 'OPENAI_API_KEY'],
```

Mock `readEnvFile` from `env.js`. Add near the other mocks:

```ts
const mockReadEnvFile = vi.fn(() => ({}));
vi.mock('./env.js', () => ({
  readEnvFile: (...args: any[]) => mockReadEnvFile(...args),
}));
```

Then add a new `describe` block at the end of the file:

```ts
describe('container env forwarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards whitelisted env vars when set in .env', async () => {
    mockReadEnvFile.mockReturnValueOnce({
      GROQ_API_KEY: 'test-groq-key',
      OPENAI_API_KEY: 'test-openai-key',
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    const spawnArgs = (spawn as any).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('GROQ_API_KEY=test-groq-key');
    expect(spawnArgs).toContain('OPENAI_API_KEY=test-openai-key');
  });

  it('skips whitelisted env vars when not set in .env', async () => {
    mockReadEnvFile.mockReturnValueOnce({});

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    const spawnArgs = (spawn as any).mock.calls[0][1] as string[];
    expect(spawnArgs.join(' ')).not.toContain('GROQ_API_KEY');
    expect(spawnArgs.join(' ')).not.toContain('OPENAI_API_KEY');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/container-runner.test.ts`
Expected: FAIL — the env vars are not being forwarded yet

- [ ] **Step 3: Implement env forwarding**

In `src/container-runner.ts`, add the imports:

```ts
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CONTAINER_ENV_FORWARD,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
```

In `buildContainerArgs`, add after the host gateway args line (`args.push(...hostGatewayArgs());` around line 242):

```ts
  // Forward whitelisted environment variables to the container.
  // Keys are read from .env (not process.env) to match the codebase's
  // secret isolation pattern — secrets never enter process.env.
  const forwardEnv = readEnvFile(CONTAINER_ENV_FORWARD);
  for (const name of CONTAINER_ENV_FORWARD) {
    if (forwardEnv[name]) {
      args.push('-e', `${name}=${forwardEnv[name]}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: forward whitelisted env vars from .env to agent containers"
```

---

### Task 3: Extract shared media download helper and higher-level handler

This task extracts two helpers:
1. `downloadTelegramMedia` — low-level: downloads a file from Telegram, saves to disk
2. `handleMediaDownload` — high-level: extracts common boilerplate (chatJid, group, timestamp, senderName, fwd, etc.), calls download, stores message via `onMessage`

All 6 media handlers (photo, voice, video, video_note, audio, document) will use `handleMediaDownload`, eliminating the duplication.

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/telegram.test.ts`

- [ ] **Step 1: Update test infrastructure**

In `src/channels/telegram.test.ts`:

Add `GROUPS_DIR` to the config mock:

```ts
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));
```

Mock `transcription.js` to prevent real API calls during transition:

```ts
vi.mock('../transcription.js', () => ({
  transcribeBuffer: vi.fn().mockResolvedValue(null),
}));
```

Add `fs` mock:

```ts
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});
```

Add `fetch` mock:

```ts
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
});
vi.stubGlobal('fetch', fetchMock);
```

Update the Grammy mock's `api` object to include `getFile` and `sendSticker`:

```ts
    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      sendSticker: vi.fn().mockResolvedValue(undefined),
    };
```

- [ ] **Step 2: Write tests for all media types**

Replace the entire `non-text messages` describe block with a new `media download` describe block:

```ts
  describe('media download', () => {
    it('downloads photo and stores path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'photo-123', width: 800, height: 600 }] },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo: /workspace/group/media/1.jpg]',
        }),
      );
    });

    it('falls back to placeholder when photo download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'photo-123', width: 800, height: 600 }] },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('includes caption with downloaded media', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        caption: 'Look at this',
        extra: { photo: [{ file_id: 'photo-123', width: 800, height: 600 }] },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo: /workspace/group/media/1.jpg] Look at this',
        }),
      );
    });

    it('includes forwarded prefix with downloaded media', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          photo: [{ file_id: 'photo-123', width: 800, height: 600 }],
          forward_origin: { type: 'user', sender_user: { first_name: 'Bob' } },
        },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Forwarded from Bob] [Photo: /workspace/group/media/1.jpg]',
        }),
      );
    });

    it('downloads voice message and stores path (normalizes .oga to .ogg)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({ file_path: 'voice/file_0.oga' });

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice-123' } },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice: /workspace/group/media/1.ogg]',
        }),
      );
    });

    it('falls back to placeholder when voice download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice-123' } },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('downloads video and stores path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({ file_path: 'videos/file_0.mp4' });

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'video-123' } },
      });
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Video: /workspace/group/media/1.mp4]',
        }),
      );
    });

    it('falls back to placeholder when video download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'video-123' } },
      });
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('downloads video note and stores path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({ file_path: 'video_notes/file_0.mp4' });

      const ctx = createMediaCtx({
        extra: { video_note: { file_id: 'vnote-123' } },
      });
      await triggerMediaMessage('message:video_note', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Video note: /workspace/group/media/1.mp4]',
        }),
      );
    });

    it('falls back to placeholder when video note download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        extra: { video_note: { file_id: 'vnote-123' } },
      });
      await triggerMediaMessage('message:video_note', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video note]' }),
      );
    });

    it('downloads audio and stores path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({ file_path: 'audio/file_0.mp3' });

      const ctx = createMediaCtx({
        extra: { audio: { file_id: 'audio-123' } },
      });
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Audio: /workspace/group/media/1.mp3]',
        }),
      );
    });

    it('falls back to placeholder when audio download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        extra: { audio: { file_id: 'audio-123' } },
      });
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('downloads document and stores path with original filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({ file_path: 'documents/file_0.pdf' });

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc-123', file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: /workspace/group/media/1_report.pdf]',
        }),
      );
    });

    it('sanitizes document filename with special characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({ file_path: 'documents/file_0.pdf' });

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc-123', file_name: 'my/bad:file*.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: /workspace/group/media/1_my_bad_file_.pdf]',
        }),
      );
    });

    it('falls back to placeholder when document download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc-123', file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document]' }),
      );
    });

    it('stores sticker with emoji (unchanged)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder (unchanged)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder (unchanged)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores media from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });
```

Also update the handler registration test to include `message:video_note`:

```ts
    expect(currentBot().filterHandlers.has('message:video_note')).toBe(true);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/channels/telegram.test.ts`
Expected: FAIL — handlers not refactored yet

- [ ] **Step 4: Implement the helpers and refactor all handlers**

In `src/channels/telegram.ts`:

Remove the `transcribeBuffer` import (line 8).

Add after `getForwardedFrom` (around line 50):

```ts
/**
 * Download a file from Telegram and save to the group's media directory.
 * Returns the workspace path on success, null on failure.
 * Normalizes .oga → .ogg (Whisper API doesn't accept .oga).
 */
async function downloadTelegramMedia(
  botToken: string,
  api: any,
  fileId: string,
  groupFolder: string,
  msgId: string,
  defaultExt: string,
  filenameOverride?: string,
): Promise<string | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) return null;

    const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    let ext = path.extname(file.file_path) || defaultExt;
    if (ext === '.oga') ext = '.ogg';

    const filename = filenameOverride
      ? `${msgId}_${filenameOverride.replace(/[/\\:*?"<>|]/g, '_')}`
      : `${msgId}${ext}`;
    const localPath = path.join(mediaDir, filename);

    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));

    return `/workspace/group/media/${filename}`;
  } catch {
    return null;
  }
}

/** Media type config for handleMediaDownload */
interface MediaTypeConfig {
  label: string;
  fallback: string;
  getFileId: (msg: any) => string | undefined;
  defaultExt: string;
  getFilenameOverride?: (msg: any) => string | undefined;
  supportsCaption?: boolean;
}

const MEDIA_TYPES: Record<string, MediaTypeConfig> = {
  'message:photo': {
    label: 'Photo',
    fallback: '[Photo]',
    getFileId: (msg) => msg.photo?.[msg.photo.length - 1]?.file_id,
    defaultExt: '.jpg',
    supportsCaption: true,
  },
  'message:voice': {
    label: 'Voice',
    fallback: '[Voice message]',
    getFileId: (msg) => msg.voice?.file_id,
    defaultExt: '.ogg',
  },
  'message:video': {
    label: 'Video',
    fallback: '[Video]',
    getFileId: (msg) => msg.video?.file_id,
    defaultExt: '.mp4',
    supportsCaption: true,
  },
  'message:video_note': {
    label: 'Video note',
    fallback: '[Video note]',
    getFileId: (msg) => msg.video_note?.file_id,
    defaultExt: '.mp4',
  },
  'message:audio': {
    label: 'Audio',
    fallback: '[Audio]',
    getFileId: (msg) => msg.audio?.file_id,
    defaultExt: '.mp3',
    supportsCaption: true,
  },
  'message:document': {
    label: 'Document',
    fallback: '[Document]',
    getFileId: (msg) => msg.document?.file_id,
    defaultExt: '.bin',
    getFilenameOverride: (msg) => msg.document?.file_name || undefined,
    supportsCaption: true,
  },
};
```

Then replace all media handlers (photo handler at lines 195-258, voice handler at lines 260-316, and the one-liners at lines 318-323) with a single registration loop:

```ts
    // Register download-based media handlers
    for (const [filter, config] of Object.entries(MEDIA_TYPES)) {
      this.bot.on(filter, async (ctx: any) => {
        const chatJid = `tg:${ctx.chat.id}`;
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const caption = config.supportsCaption && ctx.message.caption
          ? ` ${ctx.message.caption}`
          : '';
        const msgId = ctx.message.message_id.toString();
        const fwd = getForwardedFrom(ctx.message);
        const fwdPrefix = fwd ? `[Forwarded from ${fwd}] ` : '';

        const fileId = config.getFileId(ctx.message);
        let content: string;

        if (fileId) {
          const filenameOverride = config.getFilenameOverride?.(ctx.message);
          const workspacePath = await downloadTelegramMedia(
            this.botToken, ctx.api, fileId,
            group.folder, msgId, config.defaultExt, filenameOverride,
          );
          content = workspacePath
            ? `${fwdPrefix}[${config.label}: ${workspacePath}]${caption}`
            : `${fwdPrefix}${config.fallback}${caption}`;
        } else {
          content = `${fwdPrefix}${config.fallback}${caption}`;
        }

        this.opts.onChatMetadata(chatJid, timestamp);
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, mediaType: config.label, downloaded: content.includes('/workspace/') },
          'Telegram media stored',
        );
      });
    }
```

Keep sticker, location, contact handlers on `storeNonText` — they stay as-is.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/channels/telegram.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat: download all media types to disk, add video_note handler"
```

---

### Task 4: Create `transcribe-media` container script

**Files:**
- Create: `container/transcribe-media/transcribe-media.mjs`
- Create: `container/transcribe-media/package.json`

- [ ] **Step 1: Create package.json**

Create `container/transcribe-media/package.json`:

```json
{
  "name": "transcribe-media",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "openai": "^4"
  }
}
```

- [ ] **Step 2: Create the transcription script**

Create `container/transcribe-media/transcribe-media.mjs`:

```js
#!/usr/bin/env node

/**
 * Transcribe an audio/video file using Whisper (Groq preferred, OpenAI fallback).
 * Usage: transcribe-media <file-path>
 * Reads GROQ_API_KEY or OPENAI_API_KEY from environment.
 * Prints transcript to stdout.
 */

import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import OpenAI, { toFile } from 'openai';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const OPENAI_MODEL = 'whisper-1';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: transcribe-media <file-path>');
  process.exit(1);
}

const groqKey = process.env.GROQ_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const apiKey = groqKey || openaiKey;

if (!apiKey) {
  console.error('Error: Neither GROQ_API_KEY nor OPENAI_API_KEY is set');
  process.exit(1);
}

const baseURL = groqKey ? GROQ_BASE_URL : undefined;
const model = groqKey ? GROQ_MODEL : OPENAI_MODEL;

try {
  const buffer = readFileSync(filePath);
  const filename = basename(filePath);
  const ext = extname(filePath) || '.ogg';

  const mimeTypes = {
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
  };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  const openai = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const file = await toFile(buffer, filename, { type: mimeType });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model,
    response_format: 'text',
  });

  process.stdout.write(String(transcription));
} catch (err) {
  console.error('Transcription failed:', err.message || err);
  process.exit(1);
}
```

- [ ] **Step 3: Verify script syntax**

Run: `node --check container/transcribe-media/transcribe-media.mjs`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add container/transcribe-media/
git commit -m "feat: add transcribe-media container script"
```

---

### Task 5: Create `transcribe-media` agent skill

**Files:**
- Create: `container/skills/transcribe-media/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `container/skills/transcribe-media/SKILL.md`:

```markdown
---
name: transcribe-media
description: Transcribe audio and video files to text using Whisper. Use when the user asks to transcribe a voice message, video note, or any media file.
allowed-tools: Bash(transcribe-media:*)
---

# Transcribe Media

Transcribe audio and video files to text using Whisper (Groq or OpenAI).

## Usage

```bash
transcribe-media /workspace/group/media/123.ogg
```

The transcript is printed to stdout.

## Supported Formats

ogg, mp3, mp4, webm, wav, m4a, flac

## When to Use

- A user sends a voice message and asks what it says
- A user sends a video note and wants a transcript
- Any media file that contains spoken audio needing transcription

## Error Handling

- If no API key is configured, the script exits with an error message
- If transcription fails (unsupported format, API error), it prints the error to stderr
- Telegram Bot API limits file downloads to 20 MB — larger files won't be saved to disk
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/transcribe-media/
git commit -m "feat: add transcribe-media agent skill"
```

---

### Task 6: Update Dockerfile to install transcribe-media

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: Add transcribe-media installation to Dockerfile**

In `container/Dockerfile`, add after the `RUN npm install -g agent-browser @anthropic-ai/claude-code` line (line 34):

```dockerfile
# Install transcribe-media script
COPY transcribe-media/ /opt/transcribe-media/
RUN cd /opt/transcribe-media && npm install --omit=dev && \
    ln -s /opt/transcribe-media/transcribe-media.mjs /usr/local/bin/transcribe-media && \
    chmod +x /opt/transcribe-media/transcribe-media.mjs
```

- [ ] **Step 2: Commit**

```bash
git add container/Dockerfile
git commit -m "chore: install transcribe-media script in container image"
```

---

### Task 7: Delete `src/transcription.ts` and clean up

**Files:**
- Delete: `src/transcription.ts`
- Possibly modify: `src/channels/telegram.ts` (verify import removed)
- Possibly modify: `package.json` (remove `openai` if unused)

- [ ] **Step 1: Verify transcription.ts is no longer imported**

Run: `grep -r "transcription" src/ --include="*.ts" -l`
Expected: Only `src/transcription.ts` itself. The import was removed in Task 3.

- [ ] **Step 2: Check if `openai` is used elsewhere in the host project**

Run: `grep -r "openai" src/ --include="*.ts" -l`
Expected: Only `src/transcription.ts`. If nothing else uses it, remove from `package.json`.

- [ ] **Step 3: Delete the file and remove openai dependency if unused**

```bash
rm src/transcription.ts
npm uninstall openai  # only if Step 2 confirmed no other usage
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git rm src/transcription.ts
git add package.json package-lock.json
git commit -m "chore: remove host-side transcription module and openai dependency"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Rebuild container image**

Run: `./container/build.sh`
Expected: Image builds successfully with `transcribe-media` installed

- [ ] **Step 4: Restart service**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Expected: Service restarts and connects to Telegram
