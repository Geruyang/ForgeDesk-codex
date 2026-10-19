import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { commandEnvironment } from '../environment.js';
import { durableJson } from '../embedded/files.js';
import { fz3bDigest } from './profile.js';
import { fixedFz3bSshArgs } from './worker.js';
import { fz3bSshEnvironment } from './ssh-environment.js';

test('dedicated SSH environment requires an absolute host ProgramData and does not inherit agent, home or proxy', () => {
  assert.throws(() => fz3bSshEnvironment({}), /PROGRAMDATA_REQUIRED/);
  assert.throws(() => fz3bSshEnvironment({ ProgramData: 'relative' }), /PROGRAMDATA_REQUIRED/);
  const environment = fz3bSshEnvironment({ ProgramData: path.resolve('output'), HOME: 'untrusted', SSH_AUTH_SOCK: 'untrusted', HTTPS_PROXY: 'untrusted' });
  assert.equal(environment.ProgramData, path.resolve('output'));
  for (const name of ['HOME', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'USERPROFILE']) assert.equal(environment[name], undefined);
});

test('real local Windows OpenSSH -G preserves pinned policy and known_hosts paths with and without spaces', { skip: process.platform !== 'win32' }, async () => {
  const base = path.resolve('output/hardware/2026-10-16-next/product/ssh-environment-tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  try {
    const ssh = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/OpenSSH/ssh.exe');
    const host = path.resolve('vendor/process-host/process-host.exe');
    const key = path.join(directory, 'offline-placeholder-key'); await writeFile(key, 'offline test placeholder, not a key');
    const observations = [];
    for (const name of ['plain/known_hosts', 'with spaces/known_hosts']) {
      const knownHosts = path.join(directory, name); await mkdir(path.dirname(knownHosts)); await writeFile(knownHosts, '');
      const args = ['-G', ...fixedFz3bSshArgs(key, knownHosts)];
      const baseline = spawnSync(ssh, args, { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, env: commandEnvironment() });
      for (const viaHost of [false, true]) {
        const result = spawnSync(viaHost ? host : ssh, viaHost ? ['--', ssh, ...args] : args,
          { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, env: fz3bSshEnvironment() });
        assert.equal(result.error, undefined); assert.equal(result.status, 0);
        const config = new Map(result.stdout.trim().split(/\r?\n/).map(line => { const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)]; }));
        assert.equal(config.get('userknownhostsfile'), knownHosts);
        assert.equal(config.get('identityfile'), key);
        for (const [field, expected] of [['hostname', '169.254.220.254'], ['user', 'root'], ['stricthostkeychecking', 'true'],
          ['identitiesonly', 'yes'], ['identityagent', 'none'], ['passwordauthentication', 'no'], ['kbdinteractiveauthentication', 'no'],
          ['forwardagent', 'no'], ['clearallforwardings', 'yes'], ['permitlocalcommand', 'no'], ['hostkeyalgorithms', 'ssh-ed25519'],
          ['globalknownhostsfile', 'NUL']]) assert.equal(config.get(field), expected, field);
        observations.push({ knownHostsHasSpaces: name.includes(' '), viaProcessHost: viaHost, baselineExit: baseline.status,
          baselineStdoutBytes: Buffer.byteLength(baseline.stdout ?? ''), baselineStderrBytes: Buffer.byteLength(baseline.stderr ?? ''),
          correctedExit: result.status, correctedStdoutBytes: Buffer.byteLength(result.stdout), pinnedPolicyVerified: true });
      }
    }
    await durableJson(path.resolve('output/hardware/2026-10-16-next/product/SSH_ENVIRONMENT_LOCAL_EVIDENCE.json'), {
      schemaVersion: 1, scope: 'local OpenSSH -G config parsing only; no connection, key authentication or remote execution',
      observedAt: new Date().toISOString(), sshExecutableSha256: fz3bDigest(await readFile(ssh)), observations,
      realPrivateKeyRead: false, networkConnectionRequested: false,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
