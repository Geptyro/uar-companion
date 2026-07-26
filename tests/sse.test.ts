import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { consumeSSE } from '../src/core/sse.ts';

test('parses events across chunk boundaries, skipping comments and retry', async () => {
	const server = createServer((_req, res) => {
		res.setHeader('content-type', 'text/event-stream');
		res.write('retry: 3000\n\n');
		res.write(': ping\n\n');
		res.write('event: cha'); // split mid-line
		setTimeout(() => {
			res.write('nge\ndata: {}\n\n');
			res.write('data: plain message\n\n');
			res.write('event: change\ndata: {"a":1}\ndata: {"b":2}\n\n');
			res.end();
		}, 30);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	const events: [string, string][] = [];
	try {
		await consumeSSE(url, (name, data) => events.push([name, data]));
	} finally {
		server.close();
	}
	assert.deepEqual(events, [
		['change', '{}'],
		['message', 'plain message'],
		['change', '{"a":1}\n{"b":2}']
	]);
});

test('rejects non-SSE responses and honors abort', async () => {
	const server = createServer((req, res) => {
		if (req.url === '/json') {
			res.setHeader('content-type', 'application/json');
			res.end('{}');
			return;
		}
		res.setHeader('content-type', 'text/event-stream');
		res.write('retry: 3000\n\n'); // then hold the connection open
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

	try {
		await assert.rejects(() => consumeSSE(`${url}/json`, () => {}), /not an event stream/);
		const ctl = new AbortController();
		setTimeout(() => ctl.abort(), 50);
		await assert.rejects(
			() => consumeSSE(url, () => {}, { signal: ctl.signal }),
			(e: Error) => e.name === 'AbortError'
		);
	} finally {
		server.close();
	}
});
