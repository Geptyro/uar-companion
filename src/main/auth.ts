/**
 * Battle.net sign-in, reusing the website's own OAuth flow: the login popup
 * walks through {server}/auth/bnet exactly like a browser would, and the
 * site's session cookie lands in Chromium's (persistent) cookie jar. All
 * authenticated calls then go through net.fetch — Chromium's network stack —
 * which sends that cookie automatically. No OAuth client, no secrets, no
 * new server code.
 */
import { BrowserWindow, net, session } from 'electron';
import {
	parseMe,
	parseReadyRoster,
	parsePresenceList,
	type Me,
	type ReadyRoster,
	type PresenceEntry
} from '../core/api.ts';

export type { Me, ReadyRoster, PresenceEntry };

function nf(url: string, init?: { method?: string }): Promise<Response> {
	return net.fetch(url, {
		method: init?.method ?? 'GET',
		headers: {
			accept: 'application/json',
			// adapter-node trusts same-origin requests only
			origin: url.split('/', 3).join('/')
		}
	});
}

export async function fetchMe(server: string): Promise<Me | null> {
	try {
		const r = await nf(`${server}/api/me`);
		if (!r.ok) return null;
		return parseMe(await r.json());
	} catch {
		return null;
	}
}

/** Roster + own flag in one authenticated call (GET /api/ready). */
export async function fetchReadyRoster(server: string): Promise<ReadyRoster> {
	const r = await nf(`${server}/api/ready`);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return parseReadyRoster(await r.json());
}

export async function setReadyFlag(server: string, on: boolean): Promise<boolean> {
	try {
		const r = await nf(`${server}/api/ready`, { method: on ? 'POST' : 'DELETE' });
		return r.ok;
	} catch {
		return false;
	}
}

/**
 * Opens the site's Battle.net login in a popup; resolves when the window
 * closes (after the flow lands back on the site, or the user gives up).
 */
export function openLogin(server: string): Promise<void> {
	return new Promise((resolve) => {
		const win = new BrowserWindow({
			width: 520,
			height: 760,
			autoHideMenuBar: true,
			title: 'Sign in with Battle.net',
			webPreferences: { sandbox: true }
		});
		// OAuth pages sometimes refuse browsers that advertise an embedded shell
		win.webContents.setUserAgent(
			win.webContents.getUserAgent().replace(/ (Electron|uar-companion)\/[^ ]+/g, '')
		);
		win.webContents.on('did-navigate', (_e, url) => {
			// back from Blizzard on any site page other than the flow start:
			// the session cookie is set (or the error page shown) — wrap up
			if (url.startsWith(server) && !url.includes('/auth/bnet')) {
				setTimeout(() => {
					if (!win.isDestroyed()) win.close();
				}, 1200);
			}
		});
		win.on('closed', () => resolve());
		void win.loadURL(`${server}/auth/bnet`);
	});
}

/**
 * Who is currently in a lobby or game (GET /api/presence, public). Returns
 * null while the endpoint doesn't exist yet (404) or is unreachable.
 */
export async function fetchPresenceList(server: string): Promise<PresenceEntry[] | null> {
	try {
		const r = await nf(`${server}/api/presence`);
		if (!r.ok) return null;
		return parsePresenceList(await r.json());
	} catch {
		return null;
	}
}

/**
 * SC2 presence heartbeat (POST /api/presence, cookie-authenticated); null
 * clears it (DELETE). Returns the HTTP status, 0 on network failure — the
 * caller mutes itself on 404 until the server side ships.
 */
export async function sendPresence(
	server: string,
	presence: {
		status: string;
		uar: boolean;
		players?: number;
		displayTime?: number;
		roster?: string[];
		lobbyId?: number | null;
		/** our own entry in `roster` (profile name), when known */
		selfName?: string;
	} | null
): Promise<number> {
	try {
		const r = await net.fetch(`${server}/api/presence`, {
			method: presence ? 'POST' : 'DELETE',
			headers: {
				accept: 'application/json',
				origin: server,
				...(presence ? { 'content-type': 'application/json' } : {})
			},
			...(presence ? { body: JSON.stringify(presence) } : {})
		});
		return r.status;
	} catch {
		return 0;
	}
}

export async function logout(server: string): Promise<void> {
	const jar = session.defaultSession.cookies;
	for (const c of await jar.get({ url: server })) {
		await jar.remove(server, c.name).catch(() => {});
	}
}
