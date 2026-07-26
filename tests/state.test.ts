import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/state.ts';

test('records and history survive a reload', () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-state-'));
	const a = new Store(dir);
	a.record('/x/one.SC2Replay', 'done', 'abc', 'uploaded');
	a.addHistory('one.SC2Replay', 'uploaded', 'ok');

	const b = new Store(dir);
	assert.equal(b.files['/x/one.SC2Replay'].status, 'done');
	assert.equal(b.files['/x/one.SC2Replay'].sha, 'abc');
	assert.equal(b.history[0].kind, 'uploaded');
});

test('history is capped at 200, newest first', () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-state-'));
	const s = new Store(dir);
	for (let i = 0; i < 210; i++) s.addHistory(`f${i}`, 'queued');
	assert.equal(s.history.length, 200);
	assert.equal(s.history[0].file, 'f209');
	assert.equal(new Store(dir).history.length, 200);
});

test('corrupted state file starts fresh instead of crashing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-state-'));
	writeFileSync(join(dir, 'state.json'), '{not json');
	const s = new Store(dir);
	assert.deepEqual(s.files, {});
	assert.deepEqual(s.history, []);
});
