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
	nativeImage,
	nativeTheme
} from 'electron';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import electronUpdater from 'electron-updater';
import { Client } from '../core/upload.ts';
import { Store } from '../core/state.ts';
import { Watcher } from '../core/watcher.ts';
import { battleLobbyGlobs, discoverReplayDirs, findBattleLobby } from '../core/paths.ts';
import { consumeSSE } from '../core/sse.ts';
import {
	loadConfig,
	saveConfig,
	windowPlacement,
	WINDOW,
	DEFAULT_SERVER,
	type AppConfig,
	type WindowBounds
} from './config.ts';
import {
	fetchMe,
	fetchReadyRoster,
	fetchPresenceList,
	setReadyFlag,
	sendPresence,
	openLogin,
	logout,
	type Me,
	type PresenceEntry,
	type PresenceSplit
} from './auth.ts';
import { bareProfileName, watchSC2, type SC2Presence } from '../core/sc2.ts';
import { decideLobbyToast, listNames, NO_LOBBY_TOAST, type LobbyToastState } from '../core/lobby.ts';
import { splitPresence } from 'uar-shared/presence';
import { readFileSync } from 'node:fs';
import iconPngProd from '../../resources/icon.png?asset';
import iconIcoProd from '../../resources/icon.ico?asset';
import iconPngDev from '../../resources/icon-dev.png?asset';
import iconIcoDev from '../../resources/icon-dev.ico?asset';

// On Wayland, apps cannot position their own windows — the compositor places
// them (KWin centers) — so a saved window position is junk there and must not
// be written back (see saveBounds).
const isWayland =
	process.platform === 'linux' &&
	(process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

/**
 * A dev run is a different app: its own desktop entry, grey icon, window
 * title and tray tooltip, so it can never be mistaken for — or overwrite
 * the desktop entry of — the installed one.
 */
const isDev = !app.isPackaged;
const appLabel = isDev ? 'UAR Companion (dev)' : 'UAR Companion';
const desktopId = isDev ? 'uar-companion-dev' : 'uar-companion';
const iconPng = isDev ? iconPngDev : iconPngProd;
const iconIco = isDev ? iconIcoDev : iconIcoProd;

// dev convenience: load .env from the project root (UAR_COMPANION_SERVER,
// UAR_COMPANION_DATA, …) — website convention; packaged builds never have one
if (!app.isPackaged) {
	try {
		for (const line of readFileSync('.env', 'utf8').split('\n')) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && process.env[m[1]] === undefined) {
				process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
			}
		}
	} catch {
		// no .env — fine
	}
}

// test/dev hook: relocate all app data (config, state, log) in one env var
if (process.env.UAR_COMPANION_DATA) {
	app.setPath('userData', process.env.UAR_COMPANION_DATA);
}

// Linux: the window/taskbar icon comes from a desktop entry, not from the
// BrowserWindow icon — Wayland matches the window's app_id to a .desktop
// file name, so both must line up (see installDesktopEntry). setDesktopName
// exists at runtime but is absent from electron.d.ts; call it defensively so
// a future removal cannot crash startup.
if (process.platform === 'linux') {
	(app as unknown as { setDesktopName?: (name: string) => void }).setDesktopName?.(
		`${desktopId}.desktop`
	);
}

/**
 * The whole UI is a static list — no canvas, no video, no animation — so GPU
 * acceleration buys it nothing and costs a GPU process holding a graphics
 * device (a D3D device on Windows) for as long as the app sits in the tray.
 * That device is contended with whatever game the user is actually playing,
 * which is the entire point of a companion app: it must be invisible while
 * the game runs. Software painting a list a few times a minute is free.
 * Must be called before the app is ready.
 */
app.disableHardwareAcceleration();

/**
 * A second launch hands over to the running instance (see 'second-instance')
 * and must do nothing else — app.quit() is asynchronous, so without this the
 * loser would go on to build a tray, start a watcher and open sockets in the
 * moments before it dies.
 */
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();

const userData = app.getPath('userData');
const logPath = join(userData, 'uar-companion.log');
const config: AppConfig = loadConfig(userData);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: Watcher | null = null;
let abort: AbortController | null = null;
let sseAbort: AbortController | null = null;
let store: Store;
let readyState = {
	count: 0,
	names: [] as string[],
	players: [] as { battletag: string; name: string | null; avatar: string | null; until: string }[],
	ok: false
};
let me: Me | null = null;
let meReady = false;
let meUntil: string | null = null;
/** a release newer than ours exists, and nothing has been fetched yet */
let updateAvailable: string | null = null;
/** downloaded and staged — the restart is all that is left */
let updateVersion: string | null = null;
let updateDownloading: string | null = null;
let sc2: SC2Presence | null = null;
let stopSC2: (() => void) | null = null;
let presenceMuteUntil = 0;
/** who is in a lobby/game right now; null until the server endpoint ships */
let presenceList: PresenceEntry[] | null = null;
/** the site's own grouping of that list; null when it sent none (old server) */
let presenceGroups: PresenceSplit | null = null;
let presenceKnown: Record<string, { toon: string; avatar?: string }> = {};
/**
 * Battletag -> flag, from the last fetch; null until the first successful one,
 * so the initial roster toasts nothing. Keyed by the account and not by the
 * profile name it displays: names are neither unique nor permanent.
 */
let knownReady: Map<string, { name: string | null; until: string }> | null = null;
/** as above for the lobby: baseline from the first fetch, plus flap state */
let lobbyToast: LobbyToastState = NO_LOBBY_TOAST;
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
	return process.env.UAR_COMPANION_SERVER || config.server || DEFAULT_SERVER;
}

function makeClient(): Client {
	return new Client(server(), app.getVersion());
}

function snapshot() {
	return {
		version: app.getVersion(),
		server: server(),
		dev: isDev,
		paused: watcher?.paused ?? false,
		dirs: watcher?.cfg.dirs ?? [],
		autoDetected: config.dirs.length === 0,
		history: store.history.slice(0, 50),
		ready: readyState,
		me,
		meReady,
		meUntil,
		updateAvailable,
		updateVersion,
		updateDownloading,
		sc2,
		presenceList,
		presenceGroups,
		presenceKnown,
		config: {
			noBackfill: config.noBackfill,
			notifyUploads: config.notifyUploads,
			notifyReady: config.notifyReady,
			notifyLobby: config.notifyLobby,
			notifyInGame: config.notifyInGame,
			autostart: config.autostart
		}
	};
}

/** last payload actually sent, so an unchanged 60 s poll wakes nobody */
let lastPush = '';

function pushUpdate(): void {
	if (win && !win.isDestroyed()) {
		const snap = snapshot();
		const key = JSON.stringify(snap);
		if (key !== lastPush) {
			lastPush = key;
			win.webContents.send('update', snap);
		}
	}
	refreshTray();
}

/**
 * A lobby or a game is exactly where an interruption costs the most — the
 * moment the app is a companion to — so nothing is shown there unless the
 * user opts in. Held back, not queued: who was ready ten minutes ago is not
 * news when the game ends, and the site shows the current roster anyway.
 * Silent while SC2 is not running, or on a server that never told us
 * (sc2 === null).
 */
function heldBack(title: string): boolean {
	if (config.notifyInGame || sc2 === null || sc2.status === 'menus') return false;
	log(`notification held back (in a ${sc2.status === 'ingame' ? 'game' : 'lobby'}): ${title}`);
	return true;
}

function notify(title: string, body: string): void {
	if (heldBack(title) || !Notification.isSupported()) return;
	const n = new Notification({ title, body, icon: iconPng });
	// same gesture as the custom toast: the news is only useful next to the site
	n.on('click', () => void shell.openExternal(server()));
	n.show();
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
	void fetchPresenceList(server()).then((payload) => {
		const list = payload?.players ?? null;
		if (JSON.stringify(list) !== JSON.stringify(presenceList)) {
			presenceList = list;
			// the groups are the server's function of that same list
			presenceGroups = payload?.groups ?? null;
			presenceKnown = payload?.known ?? {};
			announceLobbyChanges(currentSplit().lobbies);
			pushUpdate();
		}
	});
	try {
		const r = await fetchReadyRoster(server());
		announceReadyChanges(r.players, r.players.length);
		readyState = {
			count: r.players.length,
			names: r.players.map((p) => p.name ?? p.battletag),
			players: r.players,
			ok: true
		};
		meReady = r.meReady;
		meUntil = r.meUntil;
		// covers the app starting while already in a lobby/game: by the time
		// sign-in state is known, no presence *change* will retrigger this
		if (meReady && me && sc2 && sc2.status !== 'menus') {
			if (await setReadyFlag(server(), false)) {
				log(`ready flag withdrawn — already in a ${sc2.status === 'ingame' ? 'game' : 'lobby'}`);
				const again = await fetchReadyRoster(server());
				meReady = again.meReady;
				meUntil = again.meUntil;
			}
		}
	} catch {
		// endpoint unreachable (offline, or feature not deployed yet)
		readyState = { ...readyState, ok: false };
	}
	pushUpdate();
}

/** A lobby that flaps back within this window is the same lobby, not a new one. */
const LOBBY_TOAST_GAP_MS = 10 * 60_000;

/** The lobby/game split we are showing: the site's, or ours against an old one. */
function currentSplit(): PresenceSplit {
	return presenceGroups ?? splitPresence(presenceList ?? []);
}

/**
 * Toasts a lobby forming — the point of the app for anyone waiting for a
 * game to start. The rules live in core/lobby.ts; this is the I/O around
 * them.
 *
 * Caveat worth knowing: while a lobby is open SC2 exposes nothing that
 * identifies the map (the battlelobby file that would is not written yet —
 * docs/sc2-detection.md), so this cannot tell a UAR lobby from any other
 * SC2 lobby a companion user sits in. The wording stays neutral for that
 * reason, and the toggle exists for anyone who finds it too eager.
 */
function announceLobbyChanges(lobbies: PresenceSplit['lobbies']): void {
	// lobbies all collapse into one group, so this is the whole picture
	const { toast, state } = decideLobbyToast(lobbyToast, {
		members: (lobbies[0]?.members ?? []).map((m) => m.battletag),
		me: me?.battletag ?? null,
		enabled: config.notifyLobby,
		now: Date.now(),
		gapMs: LOBBY_TOAST_GAP_MS
	});
	lobbyToast = state;
	if (toast === null) return;
	// battletags identify the lobby (and the log); the headline reads out the
	// profile names, which is how these players know each other
	log(`lobby toast: ${toast.join(', ')}`);
	const shown = new Map(
		(lobbies[0]?.members ?? []).map((m) => [m.battletag, m.name ?? m.battletag])
	);
	const named = toast.map((t) => shown.get(t) ?? t);
	showToast(
		`${listNames(named)} ${toast.length === 1 ? 'is' : 'are'} in a lobby`,
		`Open ${server().replace(/^https?:\/\//, '')} to see who joins`
	);
}

/** Toasts set/unset diffs against the last seen roster (never the first one). */
function announceReadyChanges(
	players: { battletag: string; name: string | null; until: string }[],
	count: number
): void {
	const next = new Map(players.map((p) => [p.battletag, { name: p.name, until: p.until }]));
	const prev = knownReady;
	knownReady = next;
	if (prev === null || !config.notifyReady) return;
	// the SC2 profile name is the one people know each other by; a battletag
	// only shows for an account whose profile the site could not resolve
	const label = (tag: string, p: { name: string | null }) => p.name ?? tag;
	// own toggles come from our own click — no need to announce them
	const added = [...next.entries()]
		.filter(([n]) => !prev.has(n) && n !== me?.battletag)
		.map(([n, p]) => label(n, p));
	// a flag that vanished while its `until` was still comfortably in the
	// future was unset by the player; anything else just expired — stay quiet
	const removed = [...prev.entries()]
		.filter(
			([n, p]) =>
				!next.has(n) && n !== me?.battletag && Date.parse(p.until) > Date.now() + 60_000
		)
		.map(([n, p]) => label(n, p));
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

/**
 * The OS notification service is the right home for these on every platform
 * that has one: it already anchors near the tray (the reason the custom
 * window existed), it costs us no window, and — the reason this changed —
 * an always-on-top transparent window drawn over a running game pulls the
 * game out of fullscreen on Windows, which players feel as a freeze of a
 * second or more. A companion has no business doing that to the game it is a
 * companion to; the OS knows when to hold a notification back instead
 * (Focus Assist, Do Not Disturb) and we want it to.
 */
function showToast(title: string, sub: string): void {
	// checked here too: the fallback window below never goes through notify(),
	// and an always-on-top window over a running game is the worst offender
	if (heldBack(title)) return;
	if (Notification.isSupported()) {
		log(`notification: ${title}`);
		notify(title, sub);
		return;
	}
	showToastWindow(title, sub);
}

/**
 * Fallback for a desktop with no notification daemon at all (bare X11 without
 * one, mostly). Kept to a single window that is reused and hidden rather than
 * created and destroyed per toast — each creation was an entire renderer
 * process, spawned at exactly the moment the user was busy elsewhere.
 */
function showToastWindow(title: string, sub: string): void {
	const W = 340;
	const H = 92;
	if (toastTimer) clearTimeout(toastTimer);
	if (!toastWin || toastWin.isDestroyed()) {
		toastWin = new BrowserWindow({
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
		toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		toastWin.on('closed', () => (toastWin = null));
	}
	const toast = toastWin;
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
	toastTimer = setTimeout(() => {
		if (!toast.isDestroyed()) toast.hide();
	}, 6_000);
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

/**
 * Tray icon badge, most actionable state first: an open lobby (teal dot —
 * something to join right now) outranks the ready count (1–9, 9+).
 */
function trayIconFor(badge: string | null): Electron.NativeImage {
	const ext = process.platform === 'win32' ? 'ico' : 'png';
	if (badge === null) {
		return nativeImage.createFromPath(process.platform === 'win32' ? iconIco : iconPng);
	}
	return nativeImage.createFromPath(
		join(import.meta.dirname, `../../resources/badges/badge-${badge}${isDev ? '-dev' : ''}.${ext}`)
	);
}

function trayBadge(): string | null {
	const lobbies = currentSplit().lobbies.length;
	if (lobbies > 0) return 'lobby';
	const count = readyState.ok ? readyState.count : 0;
	if (count <= 0) return null;
	return count > 9 ? '9plus' : String(count);
}

function refreshTray(): void {
	if (!tray) return;
	const badge = trayBadge();
	if (String(badge) !== lastTrayIconKey) {
		lastTrayIconKey = String(badge);
		tray.setImage(trayIconFor(badge));
		log(`tray badge: ${badge ?? 'none'}`);
	}
	// empty once idle: nothing worth a line of its own
	const status = watcher?.statusLine ?? 'Starting…';
	const ready = readyState.ok ? String(readyState.count) : '–';
	const paused = watcher?.paused ?? false;
	const key = `${status}|${ready}|${paused}|${me?.battletag ?? ''}|${meReady}|${updateVersion ?? ''}|${updateDownloading ?? ''}|${updateAvailable ?? ''}`;
	if (key === lastMenuKey) return;
	lastMenuKey = key;
	tray.setContextMenu(
		Menu.buildFromTemplate([
			...(status ? [{ label: status, enabled: false }] : []),
			{ label: `Ready to play: ${ready}`, enabled: false },
			...(me
				? [
						{
							label: meReady ? "I'm no longer ready" : 'Flag me ready to play',
							click: () => void toggleMyReady()
						}
					]
				: []),
			...(updateVersion
				? [
						{
							label: `Restart to update to v${updateVersion}`,
							click: () => electronUpdater.autoUpdater.quitAndInstall()
						}
					]
				: updateDownloading
					? [{ label: `Downloading v${updateDownloading}…`, enabled: false }]
					: updateAvailable
						? [{ label: `Download update v${updateAvailable}`, click: downloadUpdate }]
						: []),
			{ type: 'separator' },
			{ label: 'Open UAR Companion', click: showWindow },
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
				click: () => app.quit()
			}
		])
	);
	tray.setToolTip(
		readyState.ok && readyState.count > 0
			? `${appLabel} — ready to play: ${readyState.names.join(', ')}`
			: `${appLabel} — ${server().replace(/^https?:\/\//, '')}`
	);
}

function showWindow(): void {
	if (!win) {
		// a fresh renderer reads the snapshot on mount, so the diff in
		// pushUpdate starts from nothing known
		lastPush = '';
		const placed = windowPlacement(
			config.window,
			screen.getAllDisplays().map((d) => d.workArea)
		);
		win = new BrowserWindow({
			width: placed.width,
			height: placed.height,
			// both or neither: passing one alone would centre on the other axis
			...(placed.x !== undefined && placed.y !== undefined
				? { x: placed.x, y: placed.y }
				: {}),
			minWidth: WINDOW.minWidth,
			minHeight: WINDOW.minHeight,
			title: appLabel,
			// a tray utility has no business taking over the screen — and
			// leaving fullscreen off keeps maximize as the one grow gesture
			fullscreenable: false,
			icon: nativeImage.createFromPath(iconPng),
			autoHideMenuBar: true,
			backgroundColor: nativeTheme.shouldUseDarkColors ? '#14170f' : '#f1efe8',
			webPreferences: {
				preload: join(import.meta.dirname, '../preload/index.mjs'),
				sandbox: false
			}
		});
		if (placed.maximized) win.maximize();
		// electron types these per-event, so no loop over the four
		win.on('resize', rememberBounds);
		win.on('move', rememberBounds);
		win.on('maximize', rememberBounds);
		win.on('unmaximize', rememberBounds);
		win.webContents.setWindowOpenHandler(({ url }) => {
			void shell.openExternal(url);
			return { action: 'deny' };
		});
		win.webContents.on('will-navigate', (e, url) => {
			// the app is a single page — any link is meant for the browser
			if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\u0000')) {
				e.preventDefault();
				void shell.openExternal(url);
			}
		});
		win.on('close', () => {
			// last chance to persist the size, whether we are closing or quitting
			saveBounds();
			// The window is genuinely destroyed rather than hidden: a hidden one
			// kept its renderer resident (~190 MB) and the GPU process warm for
			// days, to show nobody anything. Rebuilding it on the next tray click
			// costs a few hundred ms and the renderer re-reads the snapshot on
			// mount, so nothing is lost. The app itself lives in the tray;
			// window-all-closed deliberately does not quit.
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

let boundsTimer: ReturnType<typeof setTimeout> | null = null;

/** resize and move fire continuously while dragging — write once it settles */
function rememberBounds(): void {
	if (boundsTimer) clearTimeout(boundsTimer);
	boundsTimer = setTimeout(saveBounds, 400);
}

function saveBounds(): void {
	if (boundsTimer) {
		clearTimeout(boundsTimer);
		boundsTimer = null;
	}
	if (!win || win.isDestroyed()) return;
	// the normal bounds, not the current ones: unmaximizing after a restart
	// should land the window back where it was before it was maximized
	const b = win.getNormalBounds();
	const next: WindowBounds = {
		width: b.width,
		height: b.height,
		// Wayland never lets an app place its own window, so a position saved
		// there is junk that would only mislead a later X11 session
		...(isWayland ? {} : { x: b.x, y: b.y }),
		maximized: win.isMaximized()
	};
	if (JSON.stringify(next) === JSON.stringify(config.window)) return;
	config.window = next;
	saveConfig(userData, config);
}

/**
 * Linux: install the desktop entry + themed icon that the compositor looks
 * up for the window icon (and that puts the app in the launcher menu).
 * Idempotent and best-effort — AppImages are not installed by default, so
 * the app does it itself on every start.
 */
function installDesktopEntry(): void {
	if (process.platform !== 'linux') return;
	try {
		const home = app.getPath('home');
		const appsDir = join(home, '.local/share/applications');
		const desktopFile = join(appsDir, `${desktopId}.desktop`);
		const entry = `[Desktop Entry]
Type=Application
Name=${appLabel}
Comment=Undead Assault Reborn companion — replay uploads and live lobby status
Exec="${process.env.APPIMAGE ?? process.execPath}"${launchFlags()}
Icon=${desktopId}
Terminal=false
Categories=Game;
StartupWMClass=${desktopId}
`;
		let changed = false;
		if (readIfExists(desktopFile) !== entry) {
			mkdirSync(appsDir, { recursive: true });
			writeFileSync(desktopFile, entry);
			changed = true;
		}

		// panels and menus request specific pixel sizes — a lone 512px file
		// is not found by most of them, so install the whole ladder
		const source = nativeImage.createFromPath(iconPng);
		for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
			const dir = join(home, `.local/share/icons/hicolor/${size}x${size}/apps`);
			const file = join(dir, `${desktopId}.png`);
			if (existsSync(file)) continue;
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, source.resize({ width: size, height: size }).toPNG());
			changed = true;
		}
		if (changed) refreshDesktopCaches(home);
	} catch (e) {
		log(`desktop entry install skipped: ${e}`);
	}
}

/**
 * AppImages need FUSE; systems without it can only run them via
 * --appimage-extract-and-run. When we were started that way (the runtime
 * unpacks to /tmp/appimage_extracted_* instead of mounting at /tmp/.mount_*),
 * carry the flag into the entries we write, or launching from the menu or
 * at login would fail the way a plain double-click does.
 */
function launchFlags(): string {
	const dir = process.env.APPDIR ?? '';
	return dir.includes('appimage_extracted') ? ' --appimage-extract-and-run' : '';
}

function readIfExists(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/** Icon and menu caches are mmap'd — new files stay invisible until the
 * desktop environment rebuilds them. Best-effort, never blocking. */
function refreshDesktopCaches(home: string): void {
	const cmds: [string, string[]][] = [
		['update-desktop-database', [join(home, '.local/share/applications')]],
		['gtk-update-icon-cache', ['-f', '-t', join(home, '.local/share/icons/hicolor')]],
		['kbuildsycoca6', ['--noincremental']]
	];
	for (const [cmd, args] of cmds) {
		try {
			spawn(cmd, args, { detached: true, stdio: 'ignore' })
				.on('error', () => {})
				.unref();
		} catch {
			// tool not installed — the environment picks the change up on its own
		}
	}
}

function applyAutostart(enabled: boolean): void {
	if (process.platform === 'linux') {
		const dir = join(app.getPath('appData'), 'autostart');
		const desktop = join(dir, 'uar-companion.desktop');
		if (!enabled) {
			rmSync(desktop, { force: true });
			return;
		}
		const exec = process.env.APPIMAGE ?? process.execPath;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			desktop,
			`[Desktop Entry]\nType=Application\nName=${appLabel}\nIcon=${desktopId}\nExec="${exec}"${launchFlags()} --hidden\nX-GNOME-Autostart-enabled=true\n`
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
			lobbyToast = NO_LOBBY_TOAST;
			presenceMuteUntil = 0;
			void sseLoop();
			void fetchMe(server()).then((m) => {
				me = m;
				if (sc2) void heartbeat();
				pushUpdate();
			});
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
	ipcMain.handle('open-github', () =>
		void shell.openExternal('https://github.com/Geptyro/uar-companion')
	);
	ipcMain.handle('open-log', () => void shell.openPath(logPath));
	ipcMain.handle('download-update', () => {
		downloadUpdate();
		return snapshot();
	});
	ipcMain.handle('install-update', () => {
		if (!updateVersion) return;
		if (process.env.UAR_COMPANION_TEST_UPDATE) {
			log(`install-update clicked (test hook, would install v${updateVersion})`);
			return;
		}
		electronUpdater.autoUpdater.quitAndInstall();
	});
	ipcMain.handle('login', async () => {
		await openLogin(server());
		me = await fetchMe(server());
		log(me ? `signed in as ${me.battletag}` : 'sign-in window closed without a session');
		if (me && sc2) void heartbeat();
		await pollReady();
		return snapshot();
	});
	ipcMain.handle('logout', async () => {
		await logout(server());
		me = null;
		meReady = false;
		meUntil = null;
		pushUpdate();
		return snapshot();
	});
	ipcMain.handle('set-ready', async (_e, on: boolean) => {
		if (me) {
			if (!(await setReadyFlag(server(), on))) log('setting the ready flag failed');
			await pollReady();
		}
		return snapshot();
	});
}

async function toggleMyReady(): Promise<void> {
	if (!me) return;
	if (!(await setReadyFlag(server(), !meReady))) log('setting the ready flag failed');
	await pollReady();
}

/**
 * Heartbeats the SC2 presence to the site (contract agreed with the
 * website session; harmless 404s until POST /api/presence ships there).
 */
/** What goes over the wire: the local pairs are resolved to `selfName`. */
type PresenceBeat = Omit<SC2Presence, 'members'> & { selfName?: string };

async function heartbeat(): Promise<void> {
	const account = me;
	if (!account || Date.now() < presenceMuteUntil) return;
	let beat: PresenceBeat | null = null;
	if (sc2) {
		// tell the server which roster entry is us, so it can show the whole
		// lobby/game and still mark the players it knows. The lobby file
		// pairs profile names with account battletags — ours is the match.
		const { members, ...rest } = sc2;
		// the lobby file carries "Name#123", the in-game roster only "Name" —
		// send the bare name so it lines up with the roster entries
		const profile = members?.find((m) => m.battletag === account.battletag)?.profile;
		const selfName = profile ? bareProfileName(profile) : undefined;
		beat = selfName ? { ...rest, selfName } : rest;
	}
	const status = await sendPresence(server(), beat);
	if (status === 404) presenceMuteUntil = Date.now() + 60 * 60_000;
}

/** What the last probe found, so a 4 s poll only logs when it changes. */
let lastLobbyProbe = '';

/**
 * Reads SC2's battlelobby temp file for the watcher, and says in the log
 * what it found. A missing file is why a player reports no `lobbyId`, which
 * is what makes the site work harder to tell whose game is whose — and the
 * paths are guesswork on any OS we have not sat in front of, so the log has
 * to name the globs it tried. Silent in a lobby: the file genuinely does not
 * exist yet there (docs/sc2-detection.md), only a game should have one.
 */
function readBattleLobby(status: 'lobby' | 'ingame'): Uint8Array | null {
	const path = findBattleLobby();
	const probe = `${status}:${path ?? 'none'}`;
	const changed = probe !== lastLobbyProbe;
	lastLobbyProbe = probe;
	if (path === null) {
		if (changed && status === 'ingame') {
			log(`battlelobby: not found in a game — tried ${battleLobbyGlobs().join(' | ')}`);
		}
		return null;
	}
	try {
		const raw = readFileSync(path);
		if (changed) log(`battlelobby: ${path} (${raw.length} bytes)`);
		return raw;
	} catch (e) {
		if (changed) log(`battlelobby: ${path} unreadable — ${e instanceof Error ? e.message : e}`);
		return null;
	}
}

function onSC2Change(presence: SC2Presence | null): void {
	sc2 = presence;
	log(
		`sc2: ${presence ? `${presence.status}${presence.uar ? ' (UAR)' : ''}${presence.players ? `, ${presence.players} players` : ''}${presence.lobbyId ? `, lobby ${presence.lobbyId}` : ''}` : 'not running'}`
	);
	void heartbeat();
	// in a lobby or game = not looking anymore: withdraw the ready flag
	// (the server enforces the same rule on heartbeats)
	if (presence && presence.status !== 'menus' && me && meReady) {
		void (async () => {
			if (await setReadyFlag(server(), false)) {
				log(`ready flag withdrawn — ${presence.status === 'ingame' ? 'game started' : 'joined a lobby'}`);
				await pollReady();
			}
		})();
	}
	pushUpdate();
}

/**
 * Downloads the pending release. Deliberately not automatic: the artifact is
 * north of 100 MB, and pulling it at full speed the moment a release lands is
 * felt as lag in whatever the user is playing — the one thing a companion
 * must never cause. So the app says an update is there and the user picks the
 * moment; autoInstallOnAppQuit then applies it without a second gesture.
 */
function downloadUpdate(): void {
	if (!updateAvailable || updateDownloading || updateVersion) return;
	updateDownloading = updateAvailable;
	log(`downloading update v${updateAvailable}`);
	pushUpdate();
	void electronUpdater.autoUpdater.downloadUpdate().catch((e: Error) => {
		updateDownloading = null;
		log(`update download failed: ${e.message}`);
		pushUpdate();
	});
}

function initAutoUpdate(): void {
	// unsigned macOS builds cannot auto-update (Squirrel.Mac requires signing)
	if (!app.isPackaged || process.platform === 'darwin') return;
	const { autoUpdater } = electronUpdater;
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.on('update-available', (info) => {
		if (updateAvailable === info.version) return;
		updateAvailable = info.version;
		log(`update v${info.version} available`);
		pushUpdate();
	});
	autoUpdater.on('update-downloaded', (info) => {
		updateDownloading = null;
		updateAvailable = null;
		updateVersion = info.version;
		log(`update v${info.version} downloaded — restart to apply`);
		pushUpdate();
	});
	autoUpdater.on('error', (e) => {
		updateDownloading = null;
		log(`auto-update: ${e.message}`);
		pushUpdate();
	});
	const check = () => {
		// with an update already downloaded there is nothing left to learn
		// until the restart: checkForUpdates would find the same version
		// (isUpdateAvailable compares against the running one), take the
		// cached file, and re-fire update-downloaded on every tick
		if (updateVersion || updateDownloading) return;
		void autoUpdater.checkForUpdates().catch(() => {});
	};
	check();
	// the app normally sits in the tray for days on end, so this interval —
	// not a relaunch — is what actually notices a release on a running install
	setInterval(check, 10 * 60 * 1000);
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {
	// tray app: stay alive with no windows
});
app.on('before-quit', () => {
	abort?.abort();
	sseAbort?.abort();
	stopSC2?.();
	if (me && sc2) void sendPresence(server(), null); // best-effort clear
	toastWin?.destroy();
});

void app.whenReady().then(() => {
	if (!isPrimary) return;
	app.setAppUserModelId('dev.cedricdessalles.uar-companion');
	// test/dev hook: pin the theme regardless of the OS setting
	if (process.env.UAR_COMPANION_THEME === 'light' || process.env.UAR_COMPANION_THEME === 'dark') {
		nativeTheme.themeSource = process.env.UAR_COMPANION_THEME;
	}
	store = new Store(userData);
	log(`uar-companion ${app.getVersion()} starting (server ${server()})`);

	tray = new Tray(nativeImage.createFromPath(process.platform === 'win32' ? iconIco : iconPng));
	tray.on('click', showWindow);

	installDesktopEntry();
	// the autostart entry stores the path we were launched from, so refresh
	// it on every start: after a manual upgrade the old path is gone and
	// login would silently start nothing
	if (config.autostart) applyAutostart(true);
	wireIpc();
	startWatcher();
	void fetchMe(server()).then((m) => {
		me = m;
		// the SC2 watcher may have beaten sign-in resolution (restart while
		// already in a lobby/game) — its heartbeat was skipped without `me`
		if (sc2) void heartbeat();
		pushUpdate();
	});
	void pollReady();
	void sseLoop();
	initAutoUpdate();
	// in a lobby /game is empty — the battlelobby temp file identifies UAR,
	// carries the lobbyId and the member battletags
	stopSC2 = watchSC2(onSC2Change, undefined, readBattleLobby);
	// fallback cadence: catches silent flag expiries and any missed events;
	// presence re-heartbeats alongside so the server's ~2 min staleness never
	// trips while SC2 is up
	setInterval(() => {
		void pollReady();
		if (sc2) void heartbeat();
	}, 60_000);

	if (!process.argv.includes('--hidden')) showWindow();
	if (!config.firstRunDone) {
		config.firstRunDone = true;
		saveConfig(userData, config);
	}

	// smoke-test hook: show the update pill without waiting for a real release
	// (the indicator is otherwise unverifiable until a newer version exists)
	if (process.env.UAR_COMPANION_TEST_UPDATE) {
		updateVersion = process.env.UAR_COMPANION_TEST_UPDATE;
		pushUpdate();
	}

	// smoke-test hook: render a toast without waiting for a real roster change
	if (process.env.UAR_COMPANION_TEST_TOAST) {
		setTimeout(
			() => showToast('Znimu#743 is ready to play', '3 players ready on uar.cedricdessalles.dev'),
			1500
		);
	}
});
