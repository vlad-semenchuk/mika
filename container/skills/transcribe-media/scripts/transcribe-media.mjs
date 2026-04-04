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
