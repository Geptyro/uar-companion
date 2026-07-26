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
 * Persists per-file outcomes (so old replays are not re-hashed and
 * re-checked on every launch) plus a recent-activity feed for the UI.
 */
export class Store {
	files: Record<string, FileRecord> = {};
	history: HistoryEntry[] = [];
	private path: string;

	constructor(dir: string) {
		this.path = join(dir, 'state.json');
		try {
			const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Store>;
			this.files = raw.files ?? {};
			this.history = raw.history ?? [];
		} catch {
			// first run
		}
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
			writeFileSync(tmp, JSON.stringify({ files: this.files, history: this.history }, null, '\t'));
			renameSync(tmp, this.path);
		} catch (e) {
			console.error('state save failed:', e);
		}
	}
}
