import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../src/core/upload.ts';
import { Store } from '../src/core/state.ts';
import { Watcher, type WatcherConfig } from '../src/core/watcher.ts';

const FIXTURE = fileURLToPath(new URL('../testdata/20260723-1808.SC2Replay', import.meta.url));

function replayDir(files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-edge-'));
	const old = new Date(Date.now() - 60_000);
	for (const name of files) {
		const p = join(dir, name);
		copyFileSync(FIXTURE, p);
		utimesSync(p, old, old);
	}
	return dir;
}

function fakeServer(
	respond: (n: number) => { status: number; body: string }
): Promise<{ server: Server; url: string; posts: () => number }> {
	let posts = 0;
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			res.setHeader('content-type', 'application/json');
			if (req.method === 'GET') {
				res.end('{"exists":false}');
				return;
			}
			req.resume();
			req.on('end', () => {
				posts++;
				const out = respond(posts);
				res.statusCode = out.status;
				res.end(out.body);
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
			resolve({ server, url, posts: () => posts });
		});
	});
}

async function run(dir: string, url: string, extra: Partial<WatcherConfig> = {}) {
	const stateDir = join(dir, 'state');
	const w = new Watcher(
		{ dirs: [dir], once: true, postSpacing: 1, ...extra },
		new Client(url, 'test'),
		new Store(stateDir)
	);
	await w.run();
	return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
}

test('429 backs off, then retries and succeeds', async () => {
	const dir = replayDir(['Undead Assault reborn.SC2Replay']);
	const { server, url, posts } = await fakeServer((n) =>
		n === 1
			? { status: 429, body: '{"message":"Too many uploads"}' }
			: { status: 200, body: '{"ok":true,"message":"accepted"}' }
	);
	try {
		const state = await run(dir, url, { rateLimitBackoff: 50 });
		assert.equal(posts(), 2, 'retried after the backoff');
		const rec = Object.values(state.files)[0] as { status: string; reason: string };
		assert.equal(rec.status, 'done');
		assert.equal(rec.reason, 'uploaded');
		assert.ok(
			state.history.some((h: { kind: string }) => h.kind === 'waiting'),
			'rate-limit wait is visible in the activity feed'
		);
	} finally {
		server.close();
	}
});

test('409 duplicate is terminal success', async () => {
	const dir = replayDir(['Undead Assault reborn.SC2Replay']);
	const { server, url, posts } = await fakeServer(() => ({
		status: 409,
		body: '{"message":"This game is already ingested."}'
	}));
	try {
		const state = await run(dir, url);
		assert.equal(posts(), 1);
		const rec = Object.values(state.files)[0] as { status: string; reason: string };
		assert.equal(rec.status, 'done');
		assert.match(rec.reason, /already ingested/);
	} finally {
		server.close();
	}
});

test('no-backfill skips pre-existing replays without touching the network', async () => {
	const dir = replayDir(['Undead Assault reborn.SC2Replay']);
	const { server, url, posts } = await fakeServer(() => ({ status: 200, body: '{"ok":true}' }));
	try {
		const state = await run(dir, url, { noBackfill: true });
		assert.equal(posts(), 0);
		const rec = Object.values(state.files)[0] as { status: string; reason: string };
		assert.equal(rec.status, 'skip');
		assert.match(rec.reason, /backfill disabled/);
	} finally {
		server.close();
	}
});

test('identical copies upload once, the twin is skipped by sha', async () => {
	const dir = replayDir(['Undead Assault reborn.SC2Replay', 'Undead Assault reborn (2).SC2Replay']);
	const { server, url, posts } = await fakeServer(() => ({
		status: 200,
		body: '{"ok":true,"message":"accepted"}'
	}));
	try {
		const state = await run(dir, url);
		assert.equal(posts(), 1, 'only one of the two identical files is uploaded');
		const reasons = Object.values(state.files).map((r) => (r as { reason: string }).reason);
		assert.ok(reasons.includes('uploaded'));
		assert.ok(reasons.includes('identical file already queued'));
	} finally {
		server.close();
	}
});

test('oversized file is skipped before any network call', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-edge-'));
	const big = join(dir, 'Undead Assault reborn.SC2Replay');
	writeFileSync(big, Buffer.alloc(17 * 1024 * 1024));
	const old = new Date(Date.now() - 60_000);
	utimesSync(big, old, old);
	const { server, url, posts } = await fakeServer(() => ({ status: 200, body: '{"ok":true}' }));
	try {
		const state = await run(dir, url);
		assert.equal(posts(), 0);
		const rec = Object.values(state.files)[0] as { status: string; reason: string };
		assert.equal(rec.status, 'skip');
		assert.match(rec.reason, /16 MB/);
	} finally {
		server.close();
	}
});

/**
 * A replay used to wait for the next 30 s sweep. The directories are under an
 * fs.watch now, so a finished game is noticed as it lands — which is also what
 * lets the fallback sweep drop to five minutes and stop dragging every replay
 * folder through Defender (and OneDrive) twice a minute.
 */
test('a replay dropped in is picked up from the watch, not the sweep', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'uar-companion-watch-'));
	const { server, url, posts } = await fakeServer(() => ({
		status: 200,
		body: '{"ok":true,"message":"accepted"}'
	}));
	const abort = new AbortController();
	const w = new Watcher(
		{ dirs: [dir], postSpacing: 1, settleAge: 40 },
		new Client(url, 'test'),
		new Store(join(dir, 'state'))
	);
	const uploaded = new Promise<void>((resolve) =>
		w.on('event', (e: { kind: string }) => {
			if (e.kind === 'uploaded') resolve();
		})
	);
	try {
		const started = Date.now();
		const loop = w.run(abort.signal);
		// let the first sweep find an empty folder and settle into its long idle
		await new Promise((r) => setTimeout(r, 100));
		copyFileSync(FIXTURE, join(dir, 'Undead Assault reborn.SC2Replay'));
		await uploaded;
		// the idle it cut short was IDLE_SCAN_INTERVAL — five whole minutes
		assert.ok(Date.now() - started < 10_000, 'did not wait for a sweep');
		assert.equal(posts(), 1);
		abort.abort();
		await loop;
	} finally {
		server.close();
	}
});
