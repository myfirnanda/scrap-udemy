import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArabicTranscript } from './transcript-language.js';
import { type Manifest } from './manifest.js';
import { writeJsonAtomic } from './utils.js';

type QueueCourse = {
  Url: string;
  Status: string;
  Reason?: string | null;
  UpdatedAt?: string;
};

type QueueState = {
  updatedAt?: string;
  courses: QueueCourse[];
};

export type ArabicAuditResult = {
  transcriptsInvalidated: number;
  coursesRequeued: number;
};

function courseKey(value: string): string | null {
  try { return new URL(value).pathname.match(/^\/course\/([^/]+)/)?.[1] ?? null; }
  catch { return null; }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value.replace(/^\uFEFF/, '')) as T;
}

export async function auditExistingArabicTranscripts(queueStateFile: string, outputRoot: string): Promise<ArabicAuditResult> {
  const queue = parseJson<QueueState>(await fs.readFile(queueStateFile, 'utf8'));
  const queueByCourse = new Map(queue.courses.map(course => [courseKey(course.Url), course]));
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  let transcriptsInvalidated = 0;
  const requeued = new Set<QueueCourse>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_quarantine') continue;
    const root = path.join(outputRoot, entry.name);
    const manifestFile = path.join(root, 'course_manifest.json');
    let manifest: Manifest;
    try { manifest = parseJson<Manifest>(await fs.readFile(manifestFile, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let changed = false;
    let courseInvalidated = 0;
    for (const section of manifest.sections) {
      for (const lecture of section.lectures) {
        if (lecture.type !== 'video' || lecture.status !== 'completed' || !lecture.outputFile) continue;
        const transcriptFile = path.join(root, lecture.outputFile);
        let content: string;
        try { content = await fs.readFile(transcriptFile, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!isArabicTranscript(content)) continue;
        const backupFile = `${transcriptFile}.arabic.pending`;
        await fs.rename(transcriptFile, backupFile);
        lecture.status = 'pending';
        lecture.reason = `Transcript Arab dipindahkan ke ${path.basename(backupFile)} dan harus diekstrak ulang dalam English.`;
        lecture.outputFile = null;
        lecture.transcriptMeta = null;
        transcriptsInvalidated++;
        courseInvalidated++;
        changed = true;
      }
    }
    if (!changed) continue;
    manifest.completedAt = null;
    await writeJsonAtomic(manifestFile, manifest);
    const queued = queueByCourse.get(courseKey(manifest.courseUrl));
    if (queued) {
      queued.Status = 'pending';
      queued.Reason = `${courseInvalidated} transcript Arab perlu diekstrak ulang dalam English.`;
      queued.UpdatedAt = new Date().toISOString();
      requeued.add(queued);
    }
  }

  if (requeued.size) {
    queue.updatedAt = new Date().toISOString();
    await writeJsonAtomic(queueStateFile, queue);
  }
  return { transcriptsInvalidated, coursesRequeued: requeued.size };
}

async function main(): Promise<void> {
  const queueState = process.argv.find(value => value.startsWith('--queue-state='))?.slice('--queue-state='.length);
  const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
  if (!queueState || !output) throw new Error('Argumen --queue-state dan --output wajib diisi.');
  const result = await auditExistingArabicTranscripts(path.resolve(queueState), path.resolve(output));
  if (result.transcriptsInvalidated > 0) {
    console.log(`Audit transcript: ${result.transcriptsInvalidated} file Arab dijadwalkan ulang dari ${result.coursesRequeued} course.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
