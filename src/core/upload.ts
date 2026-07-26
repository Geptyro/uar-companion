/** HTTP client for the UAR website's replay + ready APIs. */

export type OutcomeKind = 'accepted' | 'duplicate' | 'rejected' | 'ratelimited' | 'transient';

export interface Outcome {
	kind: OutcomeKind;
	message: string;
}

export interface ReadyPlayerInfo {
	battletag: string;
	/** ISO timestamp when this flag silently expires. */
	until: string;
}

export interface ReadyState {
	count: number;
	names: string[];
	players: ReadyPlayerInfo[];
}

const TIMEOUT_MS = 90_000;

export class Client {
	private server: string;
	private ua: string;

	constructor(server: string, version: string) {
		this.server = server.replace(/\/+$/, '');
		this.ua = `uar-companion/${version}`;
	}

	get serverUrl(): string {
		return this.server;
	}

	/**
	 * Pre-upload dedupe: asks whether the server already stores this exact
	 * file (GET /api/replays?sha256=...) so known replays never spend an
	 * upload. Throws when the server cannot be reached.
	 */
	async exists(sha256hex: string): Promise<boolean> {
		const resp = await fetch(`${this.server}/api/replays?sha256=${sha256hex}`, {
			headers: { 'user-agent': this.ua },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!resp.ok) throw new Error(`sha check: HTTP ${resp.status}`);
		const body = (await resp.json()) as { exists?: boolean };
		return body.exists === true;
	}

	/**
	 * POSTs the replay as multipart field "replay" and maps the server's
	 * answer onto what the queue should do next. Never throws.
	 */
	async upload(filename: string, data: Uint8Array): Promise<Outcome> {
		let resp: Response;
		try {
			const form = new FormData();
			form.append('replay', new Blob([data as BlobPart]), filename);
			resp = await fetch(`${this.server}/api/replays`, {
				method: 'POST',
				body: form,
				headers: {
					'user-agent': this.ua,
					// SvelteKit renders errors as HTML pages unless JSON is asked for
					accept: 'application/json',
					// adapter-node rejects cross-site form posts without a trusted Origin
					origin: this.server
				},
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
		} catch (e) {
			return { kind: 'transient', message: String(e) };
		}
		const raw = await resp.text().catch(() => '');
		const message = serverMessage(raw);
		if (resp.ok) return { kind: 'accepted', message };
		switch (resp.status) {
			case 409:
				return { kind: 'duplicate', message };
			case 429:
				return { kind: 'ratelimited', message };
			case 400:
			case 413:
				return { kind: 'rejected', message };
			default:
				return { kind: 'transient', message: `HTTP ${resp.status}: ${message}` };
		}
	}

	/** Polls the site's "ready to play" widget (GET /api/ready). Throws on failure. */
	async ready(): Promise<ReadyState> {
		const resp = await fetch(`${this.server}/api/ready`, {
			headers: { 'user-agent': this.ua, accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const body = (await resp.json()) as { players?: { battletag: string; until: string }[] };
		const players = (body.players ?? []).map((p) => ({ battletag: p.battletag, until: p.until }));
		return { count: players.length, names: players.map((p) => p.battletag), players };
	}
}

/**
 * Extracts the human-readable part of a SvelteKit response ({"message"} on
 * both errors and success), falling back to the raw body.
 */
function serverMessage(raw: string): string {
	try {
		const body = JSON.parse(raw) as { message?: string };
		if (body.message) return body.message;
	} catch {
		// not JSON — fall through
	}
	const s = raw.trim();
	return s.length > 200 ? s.slice(0, 200) : s;
}
