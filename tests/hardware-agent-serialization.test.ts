import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeHardwareAgentEvidence } from './helpers/hardware-agent-installed';

test('offline serialization preserves only the exact native-authorization control state enum', () => {
  for (const state of ['pending', 'passed', 'failed']) {
    assert.deepEqual(sanitizeHardwareAgentEvidence({ controls: { nativeAuthorization: state } }), { controls: { nativeAuthorization: state } });
  }
  for (const value of ['Bearer synthetic-secret', 'passed ', 'PASS', '', { passed: true }, ['passed'], null]) {
    assert.deepEqual(sanitizeHardwareAgentEvidence({ controls: { nativeAuthorization: value } }), { controls: { nativeAuthorization: '[REDACTED]' } });
  }
});

test('offline serialization still redacts actual authorization fields even when their value matches a control state', () => {
  const value = { Authorization: 'Bearer synthetic-secret', authorization: 'passed', nativeAuthorization: 'passed',
    controls: { Authorization: 'passed', authorization: 'pending', access_token: 'synthetic-access',
      nested: { nativeAuthorization: 'passed' } }, records: [{ controls: { nativeAuthorization: 'passed' } }] };
  assert.deepEqual(sanitizeHardwareAgentEvidence(value), {
    Authorization: '[REDACTED]', authorization: '[REDACTED]', nativeAuthorization: '[REDACTED]',
    controls: { Authorization: '[REDACTED]', authorization: '[REDACTED]', access_token: '[REDACTED]',
      nested: { nativeAuthorization: '[REDACTED]' } }, records: [{ controls: { nativeAuthorization: '[REDACTED]' } }],
  });
});

test('offline serialization preserves audit facts without mutating them and redacts secret leaf strings', () => {
  const value = { controls: { nativeAuthorization: 'passed', flash: 'passed' }, run: { runId: 'actual-run', nativeApproval: 'approved' },
    diagnostic: 'Authorization: Bearer synthetic-secret', error: 'access_token="synthetic-token"',
    credential: 'synthetic-credential', bindingKey: 'synthetic-binding', calls: [{ callId: 'actual-call', tool: 'embedded_request_flash' }] };
  const before = structuredClone(value);
  const sanitized = sanitizeHardwareAgentEvidence(value) as typeof value;
  assert.deepEqual(value, before);
  assert.deepEqual(sanitized.controls, value.controls); assert.deepEqual(sanitized.run, value.run); assert.deepEqual(sanitized.calls, value.calls);
  assert.equal(sanitized.credential, '[REDACTED]'); assert.equal(sanitized.bindingKey, '[REDACTED]');
  assert.match(sanitized.diagnostic, /REDACTED/); assert.match(sanitized.error, /REDACTED/);
  assert.ok(!JSON.stringify(sanitized).includes('synthetic-'));
});
