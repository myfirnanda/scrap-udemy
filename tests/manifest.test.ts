import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isCourseComplete, reconcileManifest, type Lecture, type Manifest } from '../src/manifest.js';

function manifest(lecture: Lecture): Manifest {
  return { courseTitle: 'Test', courseUrl: 'https://www.udemy.com/course/test/learn/', sections: [{ number: 1, title: 'One', id: null, lectures: [lecture] }] };
}

function lecture(overrides: Partial<Lecture>): Lecture {
  return {
    number: 1, title: 'Lecture', type: 'video', url: null, status: 'pending', reason: null,
    outputFile: null, id: '1', hasResources: false, attachmentsScanned: true, attachmentReason: null, attachments: [],
    ...overrides
  };
}

test('legacy skipped video is incomplete and will be retried', async () => {
  assert.equal(await isCourseComplete('.', manifest(lecture({ status: 'skipped', reason: 'Transcript tidak tersedia.' }))), false);
});

test('unsupported quiz is a valid terminal state', async () => {
  assert.equal(await isCourseComplete('.', manifest(lecture({ type: 'quiz', status: 'skipped', reason: 'Jenis lecture interaktif tidak didukung.' }))), true);
});

test('confirmed unavailable transcript is a valid terminal state with warning', async () => {
  assert.equal(await isCourseComplete('.', manifest(lecture({ status: 'unavailable', reason: 'Video tidak menyediakan transcript.' }))), true);
});

test('legacy skipped attachment makes a course incomplete', async () => {
  const item = lecture({
    status: 'unavailable', hasResources: true,
    attachments: [{ sourceIndex: 0, name: 'file', href: '', kind: 'download', status: 'skipped', reason: 'timeout', outputFile: null, size: null }]
  });
  assert.equal(await isCourseComplete('.', manifest(item)), false);
});

test('resource flag with an empty attachment scan remains incomplete', async () => {
  const item = lecture({ status: 'unavailable', hasResources: true, attachmentsScanned: true, attachments: [] });
  assert.equal(await isCourseComplete('.', manifest(item)), false);
});

test('new curriculum items remain pending while valid old output is preserved', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'udemy-manifest-test-'));
  try {
    await fs.writeFile(path.join(root, 'old.md'), 'saved transcript');
    const previous = manifest(lecture({ status: 'completed', outputFile: 'old.md' }));
    const fresh = manifest(lecture({ status: 'pending' }));
    fresh.sections[0].lectures.push(lecture({ number: 2, id: '2', title: 'New lecture' }));
    const reconciled = await reconcileManifest(fresh, previous, root);
    assert.equal(reconciled.sections[0].lectures[0].status, 'completed');
    assert.equal(reconciled.sections[0].lectures[1].status, 'pending');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
