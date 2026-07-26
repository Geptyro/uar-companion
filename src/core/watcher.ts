import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Client } from './upload.ts';
import { Store } from './state.ts';
import { MAX_UPLOAD_SIZE, isUARReplay } from './sniff.ts';

// Server-side limits are 20 POST attempts and 5 accepted ingests per hour
// per IP; the spacing below keeps a big backfill safely under the attempt
// cap and lets the 429 backoff absorb the accept cap.
export const SCAN_INTERVAL = 30_000;
export const DEFAULT_POST_SPACING = 3.5 * 60_000;
const RATE_LIMIT_BACKOFF = 15 * 60_000;
const TRANSIENT_BACKOFF = 2 * 60_000;
const SETTLE_AGE = 5_000;

export interface WatcherConfig {
	dirs: string[];
	noBackfill?: boolean;
	once?: boolean;
	postSpacing?: number;
	/** test overrides for the retry backoffs */
	rateLimitBackoff?: number;
	transientBackoff?: number;
}

interface ScanInfo {
	size: number;
	mtimeMs: number;
}

interface PendItem {
	path: string;
	sha: string;
}

/**
 * Polls the replay folders, sniffs settled new files, and drip-feeds UAR
 * replays to the server. Emits:
 *  - 'status' (line: string) — one-line current state for tray/UI
 *  - 'event'  (entry: {file, kind, detail}) — activity feed items
 */
export class Watcher extends EventEmitter {
	readonly cfg: WatcherConfig;
	paused = false;
	uploaded = 0;
	statusLine = 'Starting…';
	pending: PendItem[] = [];

	private client: Client;
	private store: Store;
	private prev = new Map<string, ScanInfo>();
	private nextPost = 0;
	private pauseClassify = 0;
	private firstRun = true;
	private scans = 0;
	private spacing: number;

	constructor(cfg: WatcherConfig, client: Client, store: Store) {
		super();
		this.cfg = cfg;
		this.client = client;
		this.store = store;
		this.spacing = cfg.postSpacing && cfg.postSpacing > 0 ? cfg.postSpacing : DEFAULT_POST_SPACING;
	}

	async run(signal?: AbortSignal): Promise<void> {
		const interval = this.cfg.once ? 1_000 : SCAN_INTERVAL;
		while (!signal?.aborted) {
			await this.tick();
			// -once: exit as soon as everything present is settled and shipped
			// (or bail after ~5 min so a dead server can't loop forever)
			if (
				this.cfg.once &&
				((this.scans >= 2 && this.pending.length === 0 && this.prev.size === 0) ||
					this.scans > 300)
			) {
				return;
			}
			await sleep(interval, signal);
		}
	}

	async tick(): Promise<void> {
		if (!this.paused) {
			await this.scan();
			await this.maybeUpload();
		}
		this.updateStatus();
	}

	private event(file: string, kind: string, detail?: string): void {
		this.store.addHistory(basename(file), kind, detail);
		this.emit('event', { file: basename(file), kind, detail });
	}

	private async scan(): Promise<void> {
		const pendingPaths = new Set(this.pending.map((p) => p.path));
		const pendingShas = new Set(this.pending.map((p) => p.sha));
		for (const dir of this.cfg.dirs) {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.toLowerCase().endsWith('.sc2replay')) continue;
				const path = join(dir, name);
				if (this.store.files[path] || pendingPaths.has(path)) continue;
				let info: ScanInfo;
				try {
					const st = statSync(path);
					if (!st.isFile()) continue;
					info = { size: st.size, mtimeMs: st.mtimeMs };
				} catch {
					continue;
				}
				if (this.firstRun && this.cfg.noBackfill) {
					this.store.record(path, 'skip', '', 'existed before first run (backfill disabled)');
					continue;
				}
				const old = this.prev.get(path);
				// only touch files that stopped growing — SC2 writes the replay
				// at game end, but never race a write in progress
				if (
					old &&
					old.size === info.size &&
					old.mtimeMs === info.mtimeMs &&
					Date.now() - info.mtimeMs > SETTLE_AGE
				) {
					await this.classify(path, pendingShas);
					this.prev.delete(path);
				} else {
					this.prev.set(path, info);
				}
			}
		}
		this.firstRun = false;
		this.scans++;
	}

	private async classify(path: string, pendingShas: Set<string>): Promise<void> {
		if (this.pauseClassify > Date.now()) return;
		let data: Buffer;
		try {
			data = readFileSync(path);
		} catch (e) {
			console.error(`cannot read ${path}:`, e);
			return;
		}
		if (data.length > MAX_UPLOAD_SIZE) {
			this.store.record(path, 'skip', '', 'larger than the 16 MB upload limit');
			this.event(path, 'skipped', 'larger than the 16 MB upload limit');
			return;
		}
		let uar: boolean;
		try {
			uar = isUARReplay(data);
		} catch (e) {
			this.store.record(path, 'skip', '', `unreadable replay: ${(e as Error).message}`);
			return;
		}
		if (!uar) {
			this.store.record(path, 'skip', '', 'not an Undead Assault Reborn replay');
			return;
		}
		const sha = createHash('sha256').update(data).digest('hex');
		if (pendingShas.has(sha)) {
			this.store.record(path, 'skip', sha, 'identical file already queued');
			return;
		}
		let exists: boolean;
		try {
			exists = await this.client.exists(sha);
		} catch (e) {
			// server unreachable — leave the file unclassified and retry later
			console.error(`server check failed for ${path}: ${e}`);
			this.prev.set(path, { size: -1, mtimeMs: 0 }); // fresh look next settled scan
			this.pauseClassify = Date.now() + TRANSIENT_BACKOFF;
			return;
		}
		if (exists) {
			this.store.record(path, 'done', sha, 'already on the server');
			this.event(path, 'duplicate', 'already on the server');
			return;
		}
		this.pending.push({ path, sha });
		pendingShas.add(sha);
		this.event(path, 'queued');
	}

	private async maybeUpload(): Promise<void> {
		if (this.pending.length === 0 || Date.now() < this.nextPost) return;
		const it = this.pending[0];
		const name = basename(it.path);
		let data: Buffer;
		try {
			data = readFileSync(it.path);
		} catch {
			this.store.record(it.path, 'skip', it.sha, 'file disappeared before upload');
			this.pending.shift();
			return;
		}
		this.setStatus(`Uploading ${name}…`);
		const out = await this.client.upload(name, data);
		switch (out.kind) {
			case 'accepted':
				this.uploaded++;
				this.store.record(it.path, 'done', it.sha, 'uploaded');
				this.pending.shift();
				this.nextPost = Date.now() + this.spacing;
				this.event(it.path, 'uploaded', out.message);
				break;
			case 'duplicate':
				this.store.record(it.path, 'done', it.sha, `already ingested: ${out.message}`);
				this.pending.shift();
				this.nextPost = Date.now() + 45_000;
				this.event(it.path, 'duplicate', out.message);
				break;
			case 'rejected':
				this.store.record(it.path, 'skip', it.sha, `rejected: ${out.message}`);
				this.pending.shift();
				this.nextPost = Date.now() + 45_000;
				this.event(it.path, 'rejected', out.message);
				break;
			case 'ratelimited':
				this.nextPost = Date.now() + (this.cfg.rateLimitBackoff ?? RATE_LIMIT_BACKOFF);
				this.event(it.path, 'waiting', 'rate limited — retrying in 15 min');
				break;
			case 'transient':
				this.nextPost = Date.now() + (this.cfg.transientBackoff ?? TRANSIENT_BACKOFF);
				this.event(it.path, 'error', `${out.message} — retrying in 2 min`);
				break;
		}
	}

	private updateStatus(): void {
		let s: string;
		if (this.cfg.dirs.length === 0) {
			s = 'No replay folder found — add one in the settings';
		} else if (this.paused) {
			s = 'Paused';
		} else {
			s = `Watching ${this.cfg.dirs.length} folder${this.cfg.dirs.length > 1 ? 's' : ''}`;
		}
		if (this.uploaded > 0) s += ` — ${this.uploaded} uploaded`;
		if (this.pending.length > 0) {
			s += ` — ${this.pending.length} queued`;
			const wait = this.nextPost - Date.now();
			if (wait > 60_000) s += ` (next in ${Math.round(wait / 60_000)}m)`;
		}
		this.setStatus(s);
	}

	private setStatus(line: string): void {
		if (line === this.statusLine) return;
		this.statusLine = line;
		this.emit('status', line);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener('abort', done);
			clearTimeout(t);
			resolve();
		}
		signal?.addEventListener('abort', done);
	});
}
