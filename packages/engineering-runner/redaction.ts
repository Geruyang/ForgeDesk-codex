export function redact(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|private[_-]?key|authorization)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, '$1"[REDACTED]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function boundedLog(value: string, limit = 256 * 1024): string {
  const cleaned = Buffer.from(redact(value), 'utf8');
  if (cleaned.length <= limit) return cleaned.toString('utf8');
  const marker = '\n[OUTPUT TRUNCATED AT 256 KiB]\n';
  return cleaned.subarray(0, Math.max(0, limit - Buffer.byteLength(marker) - 3)).toString('utf8') + marker;
}

export const EVIDENCE_LIMITATION = 'A-level workspace fingerprint: changes to model-writable inputs are detected, but this is not tamper protection or frozen input. Matching before/after hashes cannot detect edits restored during execution.';
export function containmentLimitation(processHost?: string): string {
  return EVIDENCE_LIMITATION + (process.platform === 'win32' && processHost
    ? ' Windows child execution uses a native kill-on-close Job Object supervisor.'
    : ' Native Windows Job Object containment is not configured; Windows fallback uses taskkill process-tree cleanup.');
}
