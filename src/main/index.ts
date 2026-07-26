import {
	app,
	BrowserWindow,
	Tray,
	Menu,
	ipcMain,
	shell,
	dialog,
	screen,
	Notification,
	nativeImage
} from 'electron';
import { appendFileSync, mkdirSync, rmSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type ReadyPlayerInfo } from '../core/upload.ts';
import { Store } from '../core/state.ts';
import { Watcher } from '../core/watcher.ts';
import { discoverReplayDirs } from '../core/paths.ts';
import { consumeSSE } from '../core/sse.ts';
import { loadConfig, saveConfig, DEFAULT_SERVER, type AppConfig } from './config.ts';
import iconPng from '../../resources/icon.png?asset';
import iconIco from '../../resources/icon.ico?asset';

// Wayland compositors place windows themselves (KWin centers them) and
// ignore requested coordinates, which breaks tray-anchored toasts — run on
// XWayland where positioning works. UAR_TRAY_WAYLAND=1 opts back out.
if (process.platform === 'linux' && !process.env.UAR_TRAY_WAYLAND) {
	app.commandLine.appendSwitch('ozone-platform', 'x11');
}

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
let sseAbort: AbortController | null = null;
let store: Store;
let quitting = false;
let readyState = { count: 0, names: [] as string[], ok: false };
/** null until the first successful fetch — no toasts for the initial roster */
let knownReady: Map<string, string> | null = null;
let lastMenuKey = '';
let lastTrayIconKey = '';

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
		announceReadyChanges(r.players, r.count);
		readyState = { count: r.count, names: r.names, ok: true };
	} catch {
		// endpoint unreachable (offline, or feature not deployed yet)
		readyState = { ...readyState, ok: false };
	}
	pushUpdate();
}

/** Toasts set/unset diffs against the last seen roster (never the first one). */
function announceReadyChanges(players: ReadyPlayerInfo[], count: number): void {
	const next = new Map(players.map((p) => [p.battletag, p.until]));
	const prev = knownReady;
	knownReady = next;
	if (prev === null || !config.notifyReady) return;
	const added = [...next.keys()].filter((n) => !prev.has(n));
	// a flag that vanished while its `until` was still comfortably in the
	// future was unset by the player; anything else just expired — stay quiet
	const removed = [...prev.entries()]
		.filter(([n, until]) => !next.has(n) && Date.parse(until) > Date.now() + 60_000)
		.map(([n]) => n);
	if (added.length === 0 && removed.length === 0) return;
	const list = (names: string[]) =>
		names.length <= 2 ? names.join(' and ') : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
	const countLine = `${count} player${count === 1 ? '' : 's'} ready on ${server().replace(/^https?:\/\//, '')}`;
	if (added.length > 0) {
		showToast(`${list(added)} ${added.length === 1 ? 'is' : 'are'} ready to play`, countLine);
	} else {
		showToast(`${list(removed)} ${removed.length === 1 ? 'is' : 'are'} no longer ready`, countLine);
	}
}

/**
 * Live change feed: the site's /api/ready/events SSE stream announces roster
 * changes (notification-only — state still comes from /api/ready). The 60s
 * poll in whenReady stays as fallback and catches silent flag expiries the
 * stream never announces.
 */
async function sseLoop(): Promise<void> {
	sseAbort?.abort();
	const ctl = new AbortController();
	sseAbort = ctl;
	let backoff = 5_000;
	while (!ctl.signal.aborted) {
		const connectedAt = Date.now();
		try {
			await consumeSSE(
				`${server()}/api/ready/events`,
				(name) => {
					if (name === 'change') void pollReady();
				},
				{ signal: ctl.signal }
			);
		} catch {
			// connection refused / dropped / endpoint missing — fall through
		}
		if (ctl.signal.aborted) return;
		// a connection that held for a while resets the backoff
		if (Date.now() - connectedAt > 60_000) backoff = 5_000;
		await new Promise((r) => setTimeout(r, backoff));
		backoff = Math.min(backoff * 2, 60_000);
	}
}

let toastWin: BrowserWindow | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(title: string, sub: string): void {
	const W = 340;
	const H = 92;
	toastWin?.destroy();
	if (toastTimer) clearTimeout(toastTimer);
	const toast = new BrowserWindow({
		width: W,
		height: H,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		focusable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
		webPreferences: {
			preload: join(import.meta.dirname, '../preload/index.mjs'),
			sandbox: false
		}
	});
	toast.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	toast.setBounds({ ...toastPosition(W, H), width: W, height: H });
	const query = { title, sub };
	if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
		void toast.loadURL(
			`${process.env.ELECTRON_RENDERER_URL}/toast.html?${new URLSearchParams(query)}`
		);
	} else {
		void toast.loadFile(join(import.meta.dirname, '../renderer/toast.html'), { query });
	}
	// transparent windows never fire ready-to-show on some Linux setups
	// (electron#29717) — reveal on load, with a timer as backstop
	const reveal = () => {
		if (!toast.isDestroyed() && !toast.isVisible()) toast.showInactive();
	};
	toast.once('ready-to-show', reveal);
	toast.webContents.once('did-finish-load', () => setTimeout(reveal, 30));
	setTimeout(reveal, 800);
	setTimeout(() => {
		if (!toast.isDestroyed()) {
			const b = toast.getBounds();
			log(`toast "${title}" visible: ${toast.isVisible()} at ${b.x},${b.y}`);
		}
	}, 1500);
	toast.on('closed', () => {
		if (toastWin === toast) toastWin = null;
	});
	toastWin = toast;
	toastTimer = setTimeout(() => toast.destroy(), 6_000);
}

/** Right above the tray icon when the OS tells us where it is, else just
 * above the bottom-right corner of the work area (where trays live). */
function toastPosition(w: number, h: number): { x: number; y: number } {
	try {
		const b = tray?.getBounds();
		if (b && b.width > 0) {
			const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
			const x = Math.min(Math.max(b.x + b.width / 2 - w / 2, area.x + 8), area.x + area.width - w - 8);
			const y = b.y > area.y + area.height / 2 ? b.y - h - 8 : b.y + b.height + 8;
			return { x: Math.round(x), y: Math.round(y) };
		}
	} catch {
		// tray bounds unavailable (common on Linux SNI)
	}
	const area = screen.getPrimaryDisplay().workArea;
	return { x: area.x + area.width - w - 12, y: area.y + area.height - h - 12 };
}

/** Tray icon with the ready count badged onto it (1–9, 9+). */
function trayIconFor(count: number): Electron.NativeImage {
	const ext = process.platform === 'win32' ? 'ico' : 'png';
	if (count <= 0) {
		return nativeImage.createFromPath(process.platform === 'win32' ? iconIco : iconPng);
	}
	const badge = count > 9 ? '9plus' : String(count);
	return nativeImage.createFromPath(
		join(import.meta.dirname, `../../resources/badges/badge-${badge}.${ext}`)
	);
}

function refreshTray(): void {
	if (!tray) return;
	const badgeCount = readyState.ok ? readyState.count : 0;
	if (String(badgeCount) !== lastTrayIconKey) {
		lastTrayIconKey = String(badgeCount);
		tray.setImage(trayIconFor(badgeCount));
	}
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
		if ('server' in patch) {
			knownReady = null;
			void sseLoop();
			void pollReady();
		}
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
	sseAbort?.abort();
	toastWin?.destroy();
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
	void sseLoop();
	// fallback cadence: catches silent flag expiries and any missed events
	setInterval(() => void pollReady(), 60_000);

	if (!process.argv.includes('--hidden')) showWindow();
	if (!config.firstRunDone) {
		config.firstRunDone = true;
		saveConfig(userData, config);
	}

	// smoke-test hook: render a toast without waiting for a real roster change
	if (process.env.UAR_TRAY_TEST_TOAST) {
		setTimeout(
			() => showToast('Znimu#743 is ready to play', '3 players ready on uar.cedricdessalles.dev'),
			1500
		);
	}
});
