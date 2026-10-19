import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureAudit } from './ssh_hardening_audit.mjs';
import { knownHostLine, projectRoot, sshArgs } from './fetch_known_good_pl.mjs';

const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_hardening_structure.py');
export const sourceSha256 = '8c6a084b455dc7c6fee7ef5f0980bd32d9f8db874b90c00372a3d0b9647ae10b';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const CONFIG_SHA = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216';

function regularFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('local-file-not-regular');
}

export function validateStructure(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 32 * 1024) throw new Error('structure-output-limit');
  let report;
  try { report = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('invalid-structure-json'); }
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      report.schemaVersion !== 1 || report.scope !== 'fz3b-sshd-config-structure-readonly' ||
      report.readOnly !== true || report.configurationChanged !== false ||
      report.configSha256 !== CONFIG_SHA || report.configBytes !== 3248 ||
      report.sessionContextMatches !== true ||
      report.contentOmittedExceptMatchAndAuthValues !== true ||
      !Number.isInteger(report.matchCount) || report.matchCount < 0 ||
      report.includeCount !== 0 || !Array.isArray(report.directives) ||
      report.directives.length > 128) throw new Error('invalid-structure-envelope');
  for (const entry of report.directives) {
    if (!entry || !Number.isInteger(entry.line) || entry.line < 1 || entry.line > 256 ||
        typeof entry.key !== 'string' || !/^[a-z][a-z0-9]*$/.test(entry.key) ||
        typeof entry.valueSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.valueSha256) ||
        (entry.matchCriteria !== undefined && entry.key !== 'match') ||
        (entry.authValue !== undefined && ![
          'pubkeyauthentication', 'passwordauthentication', 'challengeresponseauthentication',
          'kbdinteractiveauthentication', 'permitrootlogin', 'authenticationmethods',
          'authorizedkeysfile', 'usepam', 'permitemptypasswords'].includes(entry.key)))
      throw new Error('invalid-structure-entry');
  }
  if (report.directives.filter(entry => entry.key === 'match').length !== report.matchCount)
    throw new Error('match-count-mismatch');
  return report;
}

function evidenceParent() {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening', 'config-structure']) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== path.resolve(current))
      throw new Error('evidence-parent-not-real-directory');
  }
  return current;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('no-arguments-accepted');
  const privateRoot = path.join(projectRoot, '.runtime/fz3b-private');
  const known = path.join(privateRoot, 'known_hosts');
  const key = path.join(privateRoot, 'fz3b_acceptance_ed25519');
  for (const file of [known, key, sourcePath]) regularFile(file);
  if (fs.readFileSync(known, 'utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  const source = fs.readFileSync(sourcePath);
  if (source.length > 16384 || sha256(source) !== sourceSha256) throw new Error('source-hash-mismatch');
  const raw = await captureAudit(source, sshArgs(known, key));
  if (sha256(fs.readFileSync(sourcePath)) !== sourceSha256) throw new Error('source-changed');
  const report = validateStructure(raw);
  const parent = evidenceParent();
  const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
  const directory = path.join(parent, name);
  fs.mkdirSync(directory);
  const evidence = { schemaVersion: 1, scope: 'fz3b-sshd-config-structure-receipt',
    collectedAt: new Date().toISOString(), sourceSha256, authentication: 'project-public-key',
    hostTrust: 'pinned-ed25519-continuity', readOnly: true, configurationChanged: false, report };
  const fd = fs.openSync(path.join(directory, 'structure.json'), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(evidence, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  console.log(JSON.stringify({ directory, matchCount: report.matchCount,
    includeCount: report.includeCount, readOnly: true }));
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`SSH structure audit failed: ${error.message}`); process.exitCode = 1; });
}
