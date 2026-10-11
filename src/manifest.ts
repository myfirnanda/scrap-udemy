import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsNonempty, relativeFile, writeJsonAtomic } from './utils.js';

export type LectureType = 'video' | 'article' | 'resource' | 'quiz' | 'exercise' | 'unknown';
export type Status = 'pending' | 'completed' | 'unavailable' | 'skipped' | 'failed';
export type AttachmentStatus = 'pending' | 'completed' | 'unavailable' | 'skipped' | 'failed';
export type AttachmentKind = 'download' | 'external' | 'unknown';
export interface Attachment {
  sourceIndex: number;
  name: string;
  href: string;
  kind?: AttachmentKind;
  status: AttachmentStatus;
  reason: string | null;
  outputFile: string | null;
  size: number | null;
}
export interface Lecture {
  number: number;
  title: string;
  type: LectureType;
  url: string | null;
  status: Status;
  reason: string | null;
  outputFile: string | null;
  id: string | null;
  hasResources?: boolean;
  attachmentsScanned?: boolean;
  attachmentReason?: string | null;
  attachments?: Attachment[];
  transcriptMeta?: {
    cueCount: number;
    firstCue: string | null;
    lastCue: string | null;
    extractedAt: string;
  } | null;
}
export interface Section { number: number; title: string; id: string | null; lectures: Lecture[] }
export interface Manifest {
  courseTitle: string;
  courseOwner?: string;
  courseUrl: string;
  fingerprint?: string;
  completedAt?: string | null;
  sections: Section[];
}

export interface ExistingCourse { root: string; manifest: Manifest; legacy: boolean }

export function courseFingerprint(title: string, owner: string): string {
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  return createHash('sha256').update(`${normalize(title)}\0${normalize(owner)}`, 'utf8').digest('hex');
}

export async function findExistingCourse(output: string, title: string, owner: string, courseUrl: string): Promise<ExistingCourse | null> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(output, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const wanted = courseFingerprint(title, owner);
  const exact: ExistingCourse[] = [];
  const legacy: ExistingCourse[] = [];
  const sameUrl: ExistingCourse[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(output, entry.name);
    const manifest = await loadManifest(path.join(root, 'course_manifest.json'));
    if (!manifest) continue;
    const fingerprint = manifest.fingerprint ?? (manifest.courseOwner ? courseFingerprint(manifest.courseTitle, manifest.courseOwner) : null);
    if (fingerprint === wanted) exact.push({ root, manifest, legacy: false });
    else if (!manifest.courseOwner && manifest.courseTitle === title && manifest.courseUrl === courseUrl)
      legacy.push({ root, manifest, legacy: true });
    else if (manifest.courseUrl === courseUrl) sameUrl.push({ root, manifest, legacy: true });
  }
  const matches = exact.length ? exact : legacy.length ? legacy : sameUrl;
  if (matches.length > 1) throw new Error(`Ditemukan lebih dari satu folder output untuk fingerprint course ${wanted}.`);
  return matches[0] ?? null;
}

export async function isCourseComplete(root: string, manifest: Manifest): Promise<boolean> {
  if (!manifest.sections.length) return false;
  for (const section of manifest.sections) {
    for (const lecture of section.lectures) {
      if (lecture.status === 'pending' || lecture.status === 'failed') return false;
      if (lecture.status === 'skipped' && lecture.type !== 'quiz' && lecture.type !== 'exercise') return false;
      if (lecture.status === 'completed' && (!lecture.outputFile || !await existsNonempty(path.join(root, lecture.outputFile)))) return false;
      if (lecture.attachmentsScanned !== true) return false;
      if (lecture.hasResources && (!(lecture.attachments?.length) || lecture.attachments.some(attachment => !attachment.kind))) return false;
      for (const attachment of lecture.attachments ?? []) {
        if (attachment.status === 'unavailable') continue;
        if (attachment.status === 'skipped') return false;
        if (attachment.status !== 'completed' || !attachment.outputFile || !await existsNonempty(path.join(root, attachment.outputFile))) return false;
      }
    }
  }
  return true;
}

export async function loadManifest(file: string): Promise<Manifest | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Manifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function reconcileManifest(fresh: Manifest, previous: Manifest | null, root: string): Promise<Manifest> {
  if (!previous || previous.courseUrl !== fresh.courseUrl) return fresh;
  for (const section of fresh.sections) {
    const oldSection = (section.id
      ? previous.sections.find(candidate => candidate.id === section.id)
      : null) ?? previous.sections[section.number - 1];
    if (!oldSection) continue;
    for (const lecture of section.lectures) {
      const old = (lecture.id
        ? oldSection.lectures.find(candidate => candidate.id === lecture.id)
        : null) ?? oldSection.lectures[lecture.number - 1];
      if (!old || (old.id && lecture.id && old.id !== lecture.id)) continue;
      if (old.status === 'completed' && old.outputFile && await existsNonempty(path.join(root, old.outputFile))) {
        lecture.status = 'completed';
        lecture.outputFile = old.outputFile;
        lecture.transcriptMeta = old.transcriptMeta ?? null;
      } else if (old.status === 'unavailable') {
        lecture.status = 'unavailable';
        lecture.reason = old.reason;
      } else if (old.status === 'skipped' && (lecture.type === 'quiz' || lecture.type === 'exercise')) {
        lecture.status = 'skipped';
        lecture.reason = old.reason;
      }
      if (lecture.status === 'pending') {
        const recoveredOutput = plannedFile(section, lecture);
        if (await existsNonempty(path.join(root, recoveredOutput))) {
          lecture.status = 'completed';
          lecture.reason = null;
          lecture.outputFile = recoveredOutput;
        }
      }
      const oldAttachments = old.attachments ?? [];
      const currentResourceFormat = !lecture.hasResources || (oldAttachments.length > 0 && oldAttachments.every(attachment => attachment.kind));
      if (old.attachmentsScanned === true && currentResourceFormat) {
        lecture.attachmentsScanned = true;
        lecture.attachmentReason = old.attachmentReason ?? null;
        lecture.attachments = [];
        for (const attachment of oldAttachments) {
          const unavailable = attachment.status === 'unavailable';
          const complete = attachment.status === 'completed' && attachment.outputFile && await existsNonempty(path.join(root, attachment.outputFile));
          lecture.attachments.push({
            ...attachment,
            status: unavailable ? 'unavailable' : complete ? 'completed' : 'pending',
            reason: unavailable ? attachment.reason : complete ? null : attachment.reason,
            outputFile: complete ? attachment.outputFile : null,
            size: complete ? attachment.size : null
          });
        }
      }
    }
  }
  return fresh;
}

export function plannedFile(section: Section, lecture: Lecture): string {
  return relativeFile(section.number, section.title, lecture.number, lecture.title);
}

export async function saveManifest(file: string, manifest: Manifest): Promise<void> {
  const serialized = JSON.stringify(manifest);
  if (lastManifestWrites.get(file) === serialized) return;
  await writeJsonAtomic(file, manifest);
  lastManifestWrites.set(file, serialized);
}

const lastManifestWrites = new Map<string, string>();
