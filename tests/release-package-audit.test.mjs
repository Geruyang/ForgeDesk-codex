import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { RESOURCE_SPECS, RUNTIME_FILES, BUILD_FILES, PACKAGED_FILES, DIST_FILES, STOCK_ELECTRON_FILES, STARTUP_HISTORY_RESOURCE, RELEASE_BLOCKERS, ASSET_APPROVAL, VERSION, APP_ID,
  CODEX_PACKAGED_MANIFEST_SHA256, CODEX_PACKAGED_MANIFEST_BYTES, deriveCodexManifest, validateCodexTransform,
  sha256, expectedResourceRows, assertInventory, validateConfiguration, validateEffectiveConfiguration, validateArchive,
  validateReleaseManifest, validateAssetApproval, compiledStartupHistoryBindings, validateStartupHistoryBinding, readArchiveInventory, beforePack, afterPack, afterSign, afterAllArtifactBuild } from '../scripts/release-package-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const h = '1'.repeat(64), row = p => ({ path: p, bytes: 1, sha256: h });
function manifestFixture() {
  const resources = [row('resources/app.asar'), ...RESOURCE_SPECS.map(s => row('resources/' + s.to + (s.single ? '' : '/manifest.json')))];
  const codex = resources.find(r => r.path === 'resources/codex/manifest.json'); codex.sha256 = CODEX_PACKAGED_MANIFEST_SHA256; codex.bytes = CODEX_PACKAGED_MANIFEST_BYTES;
  return { schema: 'forgedesk-release-package-audit-v1', version: VERSION, appId: APP_ID,
    sourceFreeze: { packageSha256: h, lockSha256: h, auditSourceSha256: h, buildSourceSha256: h, assetApproval: { ...ASSET_APPROVAL },
      resourceManifestPins: RESOURCE_SPECS.filter(s => s.manifest).map(s => ({ path: s.from + '/' + s.manifest, sha256: s.pin })),
      resourceTransforms: [{ path: 'resources/codex/manifest.json', method: 'codex-public-source-only-v1', sourceSha256: RESOURCE_SPECS[0].pin, packagedSha256: CODEX_PACKAGED_MANIFEST_SHA256 }] },
    artifacts: [row('release/ForgeDesk-1.0.0-x64-setup.exe')], unpacked: { path: 'release/win-unpacked', files: [...RUNTIME_FILES.map(row), ...resources] },
    resources, bundles: PACKAGED_FILES.filter(p => p !== 'package.json').map(row),
    qualification: { packageInventoryVerified: true, installationVerified: false, softwareAccepted: false, deviceQualified: false, releaseAuthorized: false } };
}

test('1.0 package and lock keep version, identity and all mandatory audit hooks', () => {
  assert.equal(validateConfiguration(packageJson, lock), true);
  assert.equal(packageJson.version, '1.0.0'); assert.ok(!BUILD_FILES.some(p => p.endsWith('.map')));
  for (const hook of ['beforePack', 'afterPack', 'afterSign', 'afterAllArtifactBuild']) {
    const changed = structuredClone(packageJson); delete changed.build[hook]; assert.throws(() => validateConfiguration(changed, lock), /HOOK/);
  }
  const normalized = { ...structuredClone(packageJson.build), files: [{ filter: [...BUILD_FILES] }] };
  assert.equal(validateEffectiveConfiguration(normalized, packageJson), true);
  for (const change of [c => c.extraResources.push({ from: 'private', to: 'private' }), c => c.win.files = ['**/*'],
    c => c.files[0].filter.push('**/*'), c => c.extraMetadata = { credential: 'fixture' }, c => c.electronDist = '/ambient/runtime', c => c.win.signAndEditExecutable = false]) {
    const changed = structuredClone(normalized); change(changed); assert.throws(() => validateEffectiveConfiguration(changed, packageJson));
  }
});

test('broad resource, extraFiles, source-map and privilege-expanding config reject', () => {
  for (const change of [p => p.build.files.push('**/*'), p => p.build.extraResources.push({ from: 'output', to: 'runtime' }),
    p => p.build.extraFiles = ['private'], p => p.build.asar = false, p => p.build.nsis.perMachine = true,
    p => p.build.nsis.deleteAppDataOnUninstall = true, p => p.build.nsis.packElevateHelper = true, p => p.build.nsis.runAfterFinish = true, p => p.build.nsis.allowElevation = true,
    p => p.build.win.signAndEditExecutable = false]) {
    const changed = structuredClone(packageJson); change(changed); assert.throws(() => validateConfiguration(changed, lock));
  }
});

test('actual builder production-module collector needs and honors the explicit node_modules exclusion', () => {
  const { getNodeModuleFileMatcher, FileMatcher } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js');
  const app = path.join(root, 'fixture-app'), destination = path.join(root, 'fixture-out');
  for (const normalized of [false, true]) {
    const matcher = files => getNodeModuleFileMatcher(app, destination, s => s, {},
      { config: { files: normalized ? [{ filter: files }] : files }, debugLogger: { isEnabled: false } });
    const positiveOnly = matcher(BUILD_FILES.filter(p => !p.startsWith('!')));
    // An empty module matcher makes the real copy helper use no filter (include all).
    assert.ok(positiveOnly.isEmpty() || positiveOnly.patterns.includes('**/*'));
    const actual = matcher([...BUILD_FILES]); assert.ok(!actual.isEmpty());
    const depFilter = new FileMatcher(path.join(app, 'node_modules/react'), destination, s => s, actual.patterns).createFilter();
    const control = positiveOnly.isEmpty() ? () => true : new FileMatcher(path.join(app, 'node_modules/react'), destination, s => s, positiveOnly.patterns).createFilter();
    for (const moduleFullFilePath of ['node_modules/react/index.js', 'node_modules/@scope/pkg/index.js',
      'node_modules/react/node_modules/scheduler/index.js', 'node_modules/pkg/.private/auth.json']) {
      const filename = path.join(app, moduleFullFilePath), stat = { isDirectory: () => false, moduleFullFilePath };
      assert.equal(control(filename, stat), true); assert.equal(depFilter(filename, stat), false);
    }
  }
});

test('the generated startup worker is external and bound to unique actual native verify call arguments', async () => {
  assert.ok(DIST_FILES.includes('main/release-recovery-history-worker.cjs'));
  assert.ok(!PACKAGED_FILES.includes(STARTUP_HISTORY_RESOURCE.from));
  assert.deepEqual(packageJson.build.extraResources.at(-1), { from: STARTUP_HISTORY_RESOURCE.from, to: STARTUP_HISTORY_RESOURCE.to });
  assert.throws(() => expectedResourceRows(STARTUP_HISTORY_RESOURCE), /GENERATED_RESOURCE_CAPTURE_REQUIRED/);
  const worker = { ...row('resources/' + STARTUP_HISTORY_RESOURCE.to), sha256: '2'.repeat(64) };
  const host = row('resources/process-host/process-host.exe'), ts = createRequire(import.meta.url)('typescript');
  const compiled = body => `async function pinned(file, expected, limit) {}\nvar nativePorts={async verify(worker,host){${body}}};\nfunction createNativeStartupHistoryOwner(options,ports=nativePorts){}`;
  const bindings = text => compiledStartupHistoryBindings(Buffer.from(text), ts);
  const correct = `await pinned(worker, "${worker.sha256}", 16777216); await pinned(host, "${h}", 2097152);`;
  assert.equal(validateStartupHistoryBinding(bindings(compiled(correct)), worker, host), true);
  for (const text of [compiled(`// "${worker.sha256}"\n await pinned(host, "${h}", 2097152);`),
    compiled(`const unused="${worker.sha256}",unusedHost="${h}"; await pinned(worker,"${'3'.repeat(64)}",16777216); await pinned(host,"${'4'.repeat(64)}",2097152);`),
    compiled(correct + `await pinned(worker,"${'3'.repeat(64)}",16777216);`),
    compiled(`await pinned(worker, "prefix${worker.sha256}", 16777216); await pinned(host, "${h}", 2097152);`),
    compiled(correct).replace('ports=nativePorts', 'ports=foreignPorts')]) {
    assert.throws(() => validateStartupHistoryBinding(bindings(text), worker, host), /COMPILED/);
  }
  assert.throws(() => validateStartupHistoryBinding({ worker: worker.sha256, host: h }, { ...worker, path: worker.path + '.other' }, host));
  assert.throws(() => validateStartupHistoryBinding({ worker: worker.sha256, host: h }, worker, { ...host, sha256: '4'.repeat(64) }));
  const receipt = manifestFixture();
  for (const invalid of [worker.path + '.map', 'resources/startup-history/other.cjs', 'resources/startup-history/node_modules/pkg/index.js']) {
    const changed = structuredClone(receipt); changed.resources.push(row(invalid)); changed.unpacked.files.push(row(invalid));
    assert.throws(() => validateReleaseManifest(changed), /UNLISTED_RESOURCE/);
  }
  const oversized = structuredClone(receipt); oversized.resources.find(r => r.path === worker.path).bytes = 16777217;
  assert.throws(() => validateReleaseManifest(oversized), /GENERATED_BOUND/);
  // In-memory compiler compatibility only: no prepare helpers, dist writes or target execution.
  const { build } = await import('esbuild');
  const workerOutput = await build({ entryPoints: ['apps/desktop/main/release-recovery-history-worker-entry.ts'],
    outfile: 'dist/main/release-recovery-history-worker.cjs', bundle: true, platform: 'node', format: 'cjs', write: false });
  const workerRaw = Buffer.from(workerOutput.outputFiles[0].contents), generated = { ...worker, bytes: workerRaw.length, sha256: sha256(workerRaw) };
  const mainOutput = await build({ entryPoints: ['apps/desktop/main/index.ts'], outfile: 'dist/main/index.cjs',
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true, write: false,
    define: { __FORGEDESK_STARTUP_HISTORY_WORKER_SHA256__: JSON.stringify(generated.sha256), __FORGEDESK_STARTUP_HISTORY_HOST_SHA256__: JSON.stringify(host.sha256) } });
  const mainRaw = Buffer.from(mainOutput.outputFiles.find(f => f.path.endsWith('index.cjs')).contents);
  assert.equal(validateStartupHistoryBinding(compiledStartupHistoryBindings(mainRaw, ts), generated, host), true);
});

test('manifest bytes are pinned before JSON can supply an allowlist', () => {
  const raw = Buffer.from(JSON.stringify({ files: [{ path: 'python/known.py', bytes: 1, sha256: h }] }));
  const spec = { manifest: 'manifest.json', kind: 'files', pin: sha256(raw) };
  assert.deepEqual(expectedResourceRows(spec, raw).map(r => r.path), ['manifest.json', 'python/known.py']);
  assert.throws(() => expectedResourceRows(spec, Buffer.concat([raw, Buffer.from(' ')])), /RESOURCE_PIN/);
  for (const unsafe of ['../private-key', '/auth.json', 'runtime\\auth.json', 'C:/secret', 'a/../key', 'a//key']) {
    const bytes = Buffer.from(JSON.stringify({ files: [{ path: unsafe, bytes: 1, sha256: h }] }));
    assert.throws(() => expectedResourceRows({ ...spec, pin: sha256(bytes) }, bytes), /PATH/);
  }
});

test('BOM process manifest and the distinct helper schemas remain supported, not silently removed', () => {
  for (const [kind, data, expected] of [
    ['process', { file: 'process-host.exe', sha256: h }, 'process-host.exe'],
    ['intent', { executableSha256: h }, 'FailedEmptyIntentHelper.exe'],
    ['codex', { files: [{ name: 'codex.exe', size: 1, sha256: h.toUpperCase() }] }, 'codex.exe'],
  ]) {
    const raw = Buffer.from('\uFEFF' + JSON.stringify(data));
    assert.ok(expectedResourceRows({ kind, manifest: 'manifest.json', pin: sha256(raw) }, raw).some(r => r.path === expected));
  }
});

test('unexpected credentials, logs, runtime data and private licenses are rejected as unlisted', () => {
  const expected = [row('known.py')]; assert.deepEqual(assertInventory(expected, expected), expected);
  for (const filename of ['auth.json', 'credentials.json', 'runtime/state.json', 'logs/history.jsonl', 'licenses/private-license.key']) {
    assert.throws(() => assertInventory(expected, [row(filename)]), /UNLISTED/);
  }
  assert.deepEqual(assertInventory([row('yaml/tokens.py')], [row('yaml/tokens.py')]), [row('yaml/tokens.py')], 'Known parser source is not a secret by keyword');
});

test('missing, duplicate, case-collision, changed, linked and unpacked files are fail closed', () => {
  const expected = [row('a.py'), row('b.py')];
  for (const actual of [[], [row('a.py'), row('a.py')], [row('a.py'), row('A.py')], [row('a.py'), { ...row('b.py'), sha256: '2'.repeat(64) }],
    [row('a.py'), { ...row('b.py'), kind: 'link' }], [row('a.py'), { ...row('b.py'), unpacked: true }]]) assert.throws(() => assertInventory(expected, actual));
});

test('ASAR exact bytes and closed metadata do not accept source maps, node modules or extra fields', () => {
  const snapshot = { bundles: [row('dist/main/index.cjs')], metadata: { name: 'fixture', version: VERSION } };
  const entries = [...snapshot.bundles, row('package.json')]; validateArchive(snapshot, entries, snapshot.metadata);
  for (const p of ['dist/main/index.cjs.map', 'node_modules/react/index.js', 'auth.json']) assert.throws(() => validateArchive(snapshot, [...entries, row(p)], snapshot.metadata));
  assert.throws(() => validateArchive(snapshot, entries, { ...snapshot.metadata, secret: 'fixture-secret' }), /METADATA/);
  assert.throws(() => validateArchive(snapshot, [{ ...entries[0], sha256: '2'.repeat(64) }, entries[1]], snapshot.metadata), /FILE_PIN/);
});

test('actual ASAR API uses host-native separators while all13 inventory paths and hashes stay canonical', async t => {
  const asar = createRequire(import.meta.url)('@electron/asar');
  const parent = path.join(root, 'output/release-1.0/asar-path-fixtures'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-')), source = path.join(directory, 'source'), archive = path.join(directory, 'fixture.asar');
  t.after(() => {
    asar.uncache(archive);
    assert.ok(path.resolve(directory).startsWith(path.resolve(parent) + path.sep));
    assert.ok(!fs.lstatSync(directory).isSymbolicLink()); fs.rmSync(directory, { recursive: true });
  });
  const metadata = { name: 'fixture', version: VERSION }, bundles = [];
  for (const p of PACKAGED_FILES) {
    const raw = Buffer.from(p === 'package.json' ? JSON.stringify(metadata) : 'fixture:' + p);
    const filename = path.join(source, p); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, raw, { flag: 'wx' });
    if (p !== 'package.json') bundles.push({ path: p, bytes: raw.length, sha256: sha256(raw) });
  }
  await asar.createPackage(source, archive);
  if (path.sep === '\\') assert.throws(() => asar.statFile(archive, 'dist/licenses/GestureScreen.txt', false), /not found/);
  const captured = readArchiveInventory(archive, asar);
  assert.equal(captured.entries.length, 13); assert.deepEqual(captured.metadata, metadata);
  assert.deepEqual(validateArchive({ bundles, metadata }, captured.entries, captured.metadata).map(r => r.path), [...PACKAGED_FILES].sort((a,b) => a.localeCompare(b,'en')));
  for (const kind of ['link', 'unpacked']) {
    const fake = { uncache() {}, listPackage: () => ['\\dist\\main\\index.cjs'], statFile: () => ({ [kind]: true }) };
    assert.throws(() => readArchiveInventory(archive, fake), /LINK_OR_UNPACKED/);
  }
  const extra = { uncache() {}, listPackage: () => ['\\node_modules\\private\\auth.json'], statFile: () => ({ size: 1 }) };
  assert.throws(() => readArchiveInventory(archive, extra), /UNLISTED/);
  const changed = captured.entries.map(r => r.path === 'dist/main/index.cjs' ? { ...r, sha256: '0'.repeat(64) } : r);
  assert.throws(() => validateArchive({ bundles, metadata }, changed, metadata), /FILE_PIN/);
});

test('only the two source-pinned Electron stock files can be removed, after whole-tree validation', () => {
  const ts = createRequire(import.meta.url)('typescript'), createHash = createRequire(import.meta.url)('node:crypto').createHash;
  const parsed = ts.createSourceFile('audit.mjs', fs.readFileSync(new URL('../scripts/release-package-audit.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const definition = name => { const n = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(n); return n.getText(parsed); };
  const parent = path.join(root, 'output/release-1.0/asar-path-fixtures'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'stocks-'));
  try {
    for (const mode of ['normal', 'hash', 'identity', 'links', 'unlink', 'close', 'extra']) {
      const out = path.join(directory, mode); fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
      for (const p of STOCK_ELECTRON_FILES) fs.writeFileSync(path.join(out, p), 'fixture-stock:' + p, { flag: 'wx' });
      const keep = path.join(out, 'resources/app.asar'); fs.writeFileSync(keep, 'keep', { flag: 'wx' });
      const stock = STOCK_ELECTRON_FILES.map(p => { const raw = fs.readFileSync(path.join(out, p)); return { path: p, bytes: raw.length, sha256: sha256(raw) }; });
      if (mode === 'hash') stock[0].sha256 = '0'.repeat(64);
      if (mode === 'extra') stock.push({ path: 'resources/app.asar', bytes: 4, sha256: sha256('keep') });
      let target, unlinks = 0; const counts = new Map();
      const ports = { ...fs, openSync: (...args) => { const fd = fs.openSync(...args); target ??= fd; return fd; },
        lstatSync: filename => { const stat = fs.lstatSync(filename); return mode === 'links' && filename === path.join(out, STOCK_ELECTRON_FILES[0]) ?
          { ...stat, nlink: 2, isFile: () => true, isSymbolicLink: () => false } : stat; },
        fstatSync: fd => { const stat = fs.fstatSync(fd), count = (counts.get(fd) ?? 0) + 1; counts.set(fd, count);
          return mode === 'identity' && fd === target && count === 2 ? { ...stat, ino: stat.ino + 1 } : stat; },
        unlinkSync: file => { unlinks++; if (mode === 'unlink') throw Error('fixture-unlink-unknown'); fs.unlinkSync(file); },
        closeSync: fd => { fs.closeSync(fd); if (mode === 'close' && fd === target) throw Error('fixture-close-unknown'); } };
      const action = runInNewContext(definition('noLinks') + '\n' + definition('readFile') + '\n' + definition('removeStockElectronFiles') +
        '\n((out,raw) => removeStockElectronFiles(out,JSON.parse(raw)))', { fs: ports, path, Buffer, createHash, STOCK_ELECTRON_FILES,
          need: (value, code) => { if (!value) throw Error(code); }, isDeepStrictEqual: createRequire(import.meta.url)('node:util').isDeepStrictEqual,
          identity: s => [s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs].join(':') });
      if (mode === 'normal') { action(out, JSON.stringify(stock)); assert.equal(unlinks, 2); }
      else { assert.throws(() => action(out, JSON.stringify(stock))); assert.equal(unlinks, mode === 'unlink' || mode === 'close' ? 1 : 0); }
      assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
    }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(parent) + path.sep)); assert.ok(!fs.lstatSync(directory).isSymbolicLink());
    fs.rmSync(directory, { recursive: true });
  }
  // Actual afterPack body must reject an unexpected tree before any correction/removal.
  const events = [], snapshot = { pkg: {}, stock: STOCK_ELECTRON_FILES.map(row), runtime: [], resources: [row('resources/codex/manifest.json')], codexSource: Buffer.from('source') };
  const run = runInNewContext('(' + definition('afterPack').replace('export ', '') + ')', { path,
    contextPath: () => 'fixed-out', attempts: new Map([['fixed-out', { snapshot }]]), validateEffectiveConfiguration() {},
    RELEASE_BLOCKERS: [], need: (value, code) => { if (!value) throw Error(code); }, sameSource() {}, readFile: () => ({ bytes: 1, sha256: h }), sha256,
    inspect: (_out, expected) => { events.push('full-tree'); assert.ok(STOCK_ELECTRON_FILES.every(p => expected.some(r => r.path === p))); throw Error('fixture-extra-tree'); },
    transformPackedCodex: () => events.push('transform'), removeStockElectronFiles: () => events.push('remove') });
  return assert.rejects(run({ packager: { config: {} } }), /extra-tree/).then(() => assert.deepEqual(events, ['full-tree']));
});

test('real builder afterSign runs after unsigned metadata editing and seals only the final executable before NSIS', async () => {
  const require = createRequire(import.meta.url); require('app-builder-lib');
  const { WinPackager } = require('app-builder-lib/out/winPackager.js');
  const { PlatformPackager } = require('app-builder-lib/out/platformPackager.js');
  const parent = path.join(root, 'output/release-1.0/asar-path-fixtures'); fs.mkdirSync(parent, { recursive: true });
  const out = fs.mkdtempSync(path.join(parent, 'metadata-')), events = [];
  try {
    fs.writeFileSync(path.join(out, 'ForgeDesk.exe'), 'fixture-before');
    const packager = { appInfo: { productFilename: 'ForgeDesk' }, platformSpecificBuildOptions: { signExecutable: false }, forceCodeSigning: false,
      computeAsarOptions: async () => ({}), shouldSignFile: () => false,
      signAndEditResources: async filename => { events.push('metadata'); fs.writeFileSync(filename, 'fixture-after'); },
      info: { emitAfterSign: async () => events.push('afterSign') } };
    packager.signApp = (context, isAsar) => WinPackager.prototype.signApp.call(packager, context, isAsar);
    await PlatformPackager.prototype.doSignAfterPack.call(packager, parent, out, 'win32', 1, {}, []);
    assert.deepEqual(events, ['metadata', 'afterSign']); assert.equal(fs.readFileSync(path.join(out, 'ForgeDesk.exe'), 'utf8'), 'fixture-after');
  } finally {
    assert.ok(path.resolve(out).startsWith(path.resolve(parent) + path.sep)); assert.ok(!fs.lstatSync(out).isSymbolicLink()); fs.rmSync(out, { recursive: true });
  }
  const ts = require('typescript'), parsed = ts.createSourceFile('audit.mjs', fs.readFileSync(new URL('../scripts/release-package-audit.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const definition = name => { const n = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(n); return n.getText(parsed); };
  for (const mode of ['normal', 'resourceBefore', 'duringExe', 'afterExe', 'afterResource']) {
    const fakeRoot = path.join(root, 'output/release-1.0/memory-only-root'), key = path.join(fakeRoot, 'release/win-unpacked');
    const attempt = { snapshot: { pkg: packageJson, sourceFreeze: {} }, post: { files: [row('ForgeDesk.exe'), row('resources/app.asar')], resources: [row('resources/app.asar')] } };
    let current = [ { ...row('ForgeDesk.exe'), sha256: '2'.repeat(64) }, row('resources/app.asar') ], reads = 0, receipt;
    if (mode === 'resourceBefore') current[1].sha256 = '3'.repeat(64);
    const ports = { path, ROOT: fakeRoot, VERSION, APP_ID, attempts: new Map([[key, attempt]]), contextPath: () => key,
      need: (v,c) => { if (!v) throw Error(c); }, validateEffectiveConfiguration, sameSource() {},
      inspect: (_out, expected) => { reads++; const checked = assertInventory(expected, current);
        if (mode === 'duringExe' && reads === 1) current[0].sha256 = '3'.repeat(64); return checked; },
      readFile: () => ({ bytes: 1, sha256: h }), validateReleaseManifest: v => v, writeReport: (_name,v) => { receipt = v; } };
    const stage = runInNewContext('(' + definition('afterSign').replace('export ', '') + ')', ports);
    const finish = runInNewContext('(' + definition('afterAllArtifactBuild').replace('export ', '') + ')', ports);
    const finishContext = { artifactPaths: [path.join(fakeRoot, 'release/ForgeDesk-1.0.0-x64-setup.exe')] };
    await assert.rejects(finish(finishContext), /FINALIZATION/);
    if (mode === 'resourceBefore' || mode === 'duringExe') { await assert.rejects(stage({ packager: { config: packageJson.build } }), /FILE_PIN/); assert.equal(attempt.finalized, undefined); continue; }
    await stage({ packager: { config: packageJson.build } }); assert.equal(attempt.finalized.files.find(r => r.path === 'ForgeDesk.exe').sha256, '2'.repeat(64));
    await assert.rejects(stage({ packager: { config: packageJson.build } }), /REUSED_POSTPACK/);
    if (mode === 'afterExe') current[0].sha256 = '3'.repeat(64);
    if (mode === 'afterResource') current[1].sha256 = '3'.repeat(64);
    if (mode === 'normal') { await finish(finishContext); assert.equal(receipt.unpacked.files.find(r => r.path === 'ForgeDesk.exe').sha256, '2'.repeat(64)); }
    else { await assert.rejects(finish(finishContext), /FILE_PIN/); assert.equal(receipt, undefined); }
  }
});

test('post hooks require the original same-process prepack owner and cannot be called to mint a receipt', async () => {
  await assert.rejects(beforePack({}), /CONTEXT/);
  const context = { packager: { projectDir: root }, electronPlatformName: 'win32', arch: 1, appOutDir: path.join(root, 'release/win-unpacked') };
  await assert.rejects(afterPack(context), /MISSING_OR_REUSED_PREPACK/);
  await assert.rejects(afterSign(context), /MISSING_OR_REUSED_POSTPACK/);
  await assert.rejects(afterAllArtifactBuild({ artifactPaths: [] }), /MISSING_OR_REUSED_FINALIZATION/);
  const ts = createRequire(import.meta.url)('typescript');
  const audit = ts.createSourceFile('audit.mjs', fs.readFileSync(new URL('../scripts/release-package-audit.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const node = audit.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'preflight'); assert.ok(node);
  let snapshots = 0, recorded;
  const snapshot = { pkg: packageJson };
  const cli = runInNewContext('(' + node.getText(audit) + ')', { ROOT: root, path, sourceSnapshot: () => { snapshots++; return snapshot; },
    recordPrepack: (ctx, captured) => { recorded = { ctx, captured }; }, need: value => assert.ok(value) });
  await cli(); assert.equal(snapshots, 1); assert.equal(recorded.captured, snapshot);
  assert.equal(recorded.ctx.packager.config, snapshot.pkg.build);
  assert.equal(validateEffectiveConfiguration(recorded.ctx.packager.config, packageJson), true);
});

test('root-recorded asset confirmation is exact, research-only and cannot expand license or weight rights', () => {
  const raw = fs.readFileSync(path.join(root, ASSET_APPROVAL.path)); assert.equal(validateAssetApproval(raw), true);
  assert.deepEqual(RELEASE_BLOCKERS, []);
  assert.throws(() => validateAssetApproval(undefined), /APPROVAL_PIN/);
  assert.throws(() => validateAssetApproval(Buffer.concat([raw, Buffer.from(' ')])), /APPROVAL_PIN/);
  for (const mutate of [m => m.scope = 'commercial', m => m.screenshotUsageConfirmed = false,
    m => m.weightRightsExtended = true, m => m.licenseTermsUnchanged = false, m => m.qualified = true]) {
    const invalid = JSON.parse(raw); mutate(invalid); assert.throws(() => validateAssetApproval(Buffer.from(JSON.stringify(invalid))), /APPROVAL_PIN/);
  }
});

test('Codex package-copy metadata transform changes only source, never the vendor or four executable pins', () => {
  const source = fs.readFileSync(path.join(root, 'vendor/codex/manifest.json')), old = JSON.parse(source), derived = deriveCodexManifest(source);
  assert.equal(validateCodexTransform(source, derived), true); assert.equal(sha256(derived), CODEX_PACKAGED_MANIFEST_SHA256);
  const changed = JSON.parse(derived); assert.deepEqual({ ...changed, source: old.source }, old);
  assert.match(changed.source, /different raw signed-container hashes/); assert.ok(!changed.source.includes('C:\\Users\\'));
  for (const mutate of [m => m.files[0].sha256 = '0'.repeat(64), m => m.files[0].size++, m => m.version += '-changed', m => m.recordedAt = 'changed', m => m.extra = true]) {
    const invalid = structuredClone(changed); mutate(invalid); assert.throws(() => validateCodexTransform(source, Buffer.from(JSON.stringify(invalid, null, 2) + '\n')), /TRANSFORM/);
  }
  assert.ok(fs.readFileSync(path.join(root, 'vendor/codex/manifest.json')).equals(source));
});

test('five exact public notices/source archives and owned arrangement text have fixed body pins', () => {
  const specs = RESOURCE_SPECS.filter(s => s.from.startsWith('resources/licenses/')); assert.equal(specs.length, 6);
  for (const spec of specs) assert.equal(sha256(fs.readFileSync(path.join(root, spec.from))), spec.files[0].sha256);
  assert.ok(specs.some(s => s.to.endsWith('libusb-1.0.30-source.tar.gz')));
  assert.ok(specs.some(s => s.to.endsWith('libusb-package-1.0.30.0-source.tar.gz')));
});

test('actual packed-copy writer retains vendor input and refuses other changes before writing', () => {
  const ts = createRequire(import.meta.url)('typescript');
  const audit = ts.createSourceFile('audit.mjs', fs.readFileSync(new URL('../scripts/release-package-audit.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const node = audit.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'transformPackedCodex'); assert.ok(node);
  const original = fs.readFileSync(path.join(root, 'vendor/codex/manifest.json')), derived = deriveCodexManifest(original);
  for (const failure of ['none', 'source', 'derived', 'fsync']) {
    let data = Buffer.from(original), closed = 0, writes = 0, syncs = 0;
    if (failure === 'source') data[0] ^= 1;
    const stat = () => ({ dev: 1, ino: 1, size: data.length, nlink: 1, mtimeMs: writes, ctimeMs: writes, isFile: () => true });
    const memoryFs = { lstatSync: stat, fstatSync: stat, openSync: () => 7, closeSync: () => { closed++; },
      readSync: (_fd, buffer, offset, length, position) => data.copy(buffer, offset, position, position + length),
      writeFileSync: (_fd, raw) => { writes++; data = Buffer.from(raw); }, ftruncateSync: (_fd, size) => { data = data.subarray(0, size); },
      fsyncSync: () => { syncs++; if (failure === 'fsync') throw Error('fixture-sync-unknown'); } };
    const fn = runInNewContext('(' + node.getText(audit) + ')', { fs: memoryFs, Buffer, validateCodexTransform,
      noLinks: p => assert.equal(p, 'fixed/resources/codex/manifest.json'), identity: s => [s.dev, s.ino, s.size, s.nlink, s.mtimeMs, s.ctimeMs].join(':'),
      need: (value, code) => { if (!value) throw Error(code); } });
    const snapshot = { codexSource: original, codexPackaged: failure === 'derived' ? Buffer.from(derived.toString().replace('recordedAt', 'extra')) : derived };
    if (failure === 'none') { fn('fixed/resources/codex/manifest.json', snapshot); assert.ok(data.equals(derived)); assert.equal(syncs, 1); }
    else assert.throws(() => fn('fixed/resources/codex/manifest.json', snapshot));
    assert.equal(closed, 1); assert.equal(writes, failure === 'none' || failure === 'fsync' ? 1 : 0);
  }
  assert.ok(fs.readFileSync(path.join(root, 'vendor/codex/manifest.json')).equals(original));
});

test('release receipt is closed public inventory, never installation, software or device authorization', () => {
  const value = manifestFixture(); assert.equal(validateReleaseManifest(value), value);
  for (const mutate of [m => m.version = '0.5.7', m => m.appId = 'foreign', m => m.qualification.releaseAuthorized = true,
    m => m.qualification.installationVerified = true, m => m.ready = true, m => m.sourceFreeze.resourceManifestPins[0].extra = true,
    m => m.unpacked.files = m.unpacked.files.filter(r => r.path !== 'ForgeDesk.exe'), m => m.bundles.pop(),
    m => m.resources.push(row('resources/credentials.json')), m => m.artifacts[0].path = 'release/old-setup.exe',
    m => delete m.sourceFreeze.assetApproval, m => m.sourceFreeze.assetApproval.sha256 = h, m => m.sourceFreeze.assetApproval.scope = 'commercial']) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => validateReleaseManifest(changed));
  }
});

test('reviewed captured validator bytes import without a named source reopen or non-builtin dependency', async () => {
  const raw = fs.readFileSync(new URL('../scripts/release-package-audit.mjs', import.meta.url));
  const captured = await import('data:text/javascript;base64,' + raw.toString('base64'));
  assert.equal(captured.validateReleaseManifest(manifestFixture()).version, VERSION);
  await assert.rejects(captured.beforePack({}), /CONTEXT/);
  await assert.rejects(captured.afterAllArtifactBuild({}), /CONTEXT/);
});
