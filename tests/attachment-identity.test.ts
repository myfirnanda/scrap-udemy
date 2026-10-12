import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentIdentity, uniqueAttachments } from '../src/attachment-identity.js';

test('duplicate Udemy resource IDs are kept only once per lecture', () => {
  const resources = uniqueAttachments([
    { sourceIndex: 0, resourceId: '123', name: 'slides.pdf', href: '', kind: 'download' },
    { sourceIndex: 1, resourceId: '123', name: 'slides.pdf', href: '', kind: 'download' }
  ]);

  assert.equal(resources.length, 1);
  assert.equal(resources[0].sourceIndex, 0);
});

test('changing a signed URL query does not create a second resource identity', () => {
  const first = attachmentIdentity({ sourceIndex: 0, name: 'code.zip', href: 'https://att-c.udemycdn.com/files/code.zip?Expires=1&Signature=old' });
  const refreshed = attachmentIdentity({ sourceIndex: 0, name: 'code.zip', href: 'https://att-c.udemycdn.com/files/code.zip?Expires=2&Signature=new' });

  assert.equal(first, refreshed);
});

test('different Udemy resource IDs remain separate even with the same filename', () => {
  const resources = uniqueAttachments([
    { sourceIndex: 0, resourceId: '123', name: 'source.zip', href: '', kind: 'download' },
    { sourceIndex: 1, resourceId: '456', name: 'source.zip', href: '', kind: 'download' }
  ]);

  assert.equal(resources.length, 2);
});
