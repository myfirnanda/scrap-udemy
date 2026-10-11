import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditExistingArabicTranscripts } from '../src/audit-existing-transcripts.js';
import { type Manifest } from '../src/manifest.js';
import { writeMarkdown } from '../src/markdown-writer.js';

test('existing Arabic transcript is removed from Markdown output and its queued course is resumed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'udemy-arabic-audit-'));
  try {
    const output = path.join(root, 'output');
    const courseRoot = path.join(output, 'course');
    const sectionRoot = path.join(courseRoot, '1_Section');
    await fs.mkdir(sectionRoot, { recursive: true });
    const relative = path.join('1_Section', '1_Lecture.md');
    await fs.writeFile(path.join(courseRoot, relative), 'هذا نص عربي طويل ويجب استبداله بنسخة إنجليزية قبل اعتباره مكتملاً.');
    const manifest: Manifest = {
      courseTitle: 'Course', courseUrl: 'https://www.udemy.com/course/example/learn/', completedAt: new Date().toISOString(),
      sections: [{ number: 1, title: 'Section', id: null, lectures: [{
        number: 1, title: 'Lecture', type: 'video', url: null, status: 'completed', reason: null,
        outputFile: relative, id: '1', attachmentsScanned: true, attachments: []
      }] }]
    };
    await fs.writeFile(path.join(courseRoot, 'course_manifest.json'), JSON.stringify(manifest));
    const queueFile = path.join(root, 'queue-state.json');
    await fs.writeFile(queueFile, JSON.stringify({ courses: [{ Url: 'https://www.udemy.com/course/example/', Status: 'completed' }] }));

    const result = await auditExistingArabicTranscripts(queueFile, output);
    const updatedManifest = JSON.parse(await fs.readFile(path.join(courseRoot, 'course_manifest.json'), 'utf8')) as Manifest;
    const updatedQueue = JSON.parse(await fs.readFile(queueFile, 'utf8')) as { courses: Array<{ Status: string }> };
    assert.deepEqual(result, { transcriptsInvalidated: 1, coursesRequeued: 1, replacedBackupsRemoved: 0 });
    assert.equal(updatedManifest.sections[0].lectures[0].status, 'pending');
    assert.equal(updatedManifest.sections[0].lectures[0].outputFile, null);
    assert.equal(updatedManifest.completedAt, null);
    assert.equal(updatedQueue.courses[0].Status, 'pending');
    await assert.rejects(fs.access(path.join(courseRoot, relative)));
    await fs.access(path.join(courseRoot, `${relative}.arabic.pending`));
    await writeMarkdown(courseRoot, relative, 'This is the replacement English transcript.');
    await assert.rejects(fs.access(path.join(courseRoot, `${relative}.arabic.pending`)));
    assert.equal(await fs.readFile(path.join(courseRoot, relative), 'utf8'), 'This is the replacement English transcript.\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
