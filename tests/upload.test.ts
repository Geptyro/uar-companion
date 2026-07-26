import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client } from '../src/core/upload.ts';

function serve(
	handler: (req: import('node:http').IncomingMessage, body: Buffer) => { status: number; body: string }
): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				const out = handler(req, Buffer.concat(chunks));
				res.statusCode = out.status;
				res.setHeader('content-type', 'application/json');
				res.end(out.body);
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			resolve({ server, url: `http://127.0.0.1:${addr.port}` });
		});
	});
}

test('exists passes the sha and reads the answer', async () => {
	let gotUrl = '';
	const { server, url } = await serve((req) => {
		gotUrl = req.url ?? '';
		return { status: 200, body: '{"exists":true}' };
	});
	try {
		assert.equal(await new Client(url, 'test').exists('abc123'), true);
		assert.equal(gotUrl, '/api/replays?sha256=abc123');
	} finally {
		server.close();
	}
});

test('upload maps statuses to outcomes', async () => {
	const cases: [number, string, string][] = [
		[200, '{"ok":true,"message":"Replay accepted — profiles are live now."}', 'accepted'],
		[409, '{"message":"This exact replay file is already ingested."}', 'duplicate'],
		[429, '{"message":"Too many uploads — try again later."}', 'ratelimited'],
		[400, '{"message":"Not a readable StarCraft II replay."}', 'rejected'],
		[413, '{"message":"Replay too large."}', 'rejected'],
		[500, 'boom', 'transient']
	];
	for (const [status, body, want] of cases) {
		let gotBody: Buffer = Buffer.alloc(0);
		let contentType = '';
		const { server, url } = await serve((req, reqBody) => {
			gotBody = reqBody;
			contentType = String(req.headers['content-type']);
			return { status, body };
		});
		try {
			const out = await new Client(url, 'test').upload('x.SC2Replay', Buffer.from('replaydata'));
			assert.equal(out.kind, want, `status ${status}`);
			assert.match(contentType, /^multipart\/form-data/);
			assert.ok(gotBody.includes(Buffer.from('name="replay"')), 'multipart field name');
			assert.ok(gotBody.includes(Buffer.from('replaydata')), 'file bytes present');
			if (status === 400) assert.equal(out.message, 'Not a readable StarCraft II replay.');
		} finally {
			server.close();
		}
	}
});

test('ready returns count, battletags and expiries', async () => {
	const { server, url } = await serve(() => ({
		status: 200,
		body: '{"me":false,"until":null,"players":[{"battletag":"Foo#123","until":"2026-01-01T01:00:00Z"},{"battletag":"Bar#456","until":"2026-01-01T02:00:00Z"}]}'
	}));
	try {
		const r = await new Client(url, 'test').ready();
		assert.deepEqual(r, {
			count: 2,
			names: ['Foo#123', 'Bar#456'],
			players: [
				{ battletag: 'Foo#123', until: '2026-01-01T01:00:00Z' },
				{ battletag: 'Bar#456', until: '2026-01-01T02:00:00Z' }
			]
		});
	} finally {
		server.close();
	}
});
