import { createConnection } from "node:net";
import { probeStatusOnSocket, type Fz3bStatusObservation } from "./internal.js";

const HOST = "169.254.220.254";
const PORT = 8765;

export type { Fz3bStatusObservation };

export function probeFz3bClaimedStatus(
  acknowledgement: { acknowledgeControlDisconnectEffect: true },
): Promise<Fz3bStatusObservation> {
  if (acknowledgement?.acknowledgeControlDisconnectEffect !== true) {
    throw new Error("FZ3B control disconnect effect must be acknowledged");
  }
  return probeStatusOnSocket(createConnection({ host: HOST, port: PORT }));
}
