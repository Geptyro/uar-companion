import {
	app,
	BrowserWindow,
	Tray,
	Menu,
	ipcMain,
	shell,
	dialog,
	Notification,
	nativeImage
} from 'electron';
import { appendFileSync, mkdirSync, rmSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '../core/upload.ts';
import { Store } from '../core/state.ts';
import { Watcher } from '../core/watcher.ts';
import { discoverReplayDirs } from '../core/paths.ts';
import { loadConfig, saveConfig, DEFAULT_SERVER, type AppConfig } from './config.ts';
import iconPng from '../../resources/icon.png?asset';
import iconIco from '../../resources/icon.ico?asset';

// test/dev hook: relocate all app data (config, state, log) in one env var
if (process.env.UAR_TRAY_DATA) {
	app.setPath('userData', process.env.UAR_TRAY_DATA);
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
}

const userData = app.getPath('userData');
const logPath = join(userData, 'uar-tray.log');
const config: AppConfig = loadConfig(userData);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: Watcher | null = null;
let abort: AbortController | null = null;
let store: Store;
let quitting = false;
let readyState = { count: 0, names: [] as string[], ok: false };
let lastMenuKey = '';

function log(line: string): void {
	try {
		mkdirSync(userData, { recursive: true });
		try {
			if (statSync(logPath).size > 1 << 20) renameSync(logPath, logPath + '.old');
		} catch {
			// no log yet
		}
		appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// logging must never break the app
	}
}

function server(): string {
	return config.server || DEFAULT_SERVER;
}

function makeClient(): Client {
	return new Client(server(), app.getVersion());
}

function snapshot() {
	return {
		version: app.getVersion(),
		server: server(),
		status: watcher?.statusLine ?? 'Starting…',
		paused: watcher?.paused ?? false,
		queued: watcher?.pending.length ?? 0,
		uploaded: watcher?.uploaded ?? 0,
		dirs: watcher?.cfg.dirs ?? [],
		autoDetected: config.dirs.length === 0,
		history: store.history.slice(0, 50),
		ready: readyState,
		config: {
			noBackfill: config.noBackfill,
			notifyUploads: config.notifyUploads,
			notifyReady: config.notifyReady,
			autostart: config.autostart
		}
	};
}

function pushUpdate(): void {
	win?.webContents.send('update', snapshot());
	refreshTray();
}

function notify(title: string, body: string): void {
	if (Notification.isSupported()) new Notification({ title, body, icon: iconPng }).show();
}

function startWatcher(): void {
	abort?.abort();
	abort = new AbortController();
	const dirs = config.dirs.length > 0 ? config.dirs : discoverReplayDirs(app.getPath('documents'));
	const paused = watcher?.paused ?? false;
	watcher = new Watcher({ dirs, noBackfill: config.noBackfill }, makeClient(), store);
	watcher.paused = paused;
	watcher.on('status', (line: string) => {
		log(`status: ${line}`);
		pushUpdate();
	});
	watcher.on('event', (e: { file: string; kind: string; detail?: string }) => {
		log(`${e.kind} ${e.file}${e.detail ? `: ${e.detail}` : ''}`);
		if (e.kind === 'uploaded' && config.notifyUploads) {
			notify('Replay uploaded', `${e.file} is now on ${server().replace(/^https?:\/\//, '')}`);
		}
		pushUpdate();
	});
	for (const d of dirs) log(`watching ${d}`);
	void watcher.run(abort.signal);
	pushUpdate();
}

async function pollReady(): Promise<void> {
	try {
		const r = await makeClient().ready();
		if (config.notifyReady && readyState.ok && readyState.count === 0 && r.count > 0) {
			notify('Ready to play', `${r.names.join(', ')} ${r.count === 1 ? 'is' : 'are'} ready for a game`);
		}
		readyState = { ...r, ok: true };
	} catch {
		// endpoint unreachable (offline, or feature not deployed yet)
		readyState = { ...readyState, ok: false };
	}
	pushUpdate();
}

function refreshTray(): void {
	if (!tray) return;
	const status = watcher?.statusLine ?? 'Starting…';
	const ready = readyState.ok ? String(readyState.count) : '–';
	const paused = watcher?.paused ?? false;
	const key = `${status}|${ready}|${paused}`;
	if (key === lastMenuKey) return;
	lastMenuKey = key;
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: status, enabled: false },
			{ label: `Ready to play: ${ready}`, enabled: false },
			{ type: 'separator' },
			{ label: 'Open UAR Tray', click: showWindow },
			{ label: 'Open website', click: () => void shell.openExternal(server()) },
			{
				label: paused ? 'Resume uploads' : 'Pause uploads',
				click: () => {
					if (watcher) {
						watcher.paused = !watcher.paused;
						void watcher.tick();
						pushUpdate();
					}
				}
			},
			{ type: 'separator' },
			{
				label: 'Quit',
				click: () => {
					quitting = true;
					app.quit();
				}
			}
		])
	);
	tray.setToolTip(
		readyState.ok && readyState.count > 0
			? `UAR Tray — ready to play: ${readyState.names.join(', ')}`
			: 'UAR Tray — replay uploader'
	);
}

function showWindow(): void {
	if (!win) {
		win = new BrowserWindow({
			width: 940,
			height: 700,
			icon: nativeImage.createFromPath(iconPng),
			autoHideMenuBar: true,
			backgroundColor: '#14171c',
			webPreferences: {
				preload: join(import.meta.dirname, '../preload/index.mjs'),
				sandbox: false
			}
		});
		win.on('close', (e) => {
			// closing the window leaves the app in the tray; Quit lives there
			if (!quitting) {
				e.preventDefault();
				win?.hide();
			}
		});
		win.on('closed', () => (win = null));
		if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
			void win.loadURL(process.env.ELECTRON_RENDERER_URL);
		} else {
			void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
		}
	} else {
		win.show();
		win.focus();
	}
}

function applyAutostart(enabled: boolean): void {
	if (process.platform === 'linux') {
		const dir = join(app.getPath('appData'), 'autostart');
		const desktop = join(dir, 'uar-tray.desktop');
		if (!enabled) {
			rmSync(desktop, { force: true });
			return;
		}
		const exec = process.env.APPIMAGE ?? process.execPath;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			desktop,
			`[Desktop Entry]\nType=Application\nName=UAR Tray\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`
		);
	} else {
		app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
	}
}

function wireIpc(): void {
	ipcMain.handle('snapshot', () => snapshot());
	ipcMain.handle('set-config', (_e, patch: Partial<AppConfig>) => {
		const wasNoBackfill = config.noBackfill;
		Object.assign(config, patch);
		saveConfig(userData, config);
		if ('autostart' in patch) applyAutostart(config.autostart);
		if ('noBackfill' in patch && wasNoBackfill && !config.noBackfill) {
			// user now wants old replays: forget the first-run skips
			for (const [file, rec] of Object.entries(store.files)) {
				if (rec.reason === 'existed before first run (backfill disabled)') {
					delete store.files[file];
				}
			}
		}
		if ('dirs' in patch || 'noBackfill' in patch || 'server' in patch) startWatcher();
		pushUpdate();
		return snapshot();
	});
	ipcMain.handle('add-folder', async () => {
		const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
		if (!r.canceled && r.filePaths[0]) {
			const dirs = watcher?.cfg.dirs ?? [];
			config.dirs = [...new Set([...dirs, r.filePaths[0]])];
			saveConfig(userData, config);
			startWatcher();
		}
		return snapshot();
	});
	ipcMain.handle('remove-folder', (_e, path: string) => {
		const dirs = (watcher?.cfg.dirs ?? []).filter((d) => d !== path);
		config.dirs = dirs;
		saveConfig(userData, config);
		startWatcher();
		return snapshot();
	});
	ipcMain.handle('redetect', () => {
		config.dirs = [];
		saveConfig(userData, config);
		startWatcher();
		return snapshot();
	});
	ipcMain.handle('pause', (_e, paused: boolean) => {
		if (watcher) {
			watcher.paused = paused;
			void watcher.tick();
		}
		pushUpdate();
		return snapshot();
	});
	ipcMain.handle('open-website', () => void shell.openExternal(server()));
	ipcMain.handle('open-log', () => void shell.openPath(logPath));
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {
	// tray app: stay alive with no windows
});
app.on('before-quit', () => {
	quitting = true;
	abort?.abort();
});

void app.whenReady().then(() => {
	app.setAppUserModelId('dev.cedricdessalles.uar-tray');
	store = new Store(userData);
	log(`uar-tray ${app.getVersion()} starting (server ${server()})`);

	tray = new Tray(nativeImage.createFromPath(process.platform === 'win32' ? iconIco : iconPng));
	tray.on('click', showWindow);

	wireIpc();
	startWatcher();
	void pollReady();
	setInterval(() => void pollReady(), 60_000);

	if (!process.argv.includes('--hidden')) showWindow();
	if (!config.firstRunDone) {
		config.firstRunDone = true;
		saveConfig(userData, config);
	}
});
