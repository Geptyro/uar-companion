/**
 * Headless console entry — same core code paths as the Electron app, no
 * Electron needed. Used by the E2E test and available for servers/scripts:
 *
 *   node src/cli.ts [--once] [--dir <path>]... [--server <url>]
 *                   [--spacing <ms>] [--no-backfill] [--state <dir>]
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from './core/upload.ts';
import { Store } from './core/state.ts';
import { Watcher } from './core/watcher.ts';
import { discoverReplayDirs } from './core/paths.ts';

const DEFAULT_SERVER = 'https://uar.cedricdessalles.dev';

const args = process.argv.slice(2);
const dirs: string[] = [];
let server = DEFAULT_SERVER;
let once = false;
let noBackfill = false;
let spacing = 0;
let stateDir = join(homedir(), '.config', 'uar-companion');
for (let i = 0; i < args.length; i++) {
	switch (args[i]) {
		case '--dir':
			dirs.push(args[++i]);
			break;
		case '--server':
			server = args[++i];
			break;
		case '--spacing':
			spacing = Number(args[++i]);
			break;
		case '--state':
			stateDir = args[++i];
			break;
		case '--once':
			once = true;
			break;
		case '--no-backfill':
			noBackfill = true;
			break;
		default:
			console.error(`unknown argument: ${args[i]}`);
			process.exit(2);
	}
}

const watchDirs = dirs.length > 0 ? dirs : discoverReplayDirs();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
log(`uar-companion cli starting (server ${server})`);
for (const d of watchDirs) log(`watching ${d}`);

const watcher = new Watcher(
	{ dirs: watchDirs, once, noBackfill, postSpacing: spacing },
	new Client(server, 'cli'),
	new Store(stateDir)
);
watcher.on('status', log);
watcher.on('event', (e: { file: string; kind: string; detail?: string }) =>
	log(`${e.kind} ${e.file}${e.detail ? `: ${e.detail}` : ''}`)
);

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());
await watcher.run(abort.signal);
