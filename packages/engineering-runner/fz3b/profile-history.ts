import { createHash } from 'node:crypto';
import type { Fz3bSemanticFixture } from './types.js';

export const FZ3B_HISTORICAL_VALIDATOR_VERSION = 'fz3b-fixed-profile-validator-v1' as const;
const LEGACY_PROFILE_SHA256 = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd';
const LEGACY_PROFILE = deepFreeze({
  schemaVersion: 1, id: 'fz3b-existing-v2-candidate008-semantic-v1', revision: 1,
  model: 'gpt-6.1-sol', appRoot: '/root/fz3b-vision-console-20261009-001',
  host: '169.254.220.254', user: 'root', remoteCommand: 'python3 -B -',
  bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df', platform: 'A0005',
  hostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ',
  deployedManifestSha256: 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09',
  existingPlSha256: '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726',
  encoderIdentity: {
    contractId: '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e',
    weightSha256: '1270fab6ea23bacbd61cea564bd521a7e875fdb0fcb6d31382bccf4d973b71a6',
    bpeSha256: '924691ac288e54409236115652ad4aa250f48203de50a9e4722a6ecd48d6804a',
    normalization: 'l2-float32-v1' as const,
  },
  imageSha256: '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967',
  predeclaredSha256: '0e8375dde13eab4335f622aa782087ea56252f9f95d261c6de3523709eb11899',
  semanticManifestSha256: 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56',
  queriesSha256: '0d10e566bb1c167d3987e8d782f1c0c6f87ee3c1aaba9983afe1f8a134e106e9',
  actions: [
    'Replace application query state with the four fixed real-text embeddings; former queries cannot be restored by this protocol.',
    'Create one bounded upload and infer exactly the fixed pillow-scene image on existing candidate008.',
    'Prepare/re-enter the already-approved A0005 candidate008 runtime: the approved loader may load that existing bitstream and change its dedicated PL clock, lease, R5 and device state. No new bitstream or other candidate is authorized.',
    'Save this operation audit and exclusion journal in the fixed application directory; no credentials are included.',
    'Stop the owned inference and verify terminal quiescence; no service restart, arbitrary SSH, reset, new PL, driver or firmware change.',
  ],
});

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ?
    Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function validateHistoricalFixture(value: unknown): asserts value is Fz3bSemanticFixture {
  const expected = {
    id: 'fz3b-pillow-scene-v1', manifestSha256: LEGACY_PROFILE.semanticManifestSha256,
    queriesSha256: LEGACY_PROFILE.queriesSha256, imageSha256: LEGACY_PROFILE.imageSha256,
    predeclaredSha256: LEGACY_PROFILE.predeclaredSha256, width: 914, height: 512,
    queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow',
    queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: LEGACY_PROFILE.encoderIdentity,
  };
  if (!isPlainData(value) || canonicalJson(value) !== canonicalJson(expected)) throw new Error('FZ3B_HISTORICAL_FIXTURE_MISMATCH');
}

export interface HistoricalFz3bProfile {
  schemaVersion: 1;
  validatorVersion: typeof FZ3B_HISTORICAL_VALIDATOR_VERSION;
  profileId: string;
  profileSha256: string;
  profile: typeof LEGACY_PROFILE;
  fixture: Fz3bSemanticFixture;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const fixture = deepFreeze<Fz3bSemanticFixture>({
  id: 'fz3b-pillow-scene-v1',
  manifestSha256: LEGACY_PROFILE.semanticManifestSha256,
  queriesSha256: LEGACY_PROFILE.queriesSha256,
  imageSha256: LEGACY_PROFILE.imageSha256,
  predeclaredSha256: LEGACY_PROFILE.predeclaredSha256,
  width: 914,
  height: 512,
  queryCount: 4,
  embeddingDimensions: 512,
  expectedLabel: 'pillow',
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'],
  encoderIdentity: { ...LEGACY_PROFILE.encoderIdentity },
});
validateHistoricalFixture(fixture);

const computedLegacyProfileSha256 = digest(canonicalJson({ profile: LEGACY_PROFILE, fixture }));
if (computedLegacyProfileSha256 !== LEGACY_PROFILE_SHA256) throw new Error('FZ3B_HISTORICAL_PROFILE_PIN_MISMATCH');

const currentHistoricalProfile = deepFreeze<HistoricalFz3bProfile>({
  schemaVersion: 1,
  validatorVersion: FZ3B_HISTORICAL_VALIDATOR_VERSION,
  profileId: LEGACY_PROFILE.id,
  profileSha256: LEGACY_PROFILE_SHA256,
  profile: LEGACY_PROFILE,
  fixture,
});

// Deliberately not exported: callers cannot register profiles or supply policy.
const HISTORICAL_PROFILES = new Map([[currentHistoricalProfile.profileSha256, currentHistoricalProfile]]);
const SHA256 = /^[a-f0-9]{64}$/;

function isPlainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return false;
  const keys = Object.keys(descriptors);
  if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) return false;
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (descriptor.get || descriptor.set || (key !== 'length' && !descriptor.enumerable) || !isPlainData(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key)) &&
    keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}

function exactDefinition(value: unknown): boolean {
  try {
    if (!isPlainData(value) || !hasExactKeys(value, ['schemaVersion', 'validatorVersion', 'profileId', 'profileSha256', 'profile', 'fixture'])) return false;
    const entry = HISTORICAL_PROFILES.get(value.profileSha256 as string);
    if (!entry || value.schemaVersion !== 1 || value.validatorVersion !== entry.validatorVersion || value.profileId !== entry.profileId ||
        !SHA256.test(value.profileSha256 as string)) return false;
    validateHistoricalFixture(value.fixture);
    return canonicalJson(value.profile) === canonicalJson(entry.profile) &&
      canonicalJson(value.fixture) === canonicalJson(entry.fixture) &&
      digest(canonicalJson({ profile: value.profile, fixture: value.fixture })) === entry.profileSha256;
  } catch {
    return false;
  }
}

/** Resolve only an already-compiled historical profile; this never creates policy from a hash. */
export function resolveHistoricalFz3bProfile(profileSha256: unknown): HistoricalFz3bProfile {
  if (typeof profileSha256 !== 'string' || !SHA256.test(profileSha256)) throw new Error('FZ3B_UNKNOWN_HISTORICAL_PROFILE');
  const entry = HISTORICAL_PROFILES.get(profileSha256);
  if (!entry) throw new Error('FZ3B_UNKNOWN_HISTORICAL_PROFILE');
  return entry;
}

/** Validate the profile identity carried by a persisted run without adopting it as active. */
export function assertHistoricalFz3bProfileBinding(value: unknown): HistoricalFz3bProfile {
  if (!hasExactKeys(value, ['profileId', 'profileSha256']) || typeof value.profileId !== 'string' ||
      !SHA256.test(String(value.profileSha256))) throw new Error('FZ3B_HISTORICAL_PROFILE_BINDING_INVALID');
  const entry = resolveHistoricalFz3bProfile(value.profileSha256);
  if (value.profileId !== entry.profileId) throw new Error('FZ3B_HISTORICAL_PROFILE_BINDING_MISMATCH');
  return entry;
}

/** Verify an exported historical profile envelope against the compiled closed set. */
export function assertHistoricalFz3bProfileDefinition(value: unknown): HistoricalFz3bProfile {
  if (!exactDefinition(value)) throw new Error('FZ3B_HISTORICAL_PROFILE_DEFINITION_INVALID');
  return resolveHistoricalFz3bProfile((value as HistoricalFz3bProfile).profileSha256);
}

export function historicalFz3bProfileDefinitions(): readonly HistoricalFz3bProfile[] {
  return Object.freeze([...HISTORICAL_PROFILES.values()]);
}
