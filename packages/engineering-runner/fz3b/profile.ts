import { createHash } from 'node:crypto';
import type { Fz3bIdentity, Fz3bSemanticFixture } from './types.js';

export const FZ3B_PROFILE = Object.freeze({
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
export const fz3bDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const fz3bCanonicalJson = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
function deepFreeze(value: object) { for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child); Object.freeze(value); }
deepFreeze(FZ3B_PROFILE);
export const FZ3B_HOST_KEY_SHA256 = createHash('sha256').update(Buffer.from(FZ3B_PROFILE.hostPublicKey.split(' ')[1], 'base64')).digest('hex');
export function validateFz3bFixture(fixture: Fz3bSemanticFixture): void {
  if (!fixture || Object.keys(fixture).sort().join(',') !== ['id', 'manifestSha256', 'queriesSha256', 'imageSha256', 'predeclaredSha256', 'width', 'height', 'queryCount', 'embeddingDimensions', 'expectedLabel', 'queryIds', 'encoderIdentity'].sort().join(',') ||
      fixture.id !== 'fz3b-pillow-scene-v1' || fixture.width !== 914 || fixture.height !== 512 || fixture.queryCount !== 4 || fixture.embeddingDimensions !== 512 || fixture.expectedLabel !== 'pillow' ||
      fixture.imageSha256 !== FZ3B_PROFILE.imageSha256 || fixture.predeclaredSha256 !== FZ3B_PROFILE.predeclaredSha256 ||
      fixture.manifestSha256 !== FZ3B_PROFILE.semanticManifestSha256 || fixture.queriesSha256 !== FZ3B_PROFILE.queriesSha256 ||
      JSON.stringify(fixture.queryIds) !== JSON.stringify(['pillow', 'cup', 'mobile-phone', 'bottle']) ||
      fz3bCanonicalJson(fixture.encoderIdentity) !== fz3bCanonicalJson(FZ3B_PROFILE.encoderIdentity) ||
      ![fixture.manifestSha256, fixture.queriesSha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) throw new Error('FZ3B_FIXED_FIXTURE_MISMATCH');
}
export function fz3bProfileSha256(fixture: Fz3bSemanticFixture): string {
  validateFz3bFixture(fixture);
  return fz3bDigest(fz3bCanonicalJson({ profile: FZ3B_PROFILE, fixture }));
}
export function validateFz3bIdentity(identity: Fz3bIdentity): void {
  if (!identity || Object.keys(identity).sort().join(',') !== ['hostKeySha256', 'bootId', 'appRoot', 'platform', 'contractId', 'deployedManifestSha256', 'existingPlSha256', 'transport', 'helloAuthenticated'].sort().join(',') ||
      identity.hostKeySha256 !== FZ3B_HOST_KEY_SHA256 || identity.bootId !== FZ3B_PROFILE.bootId || identity.appRoot !== FZ3B_PROFILE.appRoot ||
      identity.platform !== 'A0005' || identity.contractId !== FZ3B_PROFILE.encoderIdentity.contractId || identity.deployedManifestSha256 !== FZ3B_PROFILE.deployedManifestSha256 ||
      identity.existingPlSha256 !== FZ3B_PROFILE.existingPlSha256 || identity.transport !== 'pinned-ssh' || identity.helloAuthenticated !== false) throw new Error('FZ3B_FIXED_IDENTITY_MISMATCH');
}
