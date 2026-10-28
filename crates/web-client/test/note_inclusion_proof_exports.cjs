const assert = require('node:assert/strict');

const sdk = require(process.argv[2]);
const testingEnabled = process.argv[3] === 'testing';

assert.equal(typeof sdk.NoteInclusionProof, 'function');
if (testingEnabled) {
  assert.equal(typeof sdk.NoteInclusionProof.mockAtBlock, 'function');
  assert.ok(sdk.NoteInclusionProof.mockAtBlock(0));
} else {
  assert.equal(sdk.NoteInclusionProof.mockAtBlock, undefined);
}
