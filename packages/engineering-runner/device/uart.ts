import { randomBytes } from "node:crypto";

export interface VerifyResponse {
  type: "forge.verify.response";
  nonce: string;
  buildId: string;
  result: unknown;
}

export class UartVerificationSession {
  readonly nonce = randomBytes(16).toString("hex");
  private requested = false;
  private complete = false;
  private bytes = 0;

  constructor(readonly buildId: string, readonly maxBytes = 4096) {
    if (!buildId || maxBytes < 1) throw new Error("Invalid UART verification session");
  }

  request(): string {
    if (this.requested) throw new Error("Verification request already sent");
    this.requested = true;
    return JSON.stringify({ type: "forge.verify.request", nonce: this.nonce, buildId: this.buildId }) + "\n";
  }

  parseLine(line: string): VerifyResponse {
    if (!this.requested) throw new Error("UART response arrived before this session request");
    if (this.complete) throw new Error("UART verification session is already complete");
    this.bytes += Buffer.byteLength(line, "utf8");
    if (this.bytes > this.maxBytes) throw new Error("UART response size limit exceeded");
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      throw new Error("Malformed UART response");
    }
    if (!response || typeof response !== "object") throw new Error("Malformed UART response");
    const candidate = response as Partial<VerifyResponse>;
    if (candidate.type !== "forge.verify.response" || candidate.nonce !== this.nonce || candidate.buildId !== this.buildId) {
      throw new Error("Stale or wrong UART response identity");
    }
    if (!("result" in candidate)) throw new Error("UART response has no result");
    this.complete = true;
    return candidate as VerifyResponse;
  }
}
