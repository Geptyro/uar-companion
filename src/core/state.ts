import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FileRecord {
	status: 'done' | 'skip';
	sha?: string;
	reason?: string;
	at: string;
}

export interface HistoryEntry {
	at: string;
	file: string;
	kind: string; // 'uploaded' | 'duplicate' | 'skipped' | 'error' | ...
	detail?: string;
}

const HISTORY_CAP = 200;

/**
 * The verdict the site used to return when it was merely too busy to parse.
 *
 * Until website v0.33.3 an upload that outran the server's replay worker came
 * back as 400 with this message — the same answer a genuinely corrupt file
 * gets, and this app treats a 400 as final: it records the path as skipped and
 * `scan` passes over it on every later run. So during a backfill, which is
 * exactly when the server was most likely to run out of time, good games were
 * dropped for good and nothing said so.
 *
 * Matched whole rather than by prefix: the other 400s ("Not an Undead Assault
 * Reborn replay (map: …)", the size limit) are real verdicts about the file and
 * must keep their skip.
 */
const BUSY_SERVER_REJECTION = 'rejected: Not a readable StarCraft II replay.';

/**
 * Migrations already applied, recorded in the state file.
 *
 * The retry has to run once and not on every launch: a file that really is
 * unreadable earns the same record again the moment it is retried, so an
 * ungated purge would re-offer it forever.
 */
const RETRY_BUSY_REJECTIONS = 'retry-busy-server-rejections';

/**
 * Persists per-file outcomes (so old replays are not re-hashed and
 * re-checked on every launch) plus a recent-activity feed for the UI.
 */
export class Store {
	files: Record<string, FileRecord> = {};
	history: HistoryEntry[] = [];
	migrations: string[] = [];
	/** How many games this launch handed back to the watcher; 0 on every later one. */
	readonly revived: number;
	private path: string;

	constructor(dir: string) {
		this.path = join(dir, 'state.json');
		try {
			const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Store>;
			this.files = raw.files ?? {};
			this.history = raw.history ?? [];
			this.migrations = raw.migrations ?? [];
		} catch {
			// first run
		}
		this.revived = this.retryBusyServerRejections();
	}

	/**
	 * Forget the games the site wrongly called unreadable, so the watcher offers
	 * them again on its next scan — dropping the record is all that takes, since
	 * `scan` skips any path it finds here.
	 */
	private retryBusyServerRejections(): number {
		if (this.migrations.includes(RETRY_BUSY_REJECTIONS)) return 0;
		let revived = 0;
		for (const [path, rec] of Object.entries(this.files)) {
			if (rec.status === 'skip' && rec.reason === BUSY_SERVER_REJECTION) {
				delete this.files[path];
				revived++;
			}
		}
		this.migrations.push(RETRY_BUSY_REJECTIONS);
		if (revived) {
			this.addHistory(
				`${revived} game${revived === 1 ? '' : 's'}`,
				'queued',
				'the site was too busy to read these — trying again'
			);
		}
		this.save(); // records the migration even when it freed nothing
		return revived;
	}

	record(file: string, status: 'done' | 'skip', sha: string, reason: string): void {
		this.files[file] = { status, sha: sha || undefined, reason, at: new Date().toISOString() };
		this.save();
	}

	addHistory(file: string, kind: string, detail?: string): void {
		this.history.unshift({ at: new Date().toISOString(), file, kind, detail });
		if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
		this.save();
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const tmp = this.path + '.tmp';
			writeFileSync(
				tmp,
				JSON.stringify(
					{ files: this.files, history: this.history, migrations: this.migrations },
					null,
					'\t'
				)
			);
			renameSync(tmp, this.path);
		} catch (e) {
			console.error('state save failed:', e);
		}
	}
}
