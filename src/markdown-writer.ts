import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeMarkdown(root: string, relative: string, content: string): Promise<void> {
  if (!content.trim()) throw new Error('Konten Markdown kosong.');
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content.replace(/\r\n/g, '\n').trimEnd() + '\n', 'utf8');
  await fs.rename(temporary, file);
  await fs.rm(`${file}.arabic.pending`, { force: true });
}
