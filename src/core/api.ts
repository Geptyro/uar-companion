/**
 * Pure response-shape mappers for the website's JSON APIs — kept free of
 * Electron imports so they are unit-testable; src/main/auth.ts wraps them
 * with cookie-carrying net.fetch calls.
 */

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

export interface PresencePayload {
	players: PresenceEntry[];
	/** in-game name → the player the site knows under it */
	known: Record<string, { toon: string; avatar?: string }>;
}

/** GET /api/presence — who is in a lobby/game, plus the names the site knows. */
export function parsePresence(body: unknown): PresencePayload {
	return { players: parsePresenceList(body), known: (body as { known?: PresencePayload['known'] })?.known ?? {} };
}

export function parsePresenceList(body: unknown): PresenceEntry[] {
	const b = body as { players?: PresenceEntry[] };
	return (b?.players ?? []).map((p) => ({
		battletag: p.battletag,
		avatar: p.avatar ?? null,
		toon: p.toon ?? null,
		status: p.status,
		uar: p.uar === true,
		players: p.players,
		displayTime: p.displayTime,
		roster: p.roster,
		lobbyId: p.lobbyId ?? null
	}));
}
