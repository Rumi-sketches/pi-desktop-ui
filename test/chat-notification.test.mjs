import test from 'node:test';
import assert from 'node:assert/strict';
import { chatNotificationPayload } from '../electron/chat-notification.mjs';

test('desktop notifications accept only a bounded chat identity and title', () => {
  assert.deepEqual(chatNotificationPayload({ key: 'chat-key', title: 'Project title' }), {
    key: 'chat-key', title: 'Project title',
  });
  for (const payload of [null, { key: '', title: 'Title' }, { key: 'k', title: '' },
    { key: 'k', title: 'x'.repeat(101) }, { key: 'k', title: 'a\nsecret' },
    { key: 'k', title: 'Title', body: 'message' },
  ]) {
    const result = chatNotificationPayload(payload);
    if (payload?.body) assert.deepEqual(result, { key: 'k', title: 'Title' });
    else assert.equal(result, null);
  }
});
