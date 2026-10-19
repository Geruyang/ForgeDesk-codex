import { fz3bDigest } from './profile.js';
import type { Fz3bResourceBundle } from './resources.js';
import type { Fz3bAdapterContext } from './types.js';

export const LEGACY_INSPECT_RESOURCE_SHA256 = '951b6ec48562e56b67b158c237b2f0317e3cd9f965db981e78d2a003c2675dfa';
const LEGACY_REMOTE_SHA256 = '7a675f09af5973e6fa69ad832a424df06ed7b9f04b45ed3ebd2b5c2851faf516';
const LEGACY_WIRE_SHA256 = '460bae822a42262c610541ef5e2b45423e588d3b43e749327a98aed8cc818710';

export function fixedFz3bPayload(resources: Fz3bResourceBundle, request: unknown): Buffer {
  const remote = resources.files.get('remote/remote.py')!;
  const wire = resources.files.get('remote/wire.py')!;
  return Buffer.from(`import base64,json\nexec(compile(base64.b64decode('${remote.toString('base64')}'),'forgedesk-pinned-remote.py','exec'))\nforgedesk_main(json.loads(base64.b64decode('${Buffer.from(JSON.stringify(request)).toString('base64')}').decode('utf-8')),base64.b64decode('${wire.toString('base64')}'))\n`);
}

export function legacyInspectPayload(resources: Fz3bResourceBundle, context: Readonly<Fz3bAdapterContext>): Buffer {
  if (fz3bDigest(resources.files.get('remote/remote.py')!) !== LEGACY_REMOTE_SHA256 ||
      fz3bDigest(resources.files.get('remote/wire.py')!) !== LEGACY_WIRE_SHA256) throw new Error('FZ3B_LEGACY_INSPECT_CODE_CHANGED');
  return fixedFz3bPayload(resources, { schemaVersion: 1, action: 'inspect', operationId: context.operationId,
    nonce: context.nonce, profileSha256: context.profileSha256 });
}
