import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const cliFile = path.resolve('node_modules', '@playwright', 'cli', 'playwright-cli.js');
const session = 'udemy-scraper';

export async function cli(args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout } = await runFile(process.execPath, [cliFile, `-s=${session}`, ...args], {
      cwd: process.cwd(), timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string | number };
    const output = (failure.stdout || failure.stderr || '').trim();
    const diagnostic = failure.killed
      ? `Playwright CLI melewati timeout ${timeout} ms${failure.signal ? ` (${failure.signal})` : ''}`
      : `Playwright CLI gagal${failure.code !== undefined ? ` (code ${failure.code})` : ''}`;
    throw new Error(`${diagnostic}${output ? `: ${output}` : `: ${failure.message}`}`.slice(0, 3000));
  }
}
export async function runCode<T>(source: string, timeout = 120_000): Promise<T> {
  const result = await cli(['--raw', 'run-code', source], timeout);
  return JSON.parse(result) as T;
}

export async function runCodeFile<T>(file: string, timeout = 300_000): Promise<T> {
  const result = await cli(['--raw', 'run-code', `--filename=${file}`], timeout);
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
