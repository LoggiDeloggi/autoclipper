const assert = require('assert');
const { snap } = require('./pipeline');

const segs = [
  { start: 0, end: 4.2, text: 'a' },
  { start: 4.2, end: 9.8, text: 'b' },
  { start: 9.8, end: 30, text: 'c' },
];

// LLM times land mid-sentence -> snapped to segment edges
assert.deepStrictEqual(snap({ start: 5, end: 29 }, segs), { start: 4.2, end: 30 });

console.log('ok');
