import { lstatSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_ROOTS = Object.freeze(['apps', 'packages', 'tests']);
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const excluded = new Set(['output', 'vendor', '.runtime', '.test-output', 'node_modules', '.git']);
const testName = /\.test\.(?:ts|tsx|mjs)$/;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Enumerate only source test roots; directory/file links are never followed. */
export function discoverTestFiles(root = REPO_ROOT, fs = { lstatSync, readdirSync }) {
  const base = path.resolve(root), files = [];
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort(order)) {
      if (excluded.has(name.toLowerCase())) continue;
      const filename = path.join(directory, name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) continue;
      const next = relative + '/' + name;
      if (stat.isDirectory()) visit(filename, next);
      else if (stat.isFile() && testName.test(name)) files.push(next);
    }
  };
  const baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw Error('Test repository must be a real directory.');
  for (const relative of TEST_ROOTS) {
    let current = base;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Test root must be a real directory: ' + relative);
    }
    visit(current, relative);
  }
  if (files.length === 0) throw Error('No source test files were discovered.');
  return files.sort(order);
}

export function parseArguments(argv) {
  let concurrency = 1, supplied = false;
  for (let i = 0; i < argv.length; i++) {
    let value;
    if (argv[i] === '--test-concurrency') value = argv[++i];
    else if (argv[i].startsWith('--test-concurrency=')) value = argv[i].slice('--test-concurrency='.length);
    else throw Error('Unsupported test argument: ' + argv[i]);
    if (supplied || typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw Error('Specify --test-concurrency once with a positive integer.');
    }
    concurrency = Number(value); supplied = true;
  }
  return { concurrency };
}

/** One Node test run preserves one TAP stream and each test's own timeout. */
export function runTests(files, { concurrency = 1, root = REPO_ROOT } = {}, ports = {}) {
  if (!files.length || !Number.isSafeInteger(concurrency) || concurrency < 1) throw Error('Invalid test run.');
  const launch = ports.spawn ?? spawn, signals = ports.signals ?? process;
  const executable = ports.execPath ?? process.execPath;
  const reportError = ports.reportError ?? (message => process.stderr.write(message + '\n'));
  return new Promise(resolve => {
    let child, cancelled = null, forced = false, failed = false, finished = false;
    const codeForSignal = signal => signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    const forward = signal => {
      if (finished) return;
      const first = cancelled === null;
      if (first) cancelled = signal;
      else if (forced) return;
      if (!first) forced = true;
      if (child?.pid) {
        try { child.kill(first ? signal : 'SIGKILL'); } catch (error) { reportError('Cannot signal test child: ' + error.message); }
      }
    };
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    const finish = (code, signal) => {
      if (finished) return; finished = true;
      signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', terminate);
      resolve(cancelled ? codeForSignal(cancelled) : failed ? 1 : Number.isInteger(code) && code >= 0 ? code : codeForSignal(signal));
    };
    try {
      child = launch(executable, ['--import', 'tsx', '--test', '--test-concurrency=' + concurrency,
        ...files.map(file => path.resolve(root, file))], { cwd: root, shell: false, stdio: 'inherit' });
      signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate);
      child.once('error', error => { failed = true; reportError('Cannot launch tests: ' + error.message); });
      child.once('close', finish);
    } catch (error) { failed = true; reportError('Cannot launch tests: ' + error.message); finish(1, null); }
  });
}

export async function main(argv) {
  const options = parseArguments(argv);
  return runTests(discoverTestFiles(), options);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(error.message + '\n'); process.exitCode = 1;
  });
}
