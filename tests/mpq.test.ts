import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUARReplay } from '../src/core/sniff.ts';

test('sniff recognizes UAR fixtures', () => {
	for (const name of ['20260723-1802.SC2Replay', '20260723-1808.SC2Replay']) {
		const data = readFileSync(new URL(`../testdata/${name}`, import.meta.url));
		assert.equal(isUARReplay(data), true, `${name}: expected UAR title to be found`);
	}
});

test('sniff rejects junk', () => {
	assert.throws(() => isUARReplay(Buffer.from('this is definitely not an MPQ archive')));
	assert.throws(() => isUARReplay(Buffer.alloc(0)));
	// truncated real replay: valid magic, tables point past the end
	const data = readFileSync(new URL('../testdata/20260723-1808.SC2Replay', import.meta.url));
	assert.throws(() => isUARReplay(data.subarray(0, 200)));
});
