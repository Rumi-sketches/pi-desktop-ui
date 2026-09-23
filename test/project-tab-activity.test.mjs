import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectTabActivity } from '../public/project-tab-activity.js';

function fixture() {
  const folders = new Map([['chat-a', 'C:/repo/a'], ['chat-b', 'c:/REPO/A'], ['chat-c', 'C:/repo/b']]);
  const activity = createProjectTabActivity({ cwdForKey: (key) => folders.get(key) });
  return { folders, activity };
}

test('selection alone shows no activity; running animates and unseen waits for its own chat', () => {
  const { activity } = fixture();
  assert.equal(activity.status('C:/repo/a'), 'idle');
  activity.recordRunning('chat-a', true);
  assert.equal(activity.status('C:/repo/a'), 'working');
  assert.equal(activity.status('C:/repo/b'), 'idle');
  activity.recordRunning('chat-a', false);
  assert.equal(activity.status('C:/repo/a'), 'unseen');
  assert.equal(activity.hasUnseen('chat-a'), true);
  assert.equal(activity.hasUnseen('chat-b'), false);
  activity.viewed('chat-b'); // a different chat in the same selected project
  assert.equal(activity.status('C:/repo/a'), 'unseen');
  activity.viewed('chat-a');
  assert.equal(activity.hasUnseen('chat-a'), false);
  assert.equal(activity.status('C:/repo/a'), 'idle');
});

test('viewed finishes stay idle, and a new run resets a pending response', () => {
  const { activity } = fixture();
  activity.recordRunning('chat-a', false); // never observed starting
  assert.equal(activity.status(null), 'idle');
  activity.recordRunning('chat-a', true);
  activity.recordRunning('chat-a', false, true);
  assert.equal(activity.status(null), 'idle');
  activity.recordRunning('chat-a', true);
  activity.recordRunning('chat-a', false);
  activity.recordRunning('chat-a', true);
  assert.equal(activity.status(null), 'working');
  activity.recordRunning('chat-a', false, true);
  assert.equal(activity.status(null), 'idle');
});

test('multiple chats aggregate by project with running taking precedence', () => {
  const { activity } = fixture();
  activity.recordRunning('chat-a', true);
  activity.recordRunning('chat-a', false);
  activity.recordRunning('chat-b', true);
  activity.recordRunning('chat-c', true);
  assert.equal(activity.status('C:/repo/a'), 'working');
  assert.equal(activity.status('C:/repo/b'), 'working');
  assert.equal(activity.status(null), 'working');
  activity.recordRunning('chat-b', false, true);
  assert.equal(activity.status('C:/repo/a'), 'unseen');
  activity.viewed('chat-a');
  assert.equal(activity.status('C:/repo/a'), 'idle');
});

test('rekey preserves running and pending responses; session refresh does not clear unread', () => {
  const { folders, activity } = fixture();
  activity.recordRunning('chat-a', true);
  folders.set('new-a', folders.get('chat-a'));
  activity.rekey('chat-a', 'new-a');
  assert.equal(activity.runningKeys.has('chat-a'), false);
  assert.equal(activity.status('C:/repo/a'), 'working');
  activity.recordRunning('new-a', false);
  activity.replaceRunning(['chat-c']);
  assert.equal(activity.status('C:/repo/a'), 'unseen');
  activity.rekey('new-a', 'newer-a');
  folders.set('newer-a', 'C:/repo/a');
  activity.viewed('newer-a');
  assert.equal(activity.status('C:/repo/a'), 'idle');
});
