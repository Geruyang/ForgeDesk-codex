import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertHistoricalFz3bProfileBinding, assertHistoricalFz3bProfileDefinition, historicalFz3bProfileDefinitions,
  resolveHistoricalFz3bProfile, FZ3B_HISTORICAL_VALIDATOR_VERSION } from './profile-history.js';

const entry = historicalFz3bProfileDefinitions()[0]!;

test('historical registry is a closed singleton for the exact prior profile and fixture', () => {
  assert.equal(historicalFz3bProfileDefinitions().length, 1);
  assert.equal(entry.profileId, 'fz3b-existing-v2-candidate008-semantic-v1');
  assert.equal(entry.profileSha256, '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd');
  assert.equal(entry.validatorVersion, FZ3B_HISTORICAL_VALIDATOR_VERSION);
  assert.deepEqual(resolveHistoricalFz3bProfile(entry.profileSha256), entry);
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(entry.profile), true);
  assert.equal(Object.isFrozen(entry.fixture), true);
  assert.equal(Object.isFrozen(entry.fixture.encoderIdentity), true);
  assert.equal(Object.isFrozen(entry.fixture.queryIds), true);
});

test('archived fixture equals the exact shipped historical fixture bytes after JSON decoding', async () => {
  const actual = JSON.parse(await readFile(path.resolve('engineering/fz3b/product/resources/fixture/host-fixture.json'), 'utf8'));
  assert.deepEqual(actual, entry.fixture);
  assert.deepEqual(assertHistoricalFz3bProfileDefinition(entry), entry);
});

test('historical binding accepts only exact registered id and hash fields', () => {
  assert.deepEqual(assertHistoricalFz3bProfileBinding({ profileId: entry.profileId, profileSha256: entry.profileSha256 }), entry);
  assert.throws(() => assertHistoricalFz3bProfileBinding({ profileId: entry.profileId, profileSha256: 'a'.repeat(64) }), /UNKNOWN_HISTORICAL/);
  assert.throws(() => assertHistoricalFz3bProfileBinding({ profileId: 'other', profileSha256: entry.profileSha256 }), /BINDING_MISMATCH/);
  assert.throws(() => assertHistoricalFz3bProfileBinding({ profileId: entry.profileId, profileSha256: entry.profileSha256, bootId: 'other' }), /BINDING_INVALID/);
  assert.throws(() => assertHistoricalFz3bProfileBinding({ profileId: entry.profileId, profileSha256: 'not-a-hash' }), /BINDING_INVALID/);
});

test('historical definition verification rejects changed fixture, profile, validator, hash and extra fields', () => {
  const definition = () => structuredClone(entry);
  assert.deepEqual(assertHistoricalFz3bProfileDefinition(definition()), entry);

  const changedFixture = definition(); changedFixture.fixture.imageSha256 = 'a'.repeat(64);
  assert.throws(() => assertHistoricalFz3bProfileDefinition(changedFixture), /DEFINITION_INVALID/);
  const changedProfile = definition(); (changedProfile.profile as unknown as { bootId: string }).bootId = 'foreign-boot';
  assert.throws(() => assertHistoricalFz3bProfileDefinition(changedProfile), /DEFINITION_INVALID/);
  const changedVersion = definition(); changedVersion.validatorVersion = 'future-validator' as typeof entry.validatorVersion;
  assert.throws(() => assertHistoricalFz3bProfileDefinition(changedVersion), /DEFINITION_INVALID/);
  const changedHash = definition(); changedHash.profileSha256 = 'b'.repeat(64);
  assert.throws(() => assertHistoricalFz3bProfileDefinition(changedHash), /DEFINITION_INVALID/);
  assert.throws(() => assertHistoricalFz3bProfileDefinition({ ...definition(), extra: true }), /DEFINITION_INVALID/);
});

test('invalid hash inputs and an accessor-backed binding fail closed', () => {
  assert.throws(() => resolveHistoricalFz3bProfile(undefined), /UNKNOWN_HISTORICAL/);
  assert.throws(() => resolveHistoricalFz3bProfile('A'.repeat(64)), /UNKNOWN_HISTORICAL/);
  const accessor = Object.defineProperty({}, 'profileId', { enumerable: true, get: () => entry.profileId });
  Object.defineProperty(accessor, 'profileSha256', { enumerable: true, value: entry.profileSha256 });
  assert.throws(() => assertHistoricalFz3bProfileBinding(accessor), /BINDING_INVALID/);
  const nestedAccessor = structuredClone(entry);
  Object.defineProperty(nestedAccessor.profile, 'bootId', { enumerable: true, get: () => entry.profile.bootId });
  assert.throws(() => assertHistoricalFz3bProfileDefinition(nestedAccessor), /DEFINITION_INVALID/);
});
