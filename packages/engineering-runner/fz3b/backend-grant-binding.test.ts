import assert from 'node:assert/strict';
import test from 'node:test';
import { Fz3bBackend } from './backend.js';
import { historicalFz3bProfileDefinitions } from './profile-history.js';
import type { Fz3bGrantPreview } from './types.js';

const old = historicalFz3bProfileDefinitions()[0]!;
const now = Date.parse('2026-10-17T00:01:00.000Z');
const methods = Fz3bBackend.prototype as unknown as {
  grant(this: unknown, record: unknown): Fz3bGrantPreview;
  checkGrant(this: unknown, record: unknown): void;
};
function memory() {
  const receiver = { profileHash: old.profileSha256, fixture: structuredClone(old.fixture), now: () => now };
  const record = { runId: 'memory-run', sessionId: 'memory-session', taskId: 'memory-task',
    artifact: { id: 'memory-artifact' }, identity: { bootId: old.profile.bootId },
    grant: undefined as (Fz3bGrantPreview & { approvedAt: string; consumedBy?: string }) | undefined };
  record.grant = { ...methods.grant.call(receiver, record), approvedAt: new Date(now).toISOString() };
  return { receiver, record };
}

test('real grant creation and validation match run/session/task without constructing or initializing a backend', () => {
  const { receiver, record } = memory();
  for (const field of ['runId', 'sessionId', 'taskId'] as const) assert.equal(record.grant![field], record[field]);
  const before = structuredClone(record);
  methods.checkGrant.call(receiver, record);
  assert.deepEqual(record, before);
});

test('grant bound to a prior run/session/task is refused before consumption even with unchanged valid plan hash', () => {
  for (const field of ['runId', 'sessionId', 'taskId'] as const) {
    const { receiver, record } = memory();
    record[field] = 'another-context';
    assert.throws(() => methods.checkGrant.call(receiver, record), /grant is absent, expired, consumed or changed/);
    assert.equal(record.grant!.consumedBy, undefined);
  }
});

test('existing cross-profile and one-use grant refusal remains unchanged', () => {
  const { receiver, record } = memory();
  assert.throws(() => methods.checkGrant.call({ ...receiver, profileHash: 'a'.repeat(64) }, record), /grant is absent/);
  record.grant!.consumedBy = 'memory-operation';
  assert.throws(() => methods.checkGrant.call(receiver, record), /grant is absent/);
});
