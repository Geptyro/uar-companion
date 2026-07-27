/**
 * Pure response-shape mappers for the website's JSON APIs — kept free of
 * Electron imports so they are unit-testable; src/main/auth.ts wraps them
 * with cookie-carrying net.fetch calls.
 */

import type { PresenceGroup } from 'uar-shared/presence';

export interface Me {
	battletag: string;
	avatar: string | null;
	toon: string | null;
}

export interface ReadyRoster {
	meReady: boolean;
	meUntil: string | null;
	players: { battletag: string; avatar: string | null; until: string }[];
}

export interface PresenceEntry {
	battletag: string;
	avatar: string | null;
	toon: string | null;
	status: 'lobby' | 'ingame';
	uar: boolean;
	players?: number;
	displayTime?: number;
	roster?: string[];
	lobbyId?: number | null;
	/** the reporter's own entry in `roster` — groups them when the id is missing */
	selfName?: string;
}

/** GET /api/me — null when nobody is signed in. */
export function parseMe(body: unknown): Me | null {
	const b = body as { battletag?: string | null; avatar?: string | null; toon?: string | null };
	if (!b || typeof b.battletag !== 'string' || b.battletag === '') return null;
	return { battletag: b.battletag, avatar: b.avatar ?? null, toon: b.toon ?? null };
}

/** GET /api/ready — roster plus own flag. */
export function parseReadyRoster(body: unknown): ReadyRoster {
	const b = body as {
		me?: boolean;
		until?: string | null;
		players?: { battletag: string; avatar?: string | null; until: string }[];
	};
	return {
		meReady: b?.me === true,
		meUntil: b?.until ?? null,
		players: (b?.players ?? []).map((p) => ({
			battletag: p.battletag,
			avatar: p.avatar ?? null,
			until: p.until
		}))
	};
}

export type PresenceSplit = {
	lobbies: PresenceGroup<PresenceEntry>[];
	games: PresenceGroup<PresenceEntry>[];
};

export interface PresencePayload {
	players: PresenceEntry[];
	/** in-game name → the player the site knows under it */
	known: Record<string, { toon: string; avatar?: string }>;
	/**
	 * The site's own grouping of `players` into lobbies and games — it owns
	 * that rule so every client agrees and it can change without an app
	 * release. Undefined against a server that predates the field; group
	 * locally with `splitPresence` then.
	 */
	groups?: PresenceSplit;
}

/** GET /api/presence — who is in a lobby/game, plus the names the site knows. */
export function parsePresence(body: unknown): PresencePayload {
	const b = body as { known?: PresencePayload['known']; groups?: unknown };
	const groups = parsePresenceSplit(b?.groups);
	return {
		players: parsePresenceList(body),
		known: b?.known ?? {},
		...(groups ? { groups } : {})
	};
}

export function parsePresenceList(body: unknown): PresenceEntry[] {
	const b = body as { players?: PresenceEntry[] };
	return (b?.players ?? []).map(parsePresenceEntry);
}

function parsePresenceEntry(p: PresenceEntry): PresenceEntry {
	return {
		battletag: p.battletag,
		avatar: p.avatar ?? null,
		toon: p.toon ?? null,
		status: p.status,
		uar: p.uar === true,
		players: p.players,
		displayTime: p.displayTime,
		roster: p.roster,
		lobbyId: p.lobbyId ?? null,
		selfName: p.selfName
	};
}

/** The server's lobby/game split, or undefined when it sent none. */
function parsePresenceSplit(raw: unknown): PresenceSplit | undefined {
	const g = raw as { lobbies?: unknown; games?: unknown } | undefined;
	if (!g || typeof g !== 'object') return undefined;
	if (!Array.isArray(g.lobbies) || !Array.isArray(g.games)) return undefined;
	return { lobbies: g.lobbies.map(parsePresenceGroup), games: g.games.map(parsePresenceGroup) };
}

function parsePresenceGroup(g: PresenceGroup<PresenceEntry>): PresenceGroup<PresenceEntry> {
	return {
		key: g.key,
		status: g.status,
		uar: g.uar === true,
		players: g.players ?? 0,
		displayTime: g.displayTime,
		members: (g.members ?? []).map(parsePresenceEntry)
	};
}
