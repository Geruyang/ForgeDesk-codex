export type Fz3bAvailabilityStatus = 'available' | 'missing-key' | 'invalid-key' |
  'invalid-resources' | 'unsupported-host' | 'missing-ssh';

export interface Fz3bAvailability {
  available: boolean;
  status: Fz3bAvailabilityStatus;
  resourcesVerified: boolean;
  reason?: string;
}
