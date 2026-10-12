import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runCodeFile } from './extension-cli.js';
import type { Lecture } from './manifest.js';
import type { LiveLine } from './live-line.js';
import { existsNonempty } from './utils.js';

const runFile = promisify(execFile);

type MediaSource = {
  availability: 'available' | 'retryable' | 'unavailable';
  reason: string | null;
  mediaUrl: string | null;
  duration: number | null;
};

type WhisperPayload = {
  language: string;
  languageProbability: number;
  segments: Array<{ start: number; end: number; text: string }>;
};

export type LocalWhisperResult = {
  content: string;
  cueCount: number;
  firstCue: string | null;
  lastCue: string | null;
  language: 'en';
  sourceLanguage: string;
  source: 'whisper-local';
};

export class LocalWhisperUnavailableError extends Error {}

function enabled(): boolean {
  return !['0', 'false', 'no'].includes((process.env.LOCAL_WHISPER_ENABLED ?? '1').toLowerCase());
}

export function shouldUseLocalWhisper(reason: string | null | undefined): boolean {
  if (!enabled()) return false;
  return /kontrol transcript tidak (?:ditemukan|tersedia)|caption english tidak tersedia|panel transcript (?:tersedia tetapi tidak memiliki cue|belum siap setelah timeout)/i.test(reason ?? '');
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await runFile(command, args, { windowsHide: true, timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

async function pythonCommand(progress: LiveLine): Promise<string> {
  const configured = process.env.LOCAL_WHISPER_PYTHON?.trim();
  if (configured) {
    if (!await commandWorks(configured, ['-c', 'import faster_whisper'])) {
      throw new Error(`LOCAL_WHISPER_PYTHON tidak dapat menjalankan faster-whisper: ${configured}`);
    }
    return configured;
  }

  const managed = path.resolve('.whisper-venv', 'Scripts', 'python.exe');
  if (await commandWorks(managed, ['-c', 'import faster_whisper'])) return managed;
  if (await commandWorks('python', ['-c', 'import faster_whisper'])) return 'python';

  progress.update('      Whisper lokal [setup] memasang runtime satu kali...');
  await runFile('python', ['-m', 'venv', path.resolve('.whisper-venv')], { windowsHide: true, timeout: 180_000 });
  await runFile(managed, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.resolve('requirements-whisper.txt')], {
    windowsHide: true,
    timeout: 900_000,
    maxBuffer: 8 * 1024 * 1024
  });
  return managed;
}

function validateMediaUrl(value: string): URL {
  const url = new URL(value);
  const allowedHost = url.hostname === 'www.udemy.com' || url.hostname.endsWith('.udemycdn.com');
  if (url.protocol !== 'https:' || !allowedHost || !/\.m3u8$/i.test(url.pathname)) {
    throw new Error('Playlist media lecture tidak valid atau bukan milik Udemy.');
  }
  return url;
}

async function downloadAudio(mediaUrl: URL, audioFile: string, progress: LiveLine): Promise<void> {
  if (await existsNonempty(audioFile)) return;
  progress.update('      Whisper lokal [audio] menyiapkan audio pada kecepatan asli...');
  await fs.mkdir(path.dirname(audioFile), { recursive: true });
  const temporary = `${audioFile}.${process.pid}.tmp.flac`;
  try {
    await runFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', 'Referer: https://www.udemy.com/\r\nOrigin: https://www.udemy.com\r\n',
      '-i', mediaUrl.href,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', temporary
    ], { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    await fs.rename(temporary, audioFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function runWhisper(python: string, audioFile: string, resultFile: string, duration: number, progress: LiveLine): Promise<void> {
  const model = process.env.LOCAL_WHISPER_MODEL?.trim() || 'base';
  const modelCache = path.resolve('.whisper-models');
  await fs.mkdir(modelCache, { recursive: true });
  progress.update(`      Whisper lokal [model ${model}] memuat model; unduhan hanya terjadi pertama kali...`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [
      path.resolve('scripts', 'transcribe-whisper.py'),
      '--audio', audioFile,
      '--output', resultFile,
      '--model', model,
      '--model-cache', modelCache,
      '--duration', String(duration)
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/^PROGRESS\t(\d+)\t([\d.]+)/);
        if (!match) continue;
        const percent = Math.min(100, Number(match[1]));
        const elapsed = Number(match[2]);
        progress.update(`      Whisper lokal [${'#'.repeat(Math.round(percent / 5)).padEnd(20, '-')}] ${percent}% | ${Math.round(elapsed)}s/${Math.round(duration)}s`);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Whisper lokal gagal (code ${code}): ${stderr.trim()}`)));
  });
}

export async function transcribeWithLocalWhisper(root: string, lecture: Lecture, progress: LiveLine): Promise<LocalWhisperResult> {
  const media = await runCodeFile<MediaSource>('scripts/resolve-video-audio.js', 60_000);
  if (media.availability === 'unavailable') throw new LocalWhisperUnavailableError(media.reason ?? 'Audio lecture tidak dapat diproses oleh Whisper lokal.');
  if (media.availability !== 'available' || !media.mediaUrl) throw new Error(media.reason ?? 'Audio lecture tidak ditemukan.');
  const mediaUrl = validateMediaUrl(media.mediaUrl);
  const duration = media.duration && media.duration > 0 ? media.duration : 0;
  const key = lecture.id ?? `${lecture.number}`;
  const cacheDir = path.join(root, '.asr-cache');
  const audioFile = path.join(cacheDir, `${key}.flac`);
  const resultFile = path.join(cacheDir, `${key}.json`);
  const python = await pythonCommand(progress);
  await downloadAudio(mediaUrl, audioFile, progress);
  await runWhisper(python, audioFile, resultFile, duration, progress);
  const payload = JSON.parse(await fs.readFile(resultFile, 'utf8')) as WhisperPayload;
  const cues = payload.segments.map(segment => segment.text.trim()).filter(Boolean);
  if (!cues.length) throw new Error('Whisper lokal tidak menghasilkan teks.');
  await Promise.all([fs.rm(audioFile, { force: true }), fs.rm(resultFile, { force: true })]);
  return {
    content: cues.join('\n\n') + '\n',
    cueCount: cues.length,
    firstCue: cues[0] ?? null,
    lastCue: cues.at(-1) ?? null,
    language: 'en',
    sourceLanguage: payload.language,
    source: 'whisper-local'
  };
}
