import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('Project root argument required');
const { average } = await import(pathToFileURL(path.join(projectRoot, 'numbers.mjs')).href);
assert.equal(average([]), 0, 'Empty input must return zero');
assert.equal(average([2, 4, 6]), 4, 'Nonempty mean must be correct');
assert.equal(average([-2, 2]), 0, 'Signed values must be supported');
console.log('Trusted acceptance: 3 checks passed');
