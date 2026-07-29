import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { Client } from './upload.ts';
import { Store } from './state.ts';
import { MAX_UPLOAD_SIZE, isUARReplay } from './sniff.ts';

// The server accepts a large backfill on purpose (loose flood guard, and
// it serialises ingest itself), so the queue drains one replay at a time
// with only a short gap between uploads.
export const SCAN_INTERVAL = 30_000;
/**
 * Poll cadence once the directories are under an fs.watch: the watch is what
 * actually notices a replay, so the sweep is only a safety net for the cases
 * a watch misses (a directory replaced under us, a filesystem that delivers no
 * events). Sweeping every 30 s forever is not free where it hurts most —
 * Windows runs each readdir/stat through Defender's filter, and a replay
 * folder under OneDrive walks the cloud-files driver on top.
 */
export const IDLE_SCAN_INTERVAL = 5 * 60_000;
/**
 * Gap between uploads. One replay at a time, the next as soon as the
 * previous finished — a fresh install with hundreds of past games should
 * catch up in minutes, not days. The server serialises ingest anyway; this
 * is just breathing room between requests.
 */
export const DEFAULT_POST_SPACING = 1_500;
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
	/** test override for how long a file must stop changing to count as done */
	settleAge?: number;
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
	private settle: number;
	/** every configured directory is under an fs.watch — sweep can go slow */
	private watching = false;
	/** cuts the current idle short; set only while the loop is waiting */
	private wake: (() => void) | null = null;
	/** a watch fired since the last scan — do not idle it away */
	private dirty = false;
	private debounce: ReturnType<typeof setTimeout> | null = null;

	constructor(cfg: WatcherConfig, client: Client, store: Store) {
		super();
		this.cfg = cfg;
		this.client = client;
		this.store = store;
		this.spacing = cfg.postSpacing && cfg.postSpacing > 0 ? cfg.postSpacing : DEFAULT_POST_SPACING;
		this.settle = cfg.settleAge ?? SETTLE_AGE;
	}

	async run(signal?: AbortSignal): Promise<void> {
		const stopWatching = this.cfg.once ? null : this.watchDirs();
		try {
			while (!signal?.aborted) {
				try {
					await this.tick(signal);
				} catch (e) {
					// One bad tick must not end the loop: this is the app's whole
					// heartbeat, and it runs for days. Anything unexpected here —
					// a filesystem that answered strangely, a store write that
					// lost a race — costs one scan, not every future one.
					if (this.cfg.once) throw e;
					console.error('scan failed, continuing:', e);
				}
				// -once: exit as soon as everything present is settled and shipped
				// (or bail after ~5 min so a dead server can't loop forever)
				if (
					this.cfg.once &&
					((this.scans >= 2 && this.pending.length === 0 && this.prev.size === 0) ||
						this.scans > 300)
				) {
					return;
				}
				await this.idle(this.nextDelay(), signal);
			}
		} finally {
			stopWatching?.();
		}
	}

	/**
	 * How long to wait before looking again. A file we have seen but not yet
	 * accepted as settled needs a second look right after SETTLE_AGE — that is
	 * the replay SC2 just finished writing, and it is the whole reason the app
	 * exists, so it gets the short cadence. With nothing in flight there is
	 * nothing to find until the watch says so.
	 */
	private nextDelay(): number {
		if (this.cfg.once) return 1_000;
		if (this.prev.size > 0 || this.pending.length > 0) return this.settle + 1_000;
		return this.watching ? IDLE_SCAN_INTERVAL : SCAN_INTERVAL;
	}

	/**
	 * Wakes the loop as soon as the OS says a replay folder changed, so a
	 * finished game is picked up in seconds instead of on the next sweep.
	 * Best-effort by design: anything the watch cannot cover (no inotify
	 * budget left, a network share, a Wine prefix that reports nothing) simply
	 * leaves `watching` false and keeps the old 30 s sweep.
	 */
	private watchDirs(): () => void {
		const watchers: FSWatcher[] = [];
		for (const dir of this.cfg.dirs) {
			try {
				const w = watch(dir, { persistent: false }, (_event, name) => {
					// SC2 writes plenty of other things in there
					if (name && !String(name).toLowerCase().endsWith('.sc2replay')) return;
					this.touched();
				});
				w.on('error', () => {});
				watchers.push(w);
			} catch {
				// unwatchable directory — the sweep still covers it
			}
		}
		this.watching = watchers.length > 0 && watchers.length === this.cfg.dirs.length;
		return () => {
			this.watching = false;
			if (this.debounce) clearTimeout(this.debounce);
			this.debounce = null;
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					// already gone, or the directory went with it — shutting down
					// either way, and this runs in a finally
				}
			}
		};
	}

	/**
	 * A single write arrives as a burst of events, so they are coalesced: one
	 * replay should cost one scan, not one per event. `dirty` covers the burst
	 * landing while a scan is already running, where there is no idle to cut
	 * short and the event would otherwise be lost until the next sweep.
	 */
	private touched(): void {
		this.dirty = true;
		if (this.debounce) return;
		this.debounce = setTimeout(() => {
			this.debounce = null;
			this.wake?.();
		}, 750);
		this.debounce.unref?.();
	}

	/** sleep(ms), cut short by a watch event or an abort */
	private idle(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (this.dirty || signal?.aborted) {
				this.dirty = false;
				resolve();
				return;
			}
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', done);
				this.wake = null;
				this.dirty = false;
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.wake = done;
			signal?.addEventListener('abort', done);
		});
	}

	async tick(signal?: AbortSignal): Promise<void> {
		if (!this.paused) {
			await this.scan();
			// drain the queue rather than one per scan: a backfill of a few
			// hundred replays would otherwise trickle out over hours
			while (this.pending.length > 0 && !this.paused && !signal?.aborted) {
				const wait = this.nextPost - Date.now();
				if (wait > 0) {
					if (wait > this.spacing) break; // backing off — leave it to a later tick
					await sleep(wait, signal);
				}
				const before = this.pending.length;
				await this.maybeUpload();
				this.updateStatus();
				// no progress (rate limited, or the server is unreachable):
				// stop draining and let the backoff play out
				if (this.pending.length === before) break;
			}
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
					Date.now() - info.mtimeMs > this.settle
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

	/**
	 * Only what the user could act on or would want to know: watching folders
	 * is the whole point of the app running, so saying so says nothing. Idle
	 * and working normally reads as an empty status.
	 */
	private updateStatus(): void {
		const parts: string[] = [];
		if (this.cfg.dirs.length === 0) {
			parts.push('No replay folder found — add one in the settings');
		} else if (this.paused) {
			parts.push('Paused');
		}
		if (this.uploaded > 0) parts.push(`${this.uploaded} uploaded`);
		if (this.pending.length > 0) {
			const wait = this.nextPost - Date.now();
			parts.push(
				`${this.pending.length} queued` +
					(wait > 60_000 ? ` (next in ${Math.round(wait / 60_000)}m)` : '')
			);
		}
		this.setStatus(parts.join(' — '));
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
