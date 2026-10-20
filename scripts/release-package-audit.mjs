import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const ROOT = import.meta.url.startsWith('file:') ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : undefined;
const need = (value, code) => { if (!value) throw Error('RELEASE_AUDIT_' + code); };
export const sha256 = raw => createHash('sha256').update(raw).digest('hex');
export const APP_ID = 'dev.forgedesk.codex';
export const VERSION = '1.0.0';
export const HOOK = './scripts/release-package-audit.mjs';
export const STARTUP_HISTORY_RESOURCE = Object.freeze({ from: 'dist/main/release-recovery-history-worker.cjs', to: 'startup-history/release-recovery-history-worker.cjs', single: true, generated: true });
export const DIST_FILES = Object.freeze(['licenses/GestureScreen.txt', 'licenses/lucide-react.txt', 'licenses/react-dom.txt', 'licenses/react.txt',
  'main/index.cjs', 'main/index.cjs.map', 'main/release-recovery-history-worker.cjs', 'mcp/index.cjs', 'preload/index.cjs', 'renderer/index.css', 'renderer/index.css.map',
  'renderer/index.html', 'renderer/index.js', 'renderer/index.js.map', 'renderer/assets/brand.ico', 'renderer/assets/brand.png'].sort());
export const PACKAGED_FILES = Object.freeze([...DIST_FILES.filter(p => !p.endsWith('.map') && 'dist/' + p !== STARTUP_HISTORY_RESOURCE.from).map(p => 'dist/' + p), 'package.json'].sort());
export const BUILD_FILES = Object.freeze([...PACKAGED_FILES, '!node_modules/**/*']);
const ELECTRON_FILES = Object.freeze(['chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'electron.exe', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll',
  ...'af am ar bg bn ca cs da de el en-GB en-US es-419 es et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nb nl pl pt-BR pt-PT ro ru sk sl sr sv sw ta te th tr uk ur vi zh-CN zh-TW'.split(' ').map(p => 'locales/' + p + '.pak')].sort());
export const STOCK_ELECTRON_FILES = Object.freeze(['resources/default_app.asar', 'version']);
export const RUNTIME_FILES = Object.freeze(ELECTRON_FILES.map(p => p === 'electron.exe' ? 'ForgeDesk.exe' : p === 'LICENSE' ? 'LICENSE.electron.txt' : p).sort());
// Root-recorded user confirmation is limited to this private research release.
export const ASSET_APPROVAL = Object.freeze({ path: 'output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json', sha256: 'ffaa3b419074f7960f37b0c465586fd353bf2a66904f52e8804b25e89fae5b47' });
export const RELEASE_BLOCKERS = Object.freeze([]);
export const CODEX_PUBLIC_SOURCE = 'Program source: https://github.com/openai/codex/tree/rust-v0.162.0-alpha.17.2 ; matching official npm Windows package has different raw signed-container hashes. Reviewed program content is equal excluding only PE checksum, Security Directory entry and terminal certificate table. Bundled signed-container bytes and their exact file hashes are retained; no raw official-file equality is asserted.';
export const CODEX_PACKAGED_MANIFEST_SHA256 = '4204f1aa3a9ac20d3bf8e98fc6b44e1f8e470d3e3db35df32cca109af933f336';
export const CODEX_PACKAGED_MANIFEST_BYTES = 1191;
export const RESOURCE_SPECS = Object.freeze([
  { from: 'vendor/codex', to: 'codex', manifest: 'manifest.json', kind: 'codex', pin: '872d592fc313c2c15781d4c910a73cbcbc2f13793b1855351e14b1d6bb7b3dc7', extra: [{ path: 'LICENSE', sha256: 'aa5e89edcbbd01fc3fb188a527d8bdc0da5812305cab220c84348c14ea427288' }] },
  { from: 'vendor/process-host', to: 'process-host', manifest: 'manifest.json', kind: 'process', pin: '6e5c68fbed00ebec5d61fdc8c0d465d3731ba15f76ef77e4b9b1758de539a30b' },
  { from: 'engineering/templates/node-software-v1', to: 'templates/node-software-v1', files: [
    { path: 'build.mjs', sha256: '7fa07121f86a42d0c8b137d8e9a8c5d716f6bb91eb3c5938199e7760556f028f' },
    { path: 'permission-probe.mjs', sha256: 'a7808754a361c9bf6efff605a050f87337f6066a2439b9b0dade9f8035ca6ad4' },
    { path: 'sandbox-probe.mjs', sha256: '5506abee15a8b7c58abf65905f8a1479af13c0aba16165aa32bbef8a0ca69e6f' },
    { path: 'verify.mjs', sha256: '55e377db5fa0213ba0055fa2bcbd8b9cd45cea7afa569d4d389f84569a01dd0c' }] },
  { from: 'vendor/hardware', to: 'hardware', manifest: 'manifest.json', kind: 'files', pin: '71736b44808ffae3fdc703bfcf57059cb2c646251557f97a1cc4470f153d02b2' },
  { from: 'engineering/hardware-worker.py', to: 'hardware-worker.py', single: true, files: [{ path: '', sha256: '00afe49ab02ecc639599eab8fbc54242c293a1bf6674286e94ca389636b35a3f' }] },
  { from: 'engineering/templates/gesturescreen-v1', to: 'templates/gesturescreen-v1', manifest: 'overlay-manifest.json', kind: 'files', pin: 'd69f4e175352d29669d262d92f3da77a3c877d3f0673681d685d4bc667cf04f7' },
  { from: 'engineering/fz3b/product/resources', to: 'fz3b', manifest: 'manifest.json', kind: 'files', pin: 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07' },
  { from: 'vendor/host-acl', to: 'host-acl', manifest: 'manifest.json', kind: 'generated-host-acl', sourcePin: 'aa3079992d2ac92b5dd800d3e5c62f70671dce36ff80b28ca7f6f8694e75786e', compilerPin: '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00' },
  { from: 'vendor/host-failed-empty-intent', to: 'host-failed-empty-intent', manifest: 'manifest.json', kind: 'generated-failed-intent', policyPin: '6747f3b255c8f074ba28a3fee7cadb07316750aa05494b1e41d45a046c3108e3' },
  ...[
    ['Codex-LICENSE.txt', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
    ['Codex-NOTICE.txt', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
    ['libusb-1.0.30-COPYING.txt', '5df07007198989c622f5d41de8d703e7bef3d0e79d62e24332ee739a452af62a'],
    ['libusb-1.0.30-source.tar.gz', '2ae28adb0bb9558c86135c4e1c11b320b0805461e207a64a6e520a114094bf07'],
    ['libusb-package-1.0.30.0-source.tar.gz', '9f1db61faeff213cdac1d27ff8ef4318ead5ffd36075f7e363a5b67b7c7a99e2'],
    ['THIRD_PARTY_SOURCES.txt', '32d929c90fb59e06a9adf156cf117f87bd99bc646966e702e3f87870d583b726'],
  ].map(([name, pin]) => ({ from: 'resources/licenses/' + name, to: 'licenses/' + name, single: true, files: [{ path: '', sha256: pin }] })),
  STARTUP_HISTORY_RESOURCE,
]);
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function relative(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\\') && !value.includes(':') &&
    !value.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f\x7f]/.test(value), 'PATH'); return value;
}
const json = raw => JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
const sorted = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'));
export function validateAssetApproval(raw) {
  need(Buffer.isBuffer(raw) && raw.length <= 4096 && sha256(raw) === ASSET_APPROVAL.sha256, 'ASSET_APPROVAL_PIN');
  need(isDeepStrictEqual(json(raw), { schema: 'forgedesk-release-asset-approval-v1', version: VERSION, scope: 'private-research-only',
    screenshotUsageConfirmed: true, modelAndEmbeddingUse: 'research-only-under-existing-license', commercialRightsGranted: false,
    licenseTermsUnchanged: true, weightRightsExtended: false }), 'ASSET_APPROVAL_SCOPE');
  return true;
}
export function deriveCodexManifest(raw) {
  need(Buffer.isBuffer(raw) && sha256(raw) === RESOURCE_SPECS[0].pin, 'CODEX_SOURCE_PIN');
  return Buffer.from(JSON.stringify({ ...json(raw), source: CODEX_PUBLIC_SOURCE }, null, 2) + '\n');
}
export function validateCodexTransform(source, packaged) {
  need(Buffer.isBuffer(packaged) && packaged.equals(deriveCodexManifest(source)) && sha256(packaged) === CODEX_PACKAGED_MANIFEST_SHA256, 'CODEX_SOURCE_ONLY_TRANSFORM');
  return true;
}
export function expectedResourceRows(spec, manifestRaw) {
  need(!spec.generated, 'GENERATED_RESOURCE_CAPTURE_REQUIRED');
  let files = [...(spec.files ?? [])];
  if (spec.manifest) {
    need(Buffer.isBuffer(manifestRaw) && manifestRaw.length > 0 && manifestRaw.length <= 2097152, 'RESOURCE_MANIFEST_BOUND');
    if (spec.pin) need(sha256(manifestRaw) === spec.pin, 'RESOURCE_PIN_CHANGED');
    const data = json(manifestRaw);
    if (spec.kind === 'codex') files = data.files.map(f => ({ path: f.name, bytes: f.size, sha256: f.sha256.toLowerCase() }));
    else if (spec.kind === 'process') files = [{ path: data.file, sha256: data.sha256 }];
    else if (spec.kind === 'intent') files = [{ path: 'FailedEmptyIntentHelper.exe', sha256: data.executableSha256 }];
    else if (spec.kind === 'generated-host-acl') {
      need(Object.keys(data).sort().join(',') === 'compilerSha256,files,protocolVersion,schemaVersion,scope,sourceSha256' &&
        data.schemaVersion === 1 && data.scope === 'fixed-host-acl-dotnet-v1' && data.protocolVersion === 1 &&
        data.sourceSha256 === spec.sourcePin && data.compilerSha256 === spec.compilerPin && Array.isArray(data.files) && data.files.length === 1, 'HOST_ACL_MANIFEST');
      files = data.files.map(f => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }));
    } else if (spec.kind === 'generated-failed-intent') {
      need(Object.keys(data).sort().join(',') === 'executableSha256,policySourceSha256,protocol,schemaVersion' &&
        data.schemaVersion === 1 && data.protocol === 'fz3b-failed-empty-intent-v1' && data.policySourceSha256 === spec.policyPin, 'FAILED_INTENT_MANIFEST');
      files = [{ path: 'FailedEmptyIntentHelper.exe', sha256: data.executableSha256 }];
    }
    else { need(Array.isArray(data.files), 'MANIFEST'); files = data.files.map(f => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })); }
    files.push({ path: spec.manifest, bytes: manifestRaw.length, sha256: sha256(manifestRaw) }, ...(spec.extra ?? []));
  }
  const names = new Set();
  for (const row of files) {
    if (!spec.single) relative(row.path);
    need(typeof row.path === 'string' && !names.has(row.path.toLowerCase()) && hex(row.sha256) &&
      (row.bytes === undefined || Number.isSafeInteger(row.bytes) && row.bytes >= 0), 'MANIFEST_ROW');
    names.add(row.path.toLowerCase());
  }
  need(files.length > 0 && files.length <= 5000, 'MANIFEST_BOUND'); return sorted(files);
}
export function assertInventory(expected, actual) {
  need(Array.isArray(actual) && actual.length === expected.length && actual.length <= 10000, 'INVENTORY');
  const expectedMap = new Map(expected.map(r => [r.path, r])); const seen = new Set();
  for (const row of actual) {
    relative(row.path);
    need(!seen.has(row.path.toLowerCase()) && expectedMap.has(row.path) && row.kind !== 'link' && row.unpacked !== true &&
      Number.isSafeInteger(row.bytes) && row.bytes >= 0 && hex(row.sha256), 'UNLISTED_OR_UNSAFE_FILE'); seen.add(row.path.toLowerCase());
    const wanted = expectedMap.get(row.path);
    need((wanted.bytes === undefined || wanted.bytes === row.bytes) && (!wanted.sha256 || wanted.sha256 === row.sha256), 'FILE_PIN');
  }
  return sorted(actual.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
}
export function compiledStartupHistoryBindings(raw, ts) {
  need(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 2097152, 'COMPILED_MAIN_BOUND');
  const source = ts.createSourceFile('index.cjs', raw.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  need(source.parseDiagnostics.length === 0, 'COMPILED_MAIN_PARSE');
  const owners = source.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createNativeStartupHistoryOwner');
  need(owners.length === 1 && owners[0].parameters.length === 2 && owners[0].parameters[1].initializer && ts.isIdentifier(owners[0].parameters[1].initializer), 'COMPILED_OWNER');
  const portName = owners[0].parameters[1].initializer.text;
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations])
    .filter(n => ts.isIdentifier(n.name) && n.name.text === portName);
  need(declarations.length === 1 && declarations[0].initializer && ts.isObjectLiteralExpression(declarations[0].initializer), 'COMPILED_PORT');
  const methods = declarations[0].initializer.properties.filter(n => ts.isMethodDeclaration(n) && n.name?.getText(source) === 'verify');
  need(methods.length === 1 && methods[0].body && methods[0].parameters.length === 2 && methods[0].parameters.every(p => ts.isIdentifier(p.name)) &&
    methods[0].parameters[0].name.text === 'worker' && methods[0].parameters[1].name.text === 'host', 'COMPILED_VERIFY');
  let pinCalls = 0;
  function countPins(node) { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^pinned\d*$/.test(node.expression.text)) pinCalls++; ts.forEachChild(node, countPins); }
  countPins(methods[0].body); need(pinCalls === 2, 'COMPILED_PIN_COUNT');
  const bindings = {};
  for (const statement of methods[0].body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) continue;
    const call = statement.expression.expression;
    need(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && /^pinned\d*$/.test(call.expression.text) && call.arguments.length === 3 &&
      ts.isIdentifier(call.arguments[0]) && ['host', 'worker'].includes(call.arguments[0].text) && ts.isStringLiteral(call.arguments[1]) &&
      source.statements.some(n => ts.isFunctionDeclaration(n) && n.name?.text === call.expression.text), 'COMPILED_PIN_CALL');
    const target = call.arguments[0].text; need(!Object.hasOwn(bindings, target), 'COMPILED_PIN_DUPLICATE'); bindings[target] = call.arguments[1].text;
  }
  need(Object.keys(bindings).length === 2, 'COMPILED_PIN_MISSING'); return bindings;
}
export function validateStartupHistoryBinding(bindings, worker, host) {
  need(bindings &&
    worker?.path === 'resources/' + STARTUP_HISTORY_RESOURCE.to && worker.bytes > 0 && worker.bytes <= 16777216 && hex(worker.sha256) &&
    host?.path === 'resources/process-host/process-host.exe' && host.bytes > 0 && hex(host.sha256) &&
    bindings.worker === worker.sha256 && bindings.host === host.sha256, 'STARTUP_COMPILED_BINDING');
  return true;
}
export function validateConfiguration(pkg, lock) {
  need(pkg.version === VERSION && lock.version === VERSION && lock.packages?.['']?.version === VERSION && pkg.name === lock.name && pkg.name === lock.packages[''].name, 'VERSION');
  need(isDeepStrictEqual(pkg.build.files, BUILD_FILES) && pkg.build.asar === true && pkg.build.electronDist === 'node_modules/electron/dist' && pkg.build.asarUnpack === undefined && pkg.build.extraFiles === undefined &&
    pkg.build.beforePack === HOOK && pkg.build.afterPack === HOOK && pkg.build.afterSign === HOOK && pkg.build.afterAllArtifactBuild === HOOK, 'HOOK_OR_FILES_CONFIG');
  need(isDeepStrictEqual(pkg.build.extraResources, RESOURCE_SPECS.map(({ from, to }) => ({ from, to }))), 'RESOURCE_CONFIG');
  need(pkg.main === 'dist/main/index.cjs' && pkg.build.appId === APP_ID && pkg.build.productName === 'ForgeDesk' && pkg.build.win.target === 'nsis' &&
    pkg.build.win.signExecutable === false && pkg.build.win.signAndEditExecutable === undefined &&
    pkg.build.nsis.perMachine === false && pkg.build.nsis.oneClick === false && pkg.build.nsis.allowToChangeInstallationDirectory === true &&
    pkg.build.nsis.deleteAppDataOnUninstall === false && pkg.build.nsis.packElevateHelper === false && !pkg.build.nsis.include && !pkg.build.nsis.script &&
    pkg.build.nsis.runAfterFinish === false && pkg.build.nsis.allowElevation === false &&
    pkg.build.directories.output === 'release' && pkg.build.artifactName === 'ForgeDesk-${version}-${arch}-setup.${ext}', 'INSTALL_SCOPE');
  need(isDeepStrictEqual(Object.keys(pkg).sort(), ['author', 'build', 'dependencies', 'description', 'devDependencies', 'license', 'main', 'name', 'overrides', 'private', 'scripts', 'type', 'version'].sort()), 'PACKAGE_METADATA');
  return true;
}
export function validateEffectiveConfiguration(config, pkg) {
  need(config && (isDeepStrictEqual(config.files, BUILD_FILES) || isDeepStrictEqual(config.files, [{ filter: BUILD_FILES }])), 'EFFECTIVE_FILES');
  for (const key of ['extraResources', 'extraFiles', 'asar', 'asarUnpack', 'electronDist', 'beforePack', 'afterPack', 'afterSign', 'afterAllArtifactBuild', 'artifactName'])
    need(isDeepStrictEqual(config[key], pkg.build[key]), 'EFFECTIVE_CONFIG');
  need(!config.extraMetadata && config.win?.target === 'nsis' && config.win.signExecutable === false && config.win.signAndEditExecutable === undefined &&
    ['files', 'extraResources', 'extraFiles', 'asarUnpack'].every(key => config.win[key] === undefined), 'EFFECTIVE_PLATFORM_OVERRIDE');
  for (const key of ['perMachine', 'oneClick', 'allowToChangeInstallationDirectory', 'deleteAppDataOnUninstall', 'packElevateHelper', 'runAfterFinish', 'allowElevation', 'include', 'script'])
    need(isDeepStrictEqual(config.nsis?.[key], pkg.build.nsis[key]), 'EFFECTIVE_INSTALL_SCOPE');
  return true;
}
function noLinks(filename) {
  const full = path.resolve(filename); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); need(!fs.lstatSync(current).isSymbolicLink(), 'REPARSE'); }
  need(fs.realpathSync(full).toLowerCase() === full.toLowerCase(), 'CANONICAL');
}
const identity = s => [s.dev, s.ino, s.size, s.nlink, s.mtimeMs, s.ctimeMs].join(':');
function readFile(filename, capture = false, limit = capture ? 2097152 : 536870912) {
  noLinks(filename); const named = fs.lstatSync(filename); need(named.isFile() && named.nlink === 1 && named.size <= limit, 'FILE_BOUND');
  const fd = fs.openSync(filename, 'r');
  try {
    need(identity(fs.fstatSync(fd)) === identity(named), 'FILE_CHANGED');
    const buffer = Buffer.alloc(1048576), hash = createHash('sha256'), chunks = []; let bytes = 0;
    for (;;) { const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, named.size + 1 - bytes), bytes); if (!n) break;
      bytes += n; need(bytes <= named.size, 'FILE_CHANGED'); hash.update(buffer.subarray(0, n)); if (capture) chunks.push(Buffer.from(buffer.subarray(0, n))); }
    noLinks(filename); need(bytes === named.size && identity(named) === identity(fs.fstatSync(fd)) && identity(named) === identity(fs.lstatSync(filename)), 'FILE_CHANGED');
    return { bytes, sha256: hash.digest('hex'), ...(capture ? { raw: Buffer.concat(chunks) } : {}) };
  } finally { fs.closeSync(fd); }
}
function names(root, expected) {
  noLinks(root); const found = []; let entries = 0;
  const allowedDirectories = expected && new Set(expected.flatMap(p => p.split('/').slice(0, -1).map((_, index) => p.split('/').slice(0, index + 1).join('/'))));
  function walk(directory, prefix, depth) {
    need(depth <= 24, 'TREE_DEPTH');
    const before = fs.lstatSync(directory); need(before.isDirectory(), 'DIRECTORY');
    for (const name of fs.readdirSync(directory).sort()) {
      need(++entries <= 10000, 'TREE_BOUND'); const rel = relative(prefix ? prefix + '/' + name : name), full = path.join(directory, name), stat = fs.lstatSync(full);
      need(!stat.isSymbolicLink(), 'REPARSE');
      if (stat.isDirectory()) { need(!allowedDirectories || allowedDirectories.has(rel), 'UNLISTED_DIRECTORY'); walk(full, rel, depth + 1); }
      else { need(stat.isFile() && stat.nlink === 1, 'FILE_KIND'); found.push(rel); }
    }
    need(identity(before) === identity(fs.lstatSync(directory)), 'TREE_CHANGED');
  }
  walk(root, '', 0); return found.sort();
}
function inspect(root, expected) {
  const actual = names(root, expected.map(r => r.path)); need(isDeepStrictEqual(actual, expected.map(r => r.path).sort()), 'UNLISTED_OR_MISSING_RESOURCE');
  return assertInventory(expected, actual.map(p => ({ path: p, ...readFile(path.join(root, p)) })));
}
function sourceSnapshot() {
  const packageFile = readFile(path.join(ROOT, 'package.json'), true), lockFile = readFile(path.join(ROOT, 'package-lock.json'), true);
  const pkg = json(packageFile.raw); validateConfiguration(pkg, json(lockFile.raw));
  validateAssetApproval(readFile(path.join(ROOT, ASSET_APPROVAL.path), true, 4096).raw);
  const resourceManifestPins = [], resources = []; let codexSource, codexPackaged;
  for (const spec of RESOURCE_SPECS) {
    if (spec.generated) { resources.push({ path: 'resources/' + spec.to, ...readFile(path.join(ROOT, spec.from), false, 16777216) }); continue; }
    const manifest = spec.manifest ? readFile(path.join(ROOT, spec.from, spec.manifest), true).raw : undefined;
    const expected = expectedResourceRows(spec, manifest);
    if (spec.manifest) resourceManifestPins.push({ path: spec.from + '/' + spec.manifest, sha256: sha256(manifest) });
    const rows = spec.single ? [{ path: spec.to, ...readFile(path.join(ROOT, spec.from)) }] : inspect(path.join(ROOT, spec.from), expected).map(r => ({ ...r, path: spec.to + '/' + r.path }));
    if (spec.single) need(rows[0].sha256 === expected[0].sha256, 'FILE_PIN');
    resources.push(...rows.map(r => ({ ...r, path: 'resources/' + r.path })));
    if (spec.kind === 'codex') { codexSource = manifest; codexPackaged = deriveCodexManifest(manifest); validateCodexTransform(manifest, codexPackaged); }
  }
  const codexRow = resources.find(r => r.path === 'resources/codex/manifest.json');
  codexRow.bytes = codexPackaged.length; codexRow.sha256 = sha256(codexPackaged);
  const dist = inspect(path.join(ROOT, 'dist'), DIST_FILES.map(path => ({ path })));
  const bundles = dist.filter(r => PACKAGED_FILES.includes('dist/' + r.path)).map(r => ({ ...r, path: 'dist/' + r.path }));
  const worker = resources.find(r => r.path === 'resources/' + STARTUP_HISTORY_RESOURCE.to);
  need(isDeepStrictEqual({ ...dist.find(r => 'dist/' + r.path === STARTUP_HISTORY_RESOURCE.from), path: worker.path }, worker), 'STARTUP_WORKER_CHANGED');
  const main = readFile(path.join(ROOT, 'dist/main/index.cjs'), true);
  need(main.sha256 === bundles.find(r => r.path === 'dist/main/index.cjs').sha256, 'STARTUP_MAIN_CHANGED');
  validateStartupHistoryBinding(compiledStartupHistoryBindings(main.raw, createRequire(path.join(ROOT, 'package.json'))('typescript')),
    worker, resources.find(r => r.path === 'resources/process-host/process-host.exe'));
  const electronRoot = path.join(ROOT, 'node_modules/electron/dist');
  need(readFile(path.join(electronRoot, 'version'), true).raw.toString('utf8').trim() === '44.7.2', 'ELECTRON_VERSION');
  const electronSource = inspect(electronRoot, [...ELECTRON_FILES, 'version', 'resources/default_app.asar'].map(path => ({ path })));
  const runtime = electronSource.filter(r => ELECTRON_FILES.includes(r.path)).map(r => r.path === 'electron.exe' ? { path: 'ForgeDesk.exe' } :
    { ...r, path: r.path === 'LICENSE' ? 'LICENSE.electron.txt' : r.path });
  const metadata = { ...pkg }; delete metadata.build; delete metadata.scripts; delete metadata.devDependencies;
  return { pkg, metadata, runtime, stock: electronSource.filter(r => STOCK_ELECTRON_FILES.includes(r.path)), codexSource, codexPackaged, resources: sorted(resources), bundles: sorted(bundles), sourceFreeze: { packageSha256: packageFile.sha256, lockSha256: lockFile.sha256,
    auditSourceSha256: readFile(fileURLToPath(import.meta.url)).sha256, buildSourceSha256: readFile(path.join(ROOT, 'scripts/build.mjs')).sha256, assetApproval: ASSET_APPROVAL, resourceManifestPins,
    resourceTransforms: [{ path: 'resources/codex/manifest.json', method: 'codex-public-source-only-v1', sourceSha256: sha256(codexSource), packagedSha256: sha256(codexPackaged) }] } };
}
function sameSource(snapshot) { need(isDeepStrictEqual(sourceSnapshot(), snapshot), 'SOURCE_CHANGED'); }
function contextPath(context) {
  need(ROOT && path.resolve(context.packager?.projectDir ?? '') === ROOT && context.electronPlatformName === 'win32' && context.arch === 1, 'CONTEXT');
  const out = path.resolve(context.appOutDir); need(out === path.join(ROOT, 'release', 'win-unpacked'), 'OUTPUT_PATH'); return out;
}
const attempts = new Map();
function writeReport(filename, value) {
  const directory = path.join(ROOT, 'output', 'release-1.0', 'package-audit');
  fs.mkdirSync(directory, { recursive: true }); noLinks(directory);
  const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n'); need(raw.length <= 4194304, 'REPORT_BOUND');
  const fd = fs.openSync(path.join(directory, filename), 'wx+', 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); const copy = Buffer.alloc(raw.length); let n = 0;
    while (n < copy.length) { const used = fs.readSync(fd, copy, n, copy.length - n, n); need(used > 0, 'REPORT_READBACK'); n += used; }
    need(copy.equals(raw) && fs.fstatSync(fd).nlink === 1, 'REPORT_READBACK');
  } finally { fs.closeSync(fd); }
}
async function recordPrepack(context, snapshot) {
  const out = contextPath(context); need(!attempts.has(out), 'PREVIOUS_ATTEMPT');
  validateEffectiveConfiguration(context.packager.config, snapshot.pkg); attempts.set(out, { snapshot });
  writeReport('PREPACK.json', { schema: 'forgedesk-release-prepack-v1', version: VERSION, appId: APP_ID, sourceFreeze: snapshot.sourceFreeze,
    expectedResources: snapshot.resources, bundles: snapshot.bundles, blockers: RELEASE_BLOCKERS, releaseAuthorized: false });
  need(RELEASE_BLOCKERS.length === 0, 'REDISTRIBUTION_REVIEW_BLOCKED');
}
export async function beforePack(context) { contextPath(context); return recordPrepack(context, sourceSnapshot()); }
async function preflight() {
  need(ROOT, 'CONTEXT'); const snapshot = sourceSnapshot();
  return recordPrepack({ packager: { projectDir: ROOT, config: snapshot.pkg.build }, electronPlatformName: 'win32', arch: 1,
    appOutDir: path.join(ROOT, 'release/win-unpacked') }, snapshot);
}
export function validateArchive(snapshot, entries, packagedMetadata) {
  const expected = [...snapshot.bundles, { path: 'package.json' }];
  const rows = assertInventory(expected, entries);
  need(isDeepStrictEqual(packagedMetadata, snapshot.metadata), 'ASAR_PACKAGE_METADATA'); return rows;
}
function transformPackedCodex(filename, snapshot) {
  noLinks(filename); const named = fs.lstatSync(filename); need(named.isFile() && named.nlink === 1 && named.size === snapshot.codexSource.length, 'CODEX_COPY_IDENTITY');
  const fd = fs.openSync(filename, 'r+');
  try {
    need(identity(named) === identity(fs.fstatSync(fd)), 'CODEX_COPY_CHANGED');
    const original = Buffer.alloc(named.size); need(fs.readSync(fd, original, 0, original.length, 0) === original.length && original.equals(snapshot.codexSource), 'CODEX_COPY_SOURCE');
    validateCodexTransform(original, snapshot.codexPackaged);
    fs.writeFileSync(fd, snapshot.codexPackaged); fs.ftruncateSync(fd, snapshot.codexPackaged.length); fs.fsyncSync(fd);
    const check = Buffer.alloc(snapshot.codexPackaged.length); let used = 0;
    while (used < check.length) { const n = fs.readSync(fd, check, used, check.length - used, used); need(n > 0, 'CODEX_COPY_READBACK'); used += n; }
    noLinks(filename); need(check.equals(snapshot.codexPackaged) && identity(fs.fstatSync(fd)) === identity(fs.lstatSync(filename)), 'CODEX_COPY_READBACK');
  } finally { fs.closeSync(fd); }
}
export function readArchiveInventory(archive, asar) {
  asar.uncache(archive);
  const entries = [];
  for (const raw of asar.listPackage(archive)) {
    const p = raw.replace(/^[/\\]/, '').replaceAll('\\', '/'); relative(p);
    // Policy/receipts use '/', but asar's filesystem indexes with the host separator.
    const apiPath = p.split('/').join(path.sep), stat = asar.statFile(archive, apiPath, false);
    need(!stat.link && !stat.unpacked, 'ASAR_LINK_OR_UNPACKED'); if (stat.files) continue;
    need(PACKAGED_FILES.includes(p) && stat.size <= 33554432, 'ASAR_UNLISTED');
    const content = asar.extractFile(archive, apiPath, false); entries.push({ path: p, bytes: content.length, sha256: sha256(content) });
  }
  return { entries, metadata: json(asar.extractFile(archive, 'package.json', false)) };
}
function removeStockElectronFiles(out, expected) {
  need(isDeepStrictEqual(expected.map(r => r.path).sort(), [...STOCK_ELECTRON_FILES].sort()), 'STOCK_FILES');
  for (const wanted of expected) {
    const filename = path.join(out, wanted.path); noLinks(filename);
    const named = fs.lstatSync(filename); need(named.isFile() && named.nlink === 1 && named.size === wanted.bytes, 'STOCK_IDENTITY');
    const fd = fs.openSync(filename, 'r');
    try {
      need(identity(named) === identity(fs.fstatSync(fd)) && isDeepStrictEqual(readFile(filename), { bytes: wanted.bytes, sha256: wanted.sha256 }), 'STOCK_PIN');
      noLinks(filename); need(identity(named) === identity(fs.fstatSync(fd)) && identity(named) === identity(fs.lstatSync(filename)), 'STOCK_CHANGED');
      fs.unlinkSync(filename);
      let absent = false; try { fs.lstatSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; }
      need(absent, 'STOCK_REMOVE');
    } finally { fs.closeSync(fd); }
  }
}
export async function afterPack(context) {
  const out = contextPath(context), attempt = attempts.get(out); need(attempt && !attempt.post, 'MISSING_OR_REUSED_PREPACK');
  validateEffectiveConfiguration(context.packager.config, attempt.snapshot.pkg);
  need(RELEASE_BLOCKERS.length === 0, 'REDISTRIBUTION_REVIEW_BLOCKED'); sameSource(attempt.snapshot);
  const archive = path.join(out, 'resources', 'app.asar'), archivePin = readFile(archive); need(archivePin.bytes <= 67108864, 'ASAR_BOUND');
  // Check the whole copied tree before either of the two narrowly approved corrections.
  const rawResources = attempt.snapshot.resources.map(r => r.path === 'resources/codex/manifest.json' ?
    { path: r.path, bytes: attempt.snapshot.codexSource.length, sha256: sha256(attempt.snapshot.codexSource) } : r);
  const copied = inspect(out, [...attempt.snapshot.runtime, { path: 'resources/app.asar', ...archivePin }, ...rawResources, ...attempt.snapshot.stock]);
  transformPackedCodex(path.join(out, 'resources/codex/manifest.json'), attempt.snapshot);
  const asar = createRequire(path.join(ROOT, 'package.json'))('@electron/asar');
  const { entries, metadata } = readArchiveInventory(archive, asar);
  validateArchive(attempt.snapshot, entries, metadata);
  need(isDeepStrictEqual(readFile(archive), archivePin), 'ASAR_CHANGED');
  removeStockElectronFiles(out, attempt.snapshot.stock);
  const resourceRows = inspect(path.join(out, 'resources'), [{ path: 'app.asar', ...archivePin }, ...attempt.snapshot.resources.map(r => ({ ...r, path: r.path.slice('resources/'.length) }))]);
  // Electron runtime names are closed by its installed distribution; app executable is builder-transformed.
  const files = inspect(out, [...copied.filter(r => !r.path.startsWith('resources/') && !STOCK_ELECTRON_FILES.includes(r.path)), ...resourceRows.map(r => ({ ...r, path: 'resources/' + r.path }))]);
  sameSource(attempt.snapshot); attempt.post = { files, resources: resourceRows.map(r => ({ ...r, path: 'resources/' + r.path })), archive: archivePin };
}
export async function afterSign(context) {
  const out = contextPath(context), attempt = attempts.get(out); need(attempt?.post && !attempt.finalized && !attempt.completed, 'MISSING_OR_REUSED_POSTPACK');
  validateEffectiveConfiguration(context.packager.config, attempt.snapshot.pkg); sameSource(attempt.snapshot);
  // With signExecutable:false, builder still edits the app's PE resources and emits afterSign.
  const files = inspect(out, attempt.post.files.map(r => r.path === 'ForgeDesk.exe' ? { path: r.path } : r));
  need(files.some(r => r.path === 'ForgeDesk.exe' && r.bytes > 0), 'FINAL_EXECUTABLE');
  inspect(out, files); sameSource(attempt.snapshot); attempt.finalized = { files };
}
function exact(value, keys) { need(value && Object.getPrototypeOf(value) === Object.prototype && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), 'RECEIPT_SCHEMA'); }
export function validateReleaseManifest(value) {
  exact(value, ['schema', 'version', 'appId', 'sourceFreeze', 'artifacts', 'unpacked', 'resources', 'bundles', 'qualification']);
  need(value.schema === 'forgedesk-release-package-audit-v1' && value.version === VERSION && value.appId === APP_ID, 'RECEIPT_IDENTITY');
  exact(value.sourceFreeze, ['packageSha256', 'lockSha256', 'auditSourceSha256', 'buildSourceSha256', 'assetApproval', 'resourceManifestPins', 'resourceTransforms']);
  exact(value.sourceFreeze.assetApproval, ['path', 'sha256']); need(isDeepStrictEqual(value.sourceFreeze.assetApproval, ASSET_APPROVAL), 'RECEIPT_ASSET_APPROVAL');
  for (const key of ['packageSha256', 'lockSha256', 'auditSourceSha256', 'buildSourceSha256']) need(hex(value.sourceFreeze[key]), 'RECEIPT_PIN');
  need(Array.isArray(value.sourceFreeze.resourceManifestPins) && value.sourceFreeze.resourceManifestPins.length === RESOURCE_SPECS.filter(s => s.manifest).length, 'RECEIPT_RESOURCE_PINS');
  for (const spec of RESOURCE_SPECS.filter(s => s.manifest)) need(value.sourceFreeze.resourceManifestPins.some(p =>
    p.path === spec.from + '/' + spec.manifest && hex(p.sha256) && (!spec.pin || p.sha256 === spec.pin)), 'RECEIPT_RESOURCE_PIN');
  for (const pin of value.sourceFreeze.resourceManifestPins) exact(pin, ['path', 'sha256']);
  need(Array.isArray(value.sourceFreeze.resourceTransforms) && value.sourceFreeze.resourceTransforms.length === 1, 'RECEIPT_TRANSFORM');
  const transform = value.sourceFreeze.resourceTransforms[0]; exact(transform, ['path', 'method', 'sourceSha256', 'packagedSha256']);
  need(transform.path === 'resources/codex/manifest.json' && transform.method === 'codex-public-source-only-v1' && transform.sourceSha256 === RESOURCE_SPECS[0].pin && transform.packagedSha256 === CODEX_PACKAGED_MANIFEST_SHA256, 'RECEIPT_TRANSFORM_PIN');
  const rows = (input, prefix) => { need(Array.isArray(input) && input.length > 0 && input.length <= 10000, 'RECEIPT_ROWS');
    const seen = new Set(); for (const row of input) { exact(row, ['path', 'bytes', 'sha256']); relative(row.path); need(row.path.startsWith(prefix) && !seen.has(row.path.toLowerCase()) &&
      Number.isSafeInteger(row.bytes) && row.bytes >= 0 && hex(row.sha256), 'RECEIPT_ROW'); seen.add(row.path.toLowerCase()); } };
  exact(value.unpacked, ['path', 'files']); need(value.unpacked.path === 'release/win-unpacked', 'RECEIPT_OUTPUT'); rows(value.unpacked.files, ''); rows(value.resources, 'resources/'); rows(value.bundles, 'dist/');
  need(isDeepStrictEqual(sorted(value.resources), sorted(value.unpacked.files.filter(r => r.path.startsWith('resources/')))), 'RECEIPT_RESOURCE_SUBSET');
  need(isDeepStrictEqual(value.unpacked.files.filter(r => !r.path.startsWith('resources/')).map(r => r.path).sort(), RUNTIME_FILES), 'RECEIPT_RUNTIME_INVENTORY');
  for (const required of ['ForgeDesk.exe', 'resources/app.asar']) need(value.unpacked.files.some(r => r.path === required && r.bytes > 0), 'RECEIPT_REQUIRED_FILE');
  for (const spec of RESOURCE_SPECS) need(value.resources.some(r => r.path === 'resources/' + spec.to || r.path.startsWith('resources/' + spec.to + '/')), 'RECEIPT_REQUIRED_RESOURCE');
  for (const row of value.resources) need(row.path === 'resources/app.asar' || RESOURCE_SPECS.some(spec => spec.single ? row.path === 'resources/' + spec.to : row.path.startsWith('resources/' + spec.to + '/')), 'RECEIPT_UNLISTED_RESOURCE');
  for (const spec of RESOURCE_SPECS.filter(s => s.generated)) { const generated = value.resources.find(r => r.path === 'resources/' + spec.to);
    need(generated?.bytes > 0 && generated.bytes <= 16777216, 'RECEIPT_GENERATED_BOUND'); }
  const packagedCodex = value.resources.find(r => r.path === transform.path);
  need(packagedCodex?.sha256 === transform.packagedSha256 && packagedCodex.bytes === CODEX_PACKAGED_MANIFEST_BYTES, 'RECEIPT_TRANSFORM_RESOURCE');
  need(isDeepStrictEqual(value.bundles.map(r => r.path).sort(), PACKAGED_FILES.filter(p => p !== 'package.json')), 'RECEIPT_BUNDLES');
  rows(value.artifacts, 'release/'); need(value.artifacts.length === 1 && value.artifacts[0].path === 'release/ForgeDesk-1.0.0-x64-setup.exe' && value.artifacts[0].bytes > 0, 'RECEIPT_ARTIFACT');
  exact(value.qualification, ['packageInventoryVerified', 'installationVerified', 'softwareAccepted', 'deviceQualified', 'releaseAuthorized']);
  need(value.qualification.packageInventoryVerified === true && ['installationVerified', 'softwareAccepted', 'deviceQualified', 'releaseAuthorized'].every(k => value.qualification[k] === false), 'RECEIPT_AUTHORITY'); return value;
}
export async function afterAllArtifactBuild(context) {
  need(ROOT, 'CONTEXT');
  const out = path.join(ROOT, 'release', 'win-unpacked'), attempt = attempts.get(out); need(attempt?.finalized && !attempt.completed, 'MISSING_OR_REUSED_FINALIZATION');
  const artifact = path.join(ROOT, 'release', 'ForgeDesk-1.0.0-x64-setup.exe');
  need(Array.isArray(context.artifactPaths) && context.artifactPaths.map(p => path.resolve(p)).includes(artifact), 'INSTALLER_ARTIFACT');
  sameSource(attempt.snapshot); const files = inspect(out, attempt.finalized.files); const installer = readFile(artifact);
  const receipt = validateReleaseManifest({ schema: 'forgedesk-release-package-audit-v1', version: VERSION, appId: APP_ID, sourceFreeze: attempt.snapshot.sourceFreeze,
    artifacts: [{ path: 'release/ForgeDesk-1.0.0-x64-setup.exe', ...installer }], unpacked: { path: 'release/win-unpacked', files },
    resources: attempt.post.resources, bundles: attempt.snapshot.bundles,
    qualification: { packageInventoryVerified: true, installationVerified: false, softwareAccepted: false, deviceQualified: false, releaseAuthorized: false } });
  attempt.completed = true; writeReport('RELEASE_MANIFEST.json', receipt); return [];
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  need(process.argv.length === 3 && process.argv[2] === 'preflight', 'CLI');
  preflight()
    .catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 2; });
}
