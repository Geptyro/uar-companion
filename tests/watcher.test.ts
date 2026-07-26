import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../src/core/upload.ts';
import { Store } from '../src/core/state.ts';
import { Watcher } from '../src/core/watcher.ts';

// A fresh install finds a whole replay history at once: the queue has to
// drain in one pass, one upload after another. Before, each scan uploaded a
// single file, so 200 past games would have trickled out over 100 minutes.
test('drains a backlog in one pass, one upload at a time', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-backlog-'));
	const old = new Date(Date.now() - 60_000);
	for (const f of ['20260723-1802.SC2Replay', '20260723-1808.SC2Replay']) {
		const target = join(dir, f);
		copyFileSync(fileURLToPath(new URL(`../testdata/${f}`, import.meta.url)), target);
		utimesSync(target, old, old);
	}

	let posts = 0;
	let concurrent = 0;
	let maxConcurrent = 0;
	const server = createServer((req, res) => {
		res.setHeader('content-type', 'application/json');
		if (req.method === 'GET') {
			res.end('{"exists":false}');
			return;
		}
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		req.resume();
		req.on('end', () => {
			posts++;
			setTimeout(() => {
				concurrent--;
				res.end('{"ok":true,"message":"accepted"}');
			}, 30);
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	try {
		const started = Date.now();
		const w = new Watcher(
			{ dirs: [dir], once: true, postSpacing: 10 },
			new Client(url, 'test'),
			new Store(join(dir, 'cfg'))
		);
		await w.run();
		assert.equal(posts, 2, 'both replays uploaded');
		assert.equal(maxConcurrent, 1, 'never more than one upload in flight');
		// one per 30s scan would blow past this by far
		assert.ok(Date.now() - started < 10_000, 'drained without waiting for another scan');
	} finally {
		server.close();
	}
});

// Full pipeline against a fake server: settle detection, MPQ sniff, sha
// pre-check, upload, state record, restart idempotence.
test('watcher once-mode pipeline', async () => {
	const fixture = fileURLToPath(new URL('../testdata/20260723-1808.SC2Replay', import.meta.url));
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-test-'));
	const replay = join(dir, 'Undead Assault reborn.SC2Replay');
	const junk = join(dir, 'Other Map.SC2Replay');
	copyFileSync(fixture, replay);
	writeFileSync(junk, 'not a real replay');
	const old = new Date(Date.now() - 60_000);
	utimesSync(replay, old, old);
	utimesSync(junk, old, old);

	let posts = 0;
	const server = createServer((req, res) => {
		res.setHeader('content-type', 'application/json');
		if (req.method === 'GET') {
			res.end('{"exists":false}');
			return;
		}
		req.resume();
		req.on('end', () => {
			posts++;
			res.end('{"ok":true,"message":"accepted"}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	try {
		const cfg = { dirs: [dir], once: true, postSpacing: 1 };
		const stateDir = join(dir, 'cfg');
		await new Watcher(cfg, new Client(url, 'test'), new Store(stateDir)).run();

		assert.equal(posts, 1, 'exactly one upload POST');
		const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
		assert.equal(state.files[replay]?.status, 'done');
		assert.equal(state.files[replay]?.reason, 'uploaded');
		assert.equal(state.files[junk]?.status, 'skip');
		assert.ok(state.history.some((h: { kind: string }) => h.kind === 'uploaded'));

		// second run: nothing new, no further posts
		await new Watcher(cfg, new Client(url, 'test'), new Store(stateDir)).run();
		assert.equal(posts, 1, 're-run must not re-upload');
	} finally {
		server.close();
	}
});
