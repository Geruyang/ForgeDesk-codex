import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, lstat, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor/hardware');
const destination = path.join(vendor, 'python');
const tooling = path.join(root, 'output/hardware/tooling');
const manifestPath = path.join(vendor, 'manifest.json');
const pythonVersion = '3.13.16';
const archiveName = `python-${pythonVersion}-embed-amd64.zip`;
const archiveUrl = `https://www.python.org/ftp/python/${pythonVersion}/${archiveName}`;
const archiveSha256 = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297';
const serialLicenseUrl = 'https://raw.githubusercontent.com/pyserial/pyserial/v3.5/LICENSE.txt';
const serialLicenseSha256 = 'f91cb9813de6a5b142b8f7f2dede630b5134160aedaeaf55f4d6a7e2593ca3f3';
const pth = 'python313.zip\n.\nLib/site-packages\n';
const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sha = data => createHash('sha256').update(data).digest('hex');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const relative = value => path.relative(vendor, value).split(path.sep).join('/');
const consoleNames = new Set(['bin2hex.py', 'cffi-gen-src.exe', 'hex2bin.py', 'hex2dump.py', 'hexdiff.py', 'hexinfo.py', 'hexmerge.py', 'natsort.exe', 'pack-manager.exe', 'pylink-rtt', 'pylink-swv', 'pylink.exe', 'pyocd-gdbserver.exe', 'pyocd.exe', 'pyserial-miniterm.exe', 'pyserial-ports.exe', 'readelf.py']);
const consoleDirectories = ['Lib/site-packages/bin', 'Lib/site-packages/Scripts', 'bin', 'Scripts'];

function run(executable, args, { timeout = 180_000, cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) child.kill(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) reject(new Error(`Tool failed (${path.basename(executable)}, code=${code}, signal=${signal}, timeout=${timedOut}): ${stderr.slice(-6000)}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(directory, entry.name); const name = `${prefix}${entry.name}`;
    const stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink(), `Runtime links are forbidden: ${name}`);
    if (stat.isDirectory()) result.push(...await files(file, `${name}/`));
    else { assert.ok(stat.isFile()); result.push({ path: `python/${name}`, bytes: stat.size, sha256: sha(await readFile(file)) }); }
  }
  return result;
}

async function removeConsoleLaunchers(runtime) {
  const base = path.resolve(runtime);
  assert.ok(base.startsWith(root + path.sep), 'Runtime cleanup must stay inside this project');
  const removals = [];
  for (const directory of consoleDirectories) {
    const target = path.resolve(base, directory);
    assert.ok(target.startsWith(base + path.sep), 'Console launcher directory escaped runtime');
    let entries;
    try {
      const directoryStat = await lstat(target);
      assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'Console launcher directory must not be a link');
      entries = await readdir(target, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) assert.ok(entry.isFile() && consoleNames.has(entry.name), `Unrecognized console file; no cleanup authorized: ${entry.name}`);
    for (const entry of entries) {
      const file = path.join(target, entry.name);
      await unlink(file);
      removals.push(`python/${path.relative(base, file).split(path.sep).join('/')}`);
    }
    await rmdir(target);
  }
  return removals.sort();
}

const pureCode = `import importlib.metadata as m, json, pathlib, sys
import pyocd, serial, hid, usb, libusb_package, cmsis_pack_manager
from pyocd.core.session import Session
base=pathlib.Path(sys.executable).resolve().parent
assert sys.version_info[:3] == (3,13,16)
assert sys.flags.isolated == 1 and sys.flags.no_user_site == 1 and sys.flags.no_site == 1
assert all(pathlib.Path(p).resolve().is_relative_to(base) for p in sys.path)
assert m.version('pyocd') == '0.44.1' and m.version('pyserial') == '3.5'
plugins=[{'group':e.group,'name':e.name,'value':e.value} for e in m.distribution('pyocd').entry_points]
assert any(e['group']=='pyocd.probe' for e in plugins)
assert all(pathlib.Path(mod.__file__).resolve().is_relative_to(base) for mod in (pyocd,serial,hid,usb,libusb_package,cmsis_pack_manager))
print(json.dumps({'python':sys.version.split()[0],'pyocd':m.version('pyocd'),'pyserial':m.version('pyserial'),'isolated':bool(sys.flags.isolated),'userSiteDisabled':bool(sys.flags.no_user_site),'siteImportDisabled':bool(sys.flags.no_site),'pathsWithinRuntime':True,'modules':['pyocd','serial','hid','usb','libusb_package','cmsis_pack_manager','pyocd.core.session'],'plugins':plugins,'deviceEnumeration':False,'serialOpened':False}))
`;

async function pureCheck(directory) {
  const result = await run(path.join(directory, 'python.exe'), ['-I', '-B', '-c', pureCode], { cwd: tooling, timeout: 30_000 });
  return JSON.parse(result.stdout.trim());
}

async function verify() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runtime.executable, 'python/python.exe');
  assert.equal(manifest.pythonArchive.sha256, archiveSha256);
  assert.deepEqual(await files(destination), manifest.files, 'Runtime file set, sizes and hashes must match exactly');
  assert.ok(!manifest.files.some(item => consoleDirectories.some(directory => item.path.startsWith(`python/${directory}/`))), 'pip console launchers must not be packaged');
  assert.equal(await readFile(path.join(destination, 'python313._pth'), 'utf8'), pth);
  const check = await pureCheck(destination);
  await writeFile(path.join(tooling, 'verify.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), manifestSha256: sha(await readFile(manifestPath)), fileCount: manifest.files.length, ...check }, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'verified', executable: relative(path.join(destination, 'python.exe')), fileCount: manifest.files.length, ...check }));
}

async function prepare(bootstrapPython) {
  await assert.rejects(lstat(destination), { code: 'ENOENT' }, 'Refusing to overwrite an existing runtime; use --verify');
  const archive = path.join(tooling, archiveName);
  let archiveData;
  try { archiveData = await readFile(archive); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
    assert.ok(response.ok, `Python archive download failed: ${response.status}`);
    archiveData = Buffer.from(await response.arrayBuffer());
    assert.ok(archiveData.length < 32 * 1024 * 1024, 'Unexpected Python archive size');
    assert.equal(sha(archiveData), archiveSha256, 'Official Python archive SHA-256 mismatch');
    await writeFile(archive, archiveData);
  }
  assert.equal(sha(archiveData), archiveSha256, 'Cached Python archive SHA-256 mismatch');
  const staging = path.join(tooling, `python-staging-${randomUUID()}`);
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)},${quote(staging)})`]);
  await writeFile(path.join(staging, 'python313._pth'), pth);
  const target = path.join(staging, 'Lib/site-packages');
  const reportPath = path.join(tooling, 'pip-report.json');
  let locked;
  try { locked = JSON.parse(await readFile(manifestPath, 'utf8')).dependencies; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const input = path.join(tooling, 'requirements-input.lock');
  const requirements = locked?.length ? locked.map(item => `${item.name}==${item.version} --hash=sha256:${item.wheelSha256}`).join('\n') + '\n' : 'pyocd==0.44.1\npyserial==3.5\n';
  await writeFile(input, requirements);
  const install = await run(bootstrapPython, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--index-url', 'https://pypi.org/simple', '--target', target, '--python-version', '3.13', '--platform', 'win_amd64', '--implementation', 'cp', '--abi', 'cp313', '--only-binary=:all:', '--no-cache-dir', '--no-compile', '--ignore-installed', '--report', reportPath, ...(locked?.length ? ['--require-hashes'] : []), '-r', input]);
  await writeFile(path.join(tooling, 'pip-install.log'), install.stdout + install.stderr);
  // Console launchers embed the bootstrap interpreter path. Workers use python.exe directly.
  const removedConsoleLaunchers = await removeConsoleLaunchers(staging);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const dependencies = report.install.map(item => {
    const url = new URL(item.download_info.url);
    assert.ok(url.protocol === 'https:' && url.hostname === 'files.pythonhosted.org' && url.pathname.endsWith('.whl'));
    const hash = item.download_info.archive_info.hashes.sha256;
    assert.match(hash, /^[a-f0-9]{64}$/);
    return { name: item.metadata.name, version: item.metadata.version, wheelUrl: url.toString(), wheelSha256: hash };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  assert.equal(dependencies.find(item => item.name.toLowerCase() === 'pyocd')?.version, '0.44.1');
  assert.equal(dependencies.find(item => item.name.toLowerCase() === 'pyserial')?.version, '3.5');
  await writeFile(path.join(staging, 'requirements.lock'), dependencies.map(item => `${item.name}==${item.version} --hash=sha256:${item.wheelSha256}`).join('\n') + '\n');
  const licenseResponse = await fetch(serialLicenseUrl, { signal: AbortSignal.timeout(30_000) });
  assert.ok(licenseResponse.ok, `pySerial license download failed: ${licenseResponse.status}`);
  const serialLicense = Buffer.from(await licenseResponse.arrayBuffer());
  assert.equal(sha(serialLicense), serialLicenseSha256, 'pySerial upstream license SHA-256 mismatch');
  await writeFile(path.join(tooling, 'pyserial-3.5-LICENSE.txt'), serialLicense);
  const licenseDirectory = path.join(staging, 'third-party-licenses/pyserial-3.5');
  await mkdir(licenseDirectory, { recursive: true });
  await writeFile(path.join(licenseDirectory, 'LICENSE.txt'), serialLicense);
  const signature = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath ${quote(path.join(staging, 'python.exe'))}; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;issuer=$s.SignerCertificate.Issuer;thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress`]);
  const authenticode = JSON.parse(signature.stdout.trim());
  assert.equal(authenticode.status, 'Valid', 'Python executable Authenticode must be valid');
  assert.match(authenticode.subject, /Python Software Foundation/);
  const check = await pureCheck(staging);
  const inventory = await files(staging);
  assert.ok(inventory.some(item => item.path === 'python/LICENSE.txt'), 'Python license must be retained');
  const licenses = inventory.filter(item => /(?:^|\/)(?:licen[cs]e[^/]*|copying[^/]*|notice[^/]*)$/i.test(item.path)).map(item => item.path);
  assert.ok(licenses.some(name => name.includes('.dist-info/')), 'Third-party distribution licenses must be retained');
  const manifest = { schemaVersion: 1, preparedAt: new Date().toISOString(), runtime: { implementation: 'CPython', version: pythonVersion, architecture: 'win_amd64', executable: 'python/python.exe', isolatedPth: pth.trim().split('\n'), importSite: false, userSite: false }, pythonArchive: { url: archiveUrl, sha256: archiveSha256, publishedSha256: archiveSha256, checksumSource: 'https://www.python.org/downloads/release/python-31316/' }, authenticode, supplyChain: { sigstoreVerified: false, packageIndex: 'https://pypi.org/simple', binaryWheelsOnly: true, consoleLaunchersRemoved: true, removedConsoleLaunchers, bootstrapPythonCopied: false }, dependencies, thirdPartyLicenseSources: [{ name: 'pyserial', version: '3.5', url: serialLicenseUrl, sha256: serialLicenseSha256, path: 'python/third-party-licenses/pyserial-3.5/LICENSE.txt', reason: 'Full license omitted from upstream wheel' }], licenses, pureCheck: check, files: inventory };
  await mkdir(vendor, { recursive: true });
  await rename(staging, destination);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await verify();
}

async function pruneConsoleLaunchers() {
  const original = await readFile(manifestPath);
  const manifest = JSON.parse(original);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runtime.executable, 'python/python.exe');
  assert.deepEqual(await files(destination), manifest.files, 'Refusing cleanup of a modified runtime');
  const removed = await removeConsoleLaunchers(destination);
  assert.ok(removed.length > 0, 'No known console launchers require cleanup');
  manifest.files = await files(destination);
  manifest.supplyChain.consoleLaunchersRemoved = true;
  manifest.supplyChain.removedConsoleLaunchers = removed;
  manifest.launcherCleanup = { performedAt: new Date().toISOString(), sourceManifestSha256: sha(original), removedCount: removed.length };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await verify();
}

assert.equal(process.platform, 'win32', 'This preparation target is Windows x64 only');
await mkdir(tooling, { recursive: true });
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--verify') await verify();
else if (args.length === 1 && args[0] === '--prune-console-launchers') await pruneConsoleLaunchers();
else if (args.length === 2 && args[0] === '--bootstrap-python' && path.isAbsolute(args[1])) await prepare(args[1]);
else throw new Error('Usage: node scripts/prepare-hardware-runtime.mjs --bootstrap-python <absolute existing pip Python> | --verify | --prune-console-launchers');
