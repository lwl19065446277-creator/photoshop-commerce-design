import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandQueue } from '../src/bridge/queue.js';

const isCode = (code: string) => (error: any) => error?.code === code;
const connect = (queue: CommandQueue) => queue.hello({ pluginVersion: 'test-peer', photoshopVersion: 'TEST-NOT-PHOTOSHOP' }).sessionId;

test('queue refuses disconnected commands instead of returning simulated Photoshop success', async () => {
  const queue = new CommandQueue(100);
  await assert.rejects(queue.submit('ping', {}), isCode('PHOTOSHOP_DISCONNECTED'));
  assert.equal(queue.busy, false);
});

test('queue serializes commands, binds receipts to the session, and accepts duplicate receipt idempotently', async t => {
  const queue = new CommandQueue(1000);
  t.after(() => queue.close());
  const sessionId = connect(queue);
  const result = queue.submit('set_text', { documentId: 1, layerId: 2, text: 'test' });
  await assert.rejects(queue.submit('ping', {}), isCode('BUSY'));
  assert.throws(() => queue.hello({ pluginVersion: 'other', photoshopVersion: 'TEST' }), isCode('BUSY'));
  await assert.rejects(queue.next('wrong-session', 1), isCode('INVALID_SESSION'));
  const command = await queue.next(sessionId);
  assert.equal(command?.operation, 'set_text');
  const receipt = { sessionId, id: command!.id, ok: true, result: { applied: true } };
  assert.throws(() => queue.finish({ ...receipt, sessionId: 'wrong-session' }), isCode('INVALID_SESSION'));
  assert.throws(() => queue.finish({ ...receipt, id: 'unknown-command' }), isCode('UNEXPECTED_RESULT'));
  queue.finish(receipt);
  assert.deepEqual(await result, { applied: true });
  assert.doesNotThrow(() => queue.finish(receipt));
  const secondResult = queue.submit('ping', {});
  queue.finish(receipt); // An old duplicate must not resolve or clear a newer pending command.
  assert.equal(queue.busy, true);
  const second = await queue.next(sessionId);
  assert.notEqual(second?.id, receipt.id);
  queue.finish({ sessionId, id: second!.id, ok: true, result: { second: true } });
  assert.deepEqual(await secondResult, { second: true });
});

test('queue rejects a receipt before delivery and propagates structured plugin errors', async t => {
  const queue = new CommandQueue(1000);
  t.after(() => queue.close());
  const sessionId = connect(queue);
  const result = queue.submit('replace_smart_object', {}, 'known-command');
  const rejected = assert.rejects(result, (error: any) => error.code === 'WRONG_LAYER_KIND' && error.details?.layerId === 3);
  assert.throws(() => queue.finish({ sessionId, id: 'known-command', ok: true, result: {} }), isCode('UNEXPECTED_RESULT'));
  await queue.next(sessionId);
  queue.finish({ sessionId, id: 'known-command', ok: false, error: { code: 'WRONG_LAYER_KIND', message: 'Not a smart object', details: { layerId: 3 } } });
  await rejected;
  assert.equal(queue.busy, false);
});

test('undelivered timeout removes command safely and allows a later explicit command', async t => {
  const queue = new CommandQueue(25, 1000);
  t.after(() => queue.close());
  const sessionId = connect(queue);
  await assert.rejects(queue.submit('set_text', {}), isCode('COMMAND_NOT_DELIVERED'));
  assert.equal(queue.uncertain, false);
  assert.equal(await queue.next(sessionId, 1), undefined);
  const retry = queue.submit('ping', {});
  const command = await queue.next(sessionId);
  queue.finish({ sessionId, id: command!.id, ok: true, result: { alive: true } });
  assert.deepEqual(await retry, { alive: true });
});

test('delivered timeout is uncertain, never replays mutation, and blocks further execution', async t => {
  const queue = new CommandQueue(25, 1000);
  t.after(() => queue.close());
  const sessionId = connect(queue);
  const pending = queue.submit('replace_smart_object', { layerId: 3 });
  const failure = assert.rejects(pending, isCode('EXECUTION_UNCERTAIN'));
  const command = await queue.next(sessionId);
  assert.ok(command);
  await failure;
  assert.equal(queue.uncertain, true);
  assert.equal(await queue.next(sessionId, 1), undefined);
  await assert.rejects(queue.submit('replace_smart_object', { layerId: 3 }), isCode('EXECUTION_UNCERTAIN'));
  assert.throws(() => queue.finish({ sessionId, id: command.id, ok: true, result: {} }), isCode('UNEXPECTED_RESULT'));
});

test('only one long poll waits; a queued command wakes that poll once', async t => {
  const queue = new CommandQueue(1000);
  t.after(() => queue.close());
  const sessionId = connect(queue);
  const poll = queue.next(sessionId, 1000);
  await assert.rejects(queue.next(sessionId, 1), isCode('POLL_ALREADY_PENDING'));
  const result = queue.submit('ping', {});
  const command = await poll;
  assert.equal(command?.operation, 'ping');
  queue.finish({ sessionId, id: command!.id, ok: true, result: 'pong' });
  assert.equal(await result, 'pong');
});

test('a replacement session invalidates old session IDs and receipts', async t => {
  const queue = new CommandQueue(1000, 1000);
  t.after(() => queue.close());
  const oldId = connect(queue);
  assert.throws(() => connect(queue), isCode('ALREADY_CONNECTED'));
  queue.session!.lastSeen = Date.now() - 2000;
  const nextId = connect(queue);
  assert.notEqual(nextId, oldId);
  await assert.rejects(queue.next(oldId, 1), isCode('INVALID_SESSION'));
  assert.throws(() => queue.finish({ sessionId: oldId, id: 'old', ok: true }), isCode('INVALID_SESSION'));
});

test('disconnect refuses to abandon a pending mutation and invalidates the idle session explicitly', async t => {
  const queue = new CommandQueue(1000);
  t.after(() => queue.close());
  const sessionId = connect(queue);
  const pending = queue.submit('set_text', { documentId: 1, layerId: 2, text: 'pending' });
  assert.throws(() => queue.disconnect(sessionId), isCode('BUSY'));
  assert.equal(queue.connected, true);
  const command = await queue.next(sessionId);
  assert.throws(() => queue.disconnect(sessionId), isCode('BUSY'));
  queue.finish({ sessionId, id: command!.id, ok: true, result: { applied: true } });
  await pending;
  assert.throws(() => queue.disconnect('wrong-session'), isCode('INVALID_SESSION'));
  queue.disconnect(sessionId);
  assert.equal(queue.connected, false);
  await assert.rejects(queue.next(sessionId, 1), isCode('INVALID_SESSION'));
  await assert.rejects(queue.submit('ping', {}), isCode('PHOTOSHOP_DISCONNECTED'));
  assert.notEqual(connect(queue), sessionId);
});
