import { writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [inputRoot, outputRoot, privateRoot, templateRoot, nonce] = process.argv.slice(2);
if (!inputRoot || !outputRoot || !privateRoot || !templateRoot || !nonce) throw new Error('Sandbox probe arguments are required');
const marker = '.runner-os-probe-' + nonce;
function errorCode(error) { return typeof error?.code === 'string' ? error.code : 'UNKNOWN'; }
function inspect(files) {
  const present = [];
  let inspectionErrorCode = null;
  for (const filename of files) {
    try { present.push({ filename, regular: lstatSync(filename).isFile() }); }
    catch (error) { if (error?.code !== 'ENOENT') inspectionErrorCode ??= errorCode(error); }
  }
  return { present, inspectionErrorCode };
}
function clean(files, observed) {
  let cleanupErrorCode = null;
  if (observed.inspectionErrorCode) return { cleanupComplete: false, cleanupErrorCode: null };
  for (const file of observed.present) {
    if (!file.regular) { cleanupErrorCode ??= 'UNSUPPORTED_FILE_TYPE'; continue; }
    try { unlinkSync(file.filename); }
    catch (error) { if (error?.code !== 'ENOENT') cleanupErrorCode ??= errorCode(error); }
  }
  const after = inspect(files);
  return { cleanupComplete: !cleanupErrorCode && !after.inspectionErrorCode && after.present.length === 0,
    cleanupErrorCode: cleanupErrorCode ?? after.inspectionErrorCode };
}
function fsProbe(root) {
  const files = [path.join(root, marker)];
  const before = inspect(files);
  const facts = { preexisting: before.present.length !== 0, created: false, writeSucceeded: false,
    writeErrorCode: null, inspectionErrorCode: before.inspectionErrorCode, cleanupComplete: false, cleanupErrorCode: null };
  if (facts.preexisting || facts.inspectionErrorCode) return facts;
  try { writeFileSync(files[0], 'probe', { flag: 'wx' }); facts.writeSucceeded = true; }
  catch (error) { facts.writeErrorCode = errorCode(error); }
  const observed = inspect(files);
  facts.created = observed.present.length !== 0;
  facts.inspectionErrorCode = observed.inspectionErrorCode;
  Object.assign(facts, clean(files, observed));
  return facts;
}
function sqliteProbe(root) {
  const filename = path.join(root, marker + '.db');
  const files = [filename, filename + '-journal', filename + '-wal', filename + '-shm'];
  const before = inspect(files);
  const facts = { preexisting: before.present.length !== 0, created: false, opened: false, writeSucceeded: false,
    closeSucceeded: false, openErrorCode: null, writeErrorCode: null, closeErrorCode: null,
    inspectionErrorCode: before.inspectionErrorCode, cleanupComplete: false, cleanupErrorCode: null };
  if (facts.preexisting || facts.inspectionErrorCode) return facts;
  let db;
  try { db = new DatabaseSync(process.platform === 'win32' ? path.toNamespacedPath(filename) : filename); facts.opened = true; }
  catch (error) { facts.openErrorCode = errorCode(error); }
  if (db) {
    try { db.exec('CREATE TABLE probe (id INTEGER)'); facts.writeSucceeded = true; }
    catch (error) { facts.writeErrorCode = errorCode(error); }
    try { db.close(); facts.closeSucceeded = true; }
    catch (error) { facts.closeErrorCode = errorCode(error); }
  }
  const observed = inspect(files);
  facts.created = observed.present.length !== 0;
  facts.inspectionErrorCode = observed.inspectionErrorCode;
  Object.assign(facts, clean(files, observed));
  return facts;
}
function fsDenied(facts) {
  return !facts.preexisting && !facts.created && !facts.writeSucceeded && !facts.inspectionErrorCode && facts.cleanupComplete &&
    ['EACCES', 'EPERM'].includes(facts.writeErrorCode);
}
function sqliteDenied(facts) {
  return !facts.preexisting && !facts.created && !facts.opened && !facts.inspectionErrorCode && facts.cleanupComplete &&
    ['EACCES', 'EPERM', 'ERR_SQLITE_ERROR'].includes(facts.openErrorCode);
}
const facts = { inputFs: fsProbe(inputRoot), privateFs: fsProbe(privateRoot), templateFs: fsProbe(templateRoot),
  inputSqlite: sqliteProbe(inputRoot), outputFs: fsProbe(outputRoot), outputSqlite: sqliteProbe(outputRoot) };
const inputWriteDenied = fsDenied(facts.inputFs);
const privateWriteDenied = fsDenied(facts.privateFs);
const templateWriteDenied = fsDenied(facts.templateFs);
const sqliteInputWriteDenied = sqliteDenied(facts.inputSqlite);
const outputWriteAllowed = facts.outputFs.created && facts.outputFs.writeSucceeded && !facts.outputFs.inspectionErrorCode && facts.outputFs.cleanupComplete;
const sqliteOutputWriteAllowed = facts.outputSqlite.created && facts.outputSqlite.opened && facts.outputSqlite.writeSucceeded &&
  facts.outputSqlite.closeSucceeded && !facts.outputSqlite.inspectionErrorCode && facts.outputSqlite.cleanupComplete;
const passed = inputWriteDenied && privateWriteDenied && templateWriteDenied && sqliteInputWriteDenied && outputWriteAllowed && sqliteOutputWriteAllowed;
console.log('FORGEDESK_SANDBOX_RECEIPT:' + JSON.stringify({ schemaVersion: 1, nonce, inputWriteDenied, privateWriteDenied,
  templateWriteDenied, sqliteInputWriteDenied, outputWriteAllowed, sqliteOutputWriteAllowed, facts, passed }));
if (!passed) process.exitCode = 1;
