import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AppConfig {
	/** Explicit replay folders; empty = auto-detect. */
	dirs: string[];
	/** Skip replays that existed before the first run. */
	noBackfill: boolean;
	notifyUploads: boolean;
	notifyReady: boolean;
	/** Toast when a lobby forms on the site (see announceLobbyChanges). */
	notifyLobby: boolean;
	/** Opt-in: keep notifying while SC2 says we are in a lobby or a game. */
	notifyInGame: boolean;
	autostart: boolean;
	/** Override for development; empty = production site. */
	server: string;
	firstRunDone: boolean;
	/** Last window size/placement; absent until the window is resized. */
	window?: WindowBounds;
}

export interface WindowBounds {
	width: number;
	height: number;
	/** Absent on Wayland, where an app cannot place its own window. */
	x?: number;
	y?: number;
	maximized?: boolean;
}

export const DEFAULT_SERVER = 'https://uar.cedricdessalles.dev';

const DEFAULTS: AppConfig = {
	dirs: [],
	noBackfill: false,
	notifyUploads: true,
	notifyReady: true,
	notifyLobby: true,
	notifyInGame: false,
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

/**
 * Opening size on a fresh install, and the floor a resize may reach. Narrow
 * windows stack into one scrolling column, so the width floor is set by the
 * one row that cannot reflow — the top bar's chip cluster — and the height
 * floor only has to leave a card visible under it.
 */
export const WINDOW = { width: 900, height: 660, minWidth: 320, minHeight: 360 };

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowPlacement {
	width: number;
	height: number;
	/** Absent = let the platform centre the window. */
	x?: number;
	y?: number;
	maximized: boolean;
}

/** How much of the window must land on a screen to still be grabbable. */
const REACHABLE = 80;

/**
 * Saved bounds → options for a new window. The size is clamped to the app's
 * floor and to the largest screen; the position is only reused when the rect
 * still lands on one, so bounds saved on a monitor that is now gone cannot
 * reopen the window somewhere the user can't reach it.
 */
export function windowPlacement(
	saved: WindowBounds | undefined,
	workAreas: Rect[]
): WindowPlacement {
	const cap = (pick: (a: Rect) => number) =>
		workAreas.length > 0 ? Math.max(...workAreas.map(pick)) : Infinity;
	const width = fit(saved?.width, WINDOW.width, WINDOW.minWidth, cap((a) => a.width));
	const height = fit(saved?.height, WINDOW.height, WINDOW.minHeight, cap((a) => a.height));
	const placement: WindowPlacement = { width, height, maximized: saved?.maximized === true };
	const { x, y } = saved ?? {};
	if (isNum(x) && isNum(y) && reachable({ x, y, width, height }, workAreas)) {
		placement.x = Math.round(x);
		placement.y = Math.round(y);
	}
	return placement;
}

function reachable(rect: Rect, workAreas: Rect[]): boolean {
	const span = (a: number, b: number, c: number, d: number) => Math.min(b, d) - Math.max(a, c);
	return workAreas.some(
		(a) =>
			span(rect.x, rect.x + rect.width, a.x, a.x + a.width) >= REACHABLE &&
			span(rect.y, rect.y + rect.height, a.y, a.y + a.height) >= REACHABLE
	);
}

/** A hand-edited or stale config.json may hold anything — treat it as a hint. */
function fit(value: unknown, fallback: number, min: number, max: number): number {
	const n = isNum(value) ? Math.round(value) : fallback;
	return Math.min(Math.max(n, min), Math.max(min, max));
}

function isNum(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
