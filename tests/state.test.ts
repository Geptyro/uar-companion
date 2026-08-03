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

/**
 * Games the site wrongly called unreadable while it was busy. Forgetting the
 * record is what re-offers them, since `scan` skips any path the store knows.
 */
const BUSY = 'rejected: Not a readable StarCraft II replay.';

function seed(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-state-'));
	writeFileSync(join(dir, 'state.json'), JSON.stringify({ files, history: [] }));
	return dir;
}

test('games rejected by a busy site are offered again', () => {
	const dir = seed({
		'/x/busy.SC2Replay': { status: 'skip', sha: 'a', reason: BUSY, at: '2026-08-03' }
	});
	const s = new Store(dir);
	assert.equal(s.files['/x/busy.SC2Replay'], undefined, 'the record must be gone, not kept');
	assert.equal(s.revived, 1);
});

test('verdicts that were really about the file keep their skip', () => {
	const dir = seed({
		'/x/wrongmap.SC2Replay': {
			status: 'skip',
			reason: 'rejected: Not an Undead Assault Reborn replay (map: "Ladder")',
			at: '2026-08-03'
		},
		'/x/toobig.SC2Replay': {
			status: 'skip',
			reason: 'larger than the 16 MB upload limit',
			at: '2026-08-03'
		},
		'/x/uploaded.SC2Replay': { status: 'done', reason: 'uploaded', at: '2026-08-03' }
	});
	const s = new Store(dir);
	assert.equal(s.revived, 0);
	assert.equal(Object.keys(s.files).length, 3, 'nothing else may be disturbed');
});

test('the retry happens once, not on every launch', () => {
	// otherwise a file that really is unreadable earns the same record on its
	// retry and would be re-offered forever
	const dir = seed({
		'/x/busy.SC2Replay': { status: 'skip', reason: BUSY, at: '2026-08-03' }
	});
	assert.equal(new Store(dir).revived, 1);

	const second = new Store(dir);
	second.record('/x/busy.SC2Replay', 'skip', 'a', BUSY); // rejected again, genuinely
	const third = new Store(dir);
	assert.equal(third.revived, 0, 'the second launch must not free it again');
	assert.equal(third.files['/x/busy.SC2Replay'].status, 'skip');
});

test('corrupted state file starts fresh instead of crashing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-state-'));
	writeFileSync(join(dir, 'state.json'), '{not json');
	const s = new Store(dir);
	assert.deepEqual(s.files, {});
	assert.deepEqual(s.history, []);
});
