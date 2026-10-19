import { DEVICE_SCHEMA_VERSION, deviceKey, type AuthorizationLookup, type FlashRequest } from "./types.js";

export async function requireDeviceAuthorization(
  lookup: AuthorizationLookup,
  request: FlashRequest,
  now = new Date(),
): Promise<void> {
  const grant = await lookup.get(request.authorizationId);
  if (!grant || grant.schemaVersion !== DEVICE_SCHEMA_VERSION || grant.approvedBy !== "user") {
    throw new Error("Device authorization is missing or invalid");
  }
  const expected = {
    taskId: request.taskId,
    artifactSha256: request.artifactSha256.toLowerCase(),
    deviceKey: deviceKey(request.identity),
    chipTarget: request.identity.chipTarget,
    profileId: request.profile.id,
    profileRevision: request.profile.revision,
    acceptanceDigest: request.acceptanceDigest.toLowerCase(),
    policyVersion: request.policyVersion,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (String(grant[field as keyof typeof grant]).toLowerCase() !== value.toLowerCase()) {
      throw new Error(`Device authorization scope mismatch: ${field}`);
    }
  }
  const expiry = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw new Error("Device authorization expired");
  }
}
