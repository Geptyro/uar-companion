import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AppConfig {
	/** Explicit replay folders; empty = auto-detect. */
	dirs: string[];
	/** Skip replays that existed before the first run. */
	noBackfill: boolean;
	notifyUploads: boolean;
	notifyReady: boolean;
	autostart: boolean;
	/** Override for development; empty = production site. */
	server: string;
	firstRunDone: boolean;
}

export const DEFAULT_SERVER = 'https://uar.cedricdessalles.dev';

const DEFAULTS: AppConfig = {
	dirs: [],
	noBackfill: false,
	notifyUploads: true,
	notifyReady: true,
	autostart: false,
	server: '',
	firstRunDone: false
};

export function loadConfig(dir: string): AppConfig {
	try {
		const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
		return { ...DEFAULTS, ...raw };
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveConfig(dir: string, config: AppConfig): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, '\t'));
}
