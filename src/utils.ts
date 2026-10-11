import path from 'node:path';
import fs from 'node:fs/promises';

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function cleanName(value: string): string {
  const name = value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_').replace(/[. ]+$/g, '').slice(0, 110);
  return name || 'Untitled';
}
export function courseFolderName(title: string, owner: string): string {
  const ownerPart = cleanName(owner).slice(0, 35);
  const titlePart = cleanName(title).slice(0, Math.max(1, 110 - ownerPart.length - 1));
  return `${titlePart}_${ownerPart}`;
}

export function relativeFile(sectionNumber: number, sectionTitle: string, lectureNumber: number, lectureTitle: string): string {
  return path.join(`${sectionNumber}_${cleanName(sectionTitle)}`, `${lectureNumber}_${cleanName(lectureTitle)}.md`);
}

export function relativeResourceDir(sectionNumber: number, sectionTitle: string, lectureNumber: number, lectureTitle: string): string {
  return path.join(`${sectionNumber}_${cleanName(sectionTitle)}`, `${lectureNumber}_${cleanName(lectureTitle)}_resources`);
}

export async function existsNonempty(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).size > 0; } catch { return false; }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
}
