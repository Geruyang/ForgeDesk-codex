import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStructure } from '../tools/ssh_hardening_structure.mjs';

const sha = 'a'.repeat(64);
function report() {
  return { schemaVersion: 1, scope: 'fz3b-sshd-config-structure-readonly',
    readOnly: true, configurationChanged: false,
    configSha256: 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216',
    configBytes: 3248, sessionContextMatches: true,
    matchCount: 1, includeCount: 0, contentOmittedExceptMatchAndAuthValues: true,
    directives: [{ line: 1, key: 'passwordauthentication', valueSha256: sha, authValue: 'yes' },
      { line: 3, key: 'match', valueSha256: sha, matchCriteria: 'User root' }] };
}

test('bounded fixed structure is accepted', () => {
  assert.equal(validateStructure(Buffer.from(JSON.stringify(report()))).matchCount, 1);
});

test('changed source context and unexpected include fail closed', () => {
  assert.throws(() => validateStructure(Buffer.from(JSON.stringify({
    ...report(), sessionContextMatches: false }))), /invalid-structure-envelope/);
  assert.throws(() => validateStructure(Buffer.from(JSON.stringify({
    ...report(), includeCount: 1 }))), /invalid-structure-envelope/);
});

test('unauthorized raw values and inconsistent Match count fail closed', () => {
  const value = report();
  value.directives[0].matchCriteria = '/raw/config/value';
  assert.throws(() => validateStructure(Buffer.from(JSON.stringify(value))), /invalid-structure-entry/);
  assert.throws(() => validateStructure(Buffer.from(JSON.stringify({
    ...report(), matchCount: 0 }))), /match-count-mismatch/);
});
