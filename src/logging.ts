import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export function installConsoleLogFile(file: string | undefined): void {
  if (!file) return;
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const method of ['log', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      fs.appendFileSync(target, `${format(...args)}\n`, 'utf8');
    };
  }
}
