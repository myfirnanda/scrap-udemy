import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const cliFile = path.resolve('node_modules', '@playwright', 'cli', 'playwright-cli.js');
const session = 'udemy-scraper';

type CliFailure = Error & { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string | number };

async function invoke(args: string[], timeout: number): Promise<string> {
  const { stdout } = await runFile(process.execPath, [cliFile, `-s=${session}`, ...args], {
    cwd: process.cwd(), timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true
  });
  return stdout.trim();
}

function failureMessage(error: unknown, timeout: number): string {
  const failure = error as CliFailure;
  const output = (failure.stdout || failure.stderr || '').trim();
  const diagnostic = failure.killed
    ? `Playwright CLI melewati timeout ${timeout} ms${failure.signal ? ` (${failure.signal})` : ''}`
    : `Playwright CLI gagal${failure.code !== undefined ? ` (code ${failure.code})` : ''}`;
  return `${diagnostic}${output ? `: ${output}` : `: ${failure.message}`}`.slice(0, 3000);
}

export function isModalStateFailure(error: unknown): boolean {
  return /does not handle the modal state|beforeunload.*dialog/i.test(failureMessage(error, 0));
}

export async function cli(args: string[], timeout = 30_000): Promise<string> {
  try { return await invoke(args, timeout); }
  catch (error) {
    const isDialogCommand = args[0] === 'dialog-accept' || args[0] === 'dialog-dismiss';
    if (!isDialogCommand && isModalStateFailure(error)) {
      try {
        await invoke(['dialog-accept'], 10_000);
        return await invoke(args, timeout);
      } catch (recoveryError) {
        throw new Error(failureMessage(recoveryError, timeout));
      }
    }
    throw new Error(failureMessage(error, timeout));
  }
}
export async function runCode<T>(source: string, timeout = 120_000): Promise<T> {
  const args = ['--raw', 'run-code', source];
  let result = await cli(args, timeout);
  if (!result.trim()) result = await cli(args, timeout);
  if (!result.trim()) throw new Error('Playwright CLI mengembalikan JSON kosong setelah pemulihan halaman.');
  return JSON.parse(result) as T;
}

export async function runCodeFile<T>(file: string, timeout = 300_000): Promise<T> {
  const args = ['--raw', 'run-code', `--filename=${file}`];
  let result = await cli(args, timeout);
  if (!result.trim()) result = await cli(args, timeout);
  if (!result.trim()) throw new Error('Playwright CLI mengembalikan JSON kosong setelah pemulihan halaman.');
  return JSON.parse(result) as T;
}

export async function attachExistingChrome(): Promise<void> {
  try {
    await cli(['attach', '--extension=chrome', `--session=${session}`], 60_000);
  } catch (error) {
    if (String(error).includes('Playwright Extension not found')) {
      throw new Error('Playwright Extension belum terpasang di profil Chrome yang sedang digunakan. Pasang extension resmi dari https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm lalu jalankan ulang pemeriksaan koneksi.');
    }
    throw error;
  }
}
