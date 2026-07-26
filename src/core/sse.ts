/**
 * Minimal Server-Sent-Events reader over fetch streaming — Node has no
 * stable EventSource, and this is ~50 lines without a dependency. Calls
 * onEvent for every event (name defaults to 'message'); resolves when the
 * server ends the stream, throws on connection errors or abort. Reconnect
 * policy is the caller's job.
 */
export async function consumeSSE(
	url: string,
	onEvent: (name: string, data: string) => void,
	opts?: { signal?: AbortSignal; headers?: Record<string, string> }
): Promise<void> {
	const resp = await fetch(url, {
		headers: { accept: 'text/event-stream', ...opts?.headers },
		signal: opts?.signal
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const type = resp.headers.get('content-type') ?? '';
	if (!type.includes('text/event-stream')) throw new Error(`not an event stream: ${type}`);
	if (!resp.body) throw new Error('no response body');

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let event = '';
	let data: string[] = [];
	const dispatch = () => {
		if (data.length > 0) onEvent(event || 'message', data.join('\n'));
		event = '';
		data = [];
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			let line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			if (line === '') {
				dispatch();
				continue;
			}
			if (line.startsWith(':')) continue; // comment / keep-alive ping
			const colon = line.indexOf(':');
			const field = colon < 0 ? line : line.slice(0, colon);
			let value2 = colon < 0 ? '' : line.slice(colon + 1);
			if (value2.startsWith(' ')) value2 = value2.slice(1);
			if (field === 'event') event = value2;
			else if (field === 'data') data.push(value2);
			// 'id' and 'retry' are irrelevant for our notification-only stream
		}
	}
	dispatch();
}
