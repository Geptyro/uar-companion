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
