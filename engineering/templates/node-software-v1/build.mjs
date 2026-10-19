import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [inputRoot, outputRoot, nonce] = process.argv.slice(2);
if (!inputRoot || !outputRoot || !nonce) throw new Error('Fixed snapshot build arguments are required');
const source = readFileSync(path.join(inputRoot, 'numbers.mjs'));
writeFileSync(path.join(outputRoot, 'numbers.mjs'), source, { flag: 'wx' });
console.log('FORGEDESK_BUILD_RECEIPT:' + JSON.stringify({ schemaVersion: 1, nonce, artifact: 'numbers.mjs', sha256: createHash('sha256').update(source).digest('hex') }));
