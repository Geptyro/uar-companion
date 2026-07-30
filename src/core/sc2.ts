/**
 * SC2 local client API (http://localhost:6119 — plain HTTP, JSON, only
 * responds while the game runs; no CORS, so this must run in the main
 * process). Derives a presence state:
 *   menus | lobby | ingame  (+ whether the game/lobby is UAR)
 * UAR fingerprint: the map name is not exposed, but a UAR game always has
 * the computer slots `UT Army` + `Undead` + `PMC` (map script's NPC /
 * hostile / PMC owners).
 */

export interface SC2Presence {
	status: 'menus' | 'lobby' | 'ingame';
	uar: boolean;
	/** human players in the current game/lobby */
	players?: number;
	/** game clock, seconds */
	displayTime?: number;
	/**
	 * In game: sorted human display names (identical for every member of
	 * the same game — the server's grouping key). In a lobby: battletags
	 * from the battlelobby file.
	 */
	roster?: string[];
	/**
	 * m_randomValue from the battlelobby file — the exact id the replay
	 * pipeline dedupes by. Read in the lobby, kept sticky through the game
	 * (SC2 deletes the file when the game ends). Null when unavailable.
	 */
	lobbyId?: number | null;
	/** (profile name#code, account battletag) pairs from the lobby file. */
	members?: { profile: string; battletag: string }[];
}

interface UiResponse {
	activeScreens?: string[];
}

interface GameResponse {
	isReplay?: boolean;
	displayTime?: number;
	players?: { id: number; name: string; type: string; race: string; result: string }[];
}

const UAR_COMPUTERS = ['UT Army', 'Undead', 'PMC'];

/**
 * Battle.net cache (s2ma) content hashes of the UAR map + its dependency
 * mods (captured 2026-07-26). The lobby temp file lists the cache paths of
 * whatever map the lobby runs in plain text, so ANY match identifies a UAR
 * lobby — and since the dependency mods update far more rarely than the
 * map itself, the set survives map patches.
 */
export const UAR_CACHE_HASHES = [
	'b2aae897f9bf390f176804ca29a8122e13793a3b822729052c95e98433da8b27', // map
	'0d3d8ff1130e7f23114434dbf7be825a0551266fc47f486987b05b6e6316b809', // UAR data
	'17fc157a1ad85f60157156af5f715c346e797837d801c1cd7cd760ea57c7d6d6', // UAR imports
	'1f57da6a57129d81a344229d1b15ca673baeb31cbc994ff5edb35ba9d67482e9', // UAR models
	'f7fc47357ec4608257d28c59712c83ab8152dfd690588d0168818ef34946ac33', // UAR Music
	'b69ed1d286c8d066ab7ad378720fdc8d48e5ebf65202cc4b828c66a6e5e3798f', // UAR Music Xariel
	'ae8dd1234e4db87916abefc786c1c879c4120bac07f235d1e70928de1c3766d8', // UAR sounds
	'c230bf9602012883256960f36ad10260952525be4b94c7649bf31fb39c66cce4' // Monster Pack
];

/** Does a replay.server.battlelobby blob reference the UAR map or mods? */
export function isUarBattleLobby(data: Uint8Array): boolean {
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return UAR_CACHE_HASHES.some((h) => buf.includes(h));
}

export interface BattleLobbyInfo {
	uar: boolean;
	/** m_randomValue — the same id the replay pipeline dedupes games by. */
	lobbyId: number | null;
	/** Account battletags of the lobby members (ASCII names only). */
	battletags: string[];
	/** (profile name#code, account battletag) pairs when cleanly paired. */
	members?: { profile: string; battletag: string }[];
}

/**
 * A profile name without the character code the battlelobby file appends
 * ("KanaxStratz#451" -> "KanaxStratz"). The SC2 client's own roster and the
 * website's player pages both use the bare form, so anything leaving this
 * app does too. Kept here rather than taken from uar-shared: core stays
 * installable-free of the UI package, and one regex is not worth a release
 * ordering between the two repos.
 */
export function bareProfileName(profile: string): string {
	return profile.replace(/#\d+$/, '');
}

/** 01 00 00/01 00 markers follow most zero-padding runs — never an id. */
const RUN_MARKERS = new Set([0x01000000, 0x01000100]);

/**
 * Fixed 10-byte structure marker that trails the lobbyId block: the id is
 * the big-endian uint32 14 bytes ahead of it. Verified against three real
 * lobbies (two solo, one 12-player) whose ids were decoded from their
 * replays — one hit per file, exact match every time.
 */
const ID_SIGNATURE = Buffer.from('020014cc020000000100', 'hex');
const ID_SIGNATURE_BACKOFF = 14;

/**
 * Extracts what is byte-readable from a replay.server.battlelobby blob
 * without a full decoder (the format is a bit-packed initdata variant, but
 * three things happen to be byte-aligned):
 *  - the map's cache hashes (plain ASCII paths)      → UAR yes/no
 *  - the lobbyId, big-endian right after the file's
 *    longest zero-padding run (calibrated against a
 *    real replay's m_randomValue, 2026-07-26)        → grouping key
 *  - the members' battletags (Name#1234, plain)      → roster
 * A leading-zero lobbyId byte gets swallowed by the zero-run anchor
 * (~0.4 % of ids) — the extractor returns null then, and the server can
 * cross-check ids against uploaded replays anyway.
 */
export function parseBattleLobby(data: Uint8Array): BattleLobbyInfo {
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);

	let lobbyId: number | null = null;
	let idOff = -1;

	// primary: the structure marker that trails the id (works regardless of
	// lobby size, and reads leading-zero ids correctly)
	const sig = buf.indexOf(ID_SIGNATURE);
	if (sig >= ID_SIGNATURE_BACKOFF && buf.indexOf(ID_SIGNATURE, sig + 1) === -1) {
		idOff = sig - ID_SIGNATURE_BACKOFF;
		lobbyId = buf.readUInt32BE(idOff);
	} else {
		// fallback (marker moved after a map/patch change): the id follows
		// the LAST zero-padding run of >= 64 bytes. Earlier long runs exist,
		// each closed by a 01 00 00 00-style marker that must not be read as
		// an id, and a swallowed leading zero misreads — null beats wrong,
		// since roster grouping then takes over.
		let runStart = -1;
		for (let i = 0; i <= buf.length; i++) {
			if (i < buf.length && buf[i] === 0) {
				if (runStart === -1) runStart = i;
			} else {
				if (runStart !== -1 && i - runStart >= 64) idOff = i;
				runStart = -1;
			}
		}
		if (idOff >= 0 && idOff + 4 <= buf.length) {
			const v = buf.readUInt32BE(idOff);
			if (v >= 0x01000000 && !RUN_MARKERS.has(v)) lobbyId = v;
		}
	}

	// roster region = everything after the id block; tags come in
	// (profile name#code, account battletag) pairs per member
	const rosterFrom = idOff >= 0 ? idOff : 0;
	const all = [
		...new Set(
			[...buf.toString('latin1').matchAll(/[A-Za-z][A-Za-z0-9]{2,11}#\d{3,8}/g)]
				.filter((m) => (m.index ?? 0) > rosterFrom)
				.map((m) => m[0])
		)
	];
	let battletags = all;
	let members: BattleLobbyInfo['members'];
	if (all.length >= 2 && all.length % 2 === 0) {
		members = [];
		for (let i = 0; i < all.length; i += 2) {
			members.push({ profile: all[i], battletag: all[i + 1] });
		}
		battletags = members.map((m) => m.battletag);
	}

	return { uar: isUarBattleLobby(data), lobbyId, battletags, members };
}

/** Pure derivation, unit-testable without a running SC2. */
export function derivePresence(ui: UiResponse, game: GameResponse | null): SC2Presence {
	const screens = ui.activeScreens ?? [];
	const status: SC2Presence['status'] =
		screens.length === 0
			? 'ingame'
			: screens.some((s) => s.includes('BattleLobby'))
				? 'lobby'
				: 'menus';
	// /game keeps serving the PREVIOUS game's data while sitting in a new
	// lobby — only trust it in-game; the battlelobby file covers lobbies
	if (status !== 'ingame' || !game?.players?.length || game.isReplay) {
		return { status, uar: false };
	}
	const computers = game.players.filter((p) => p.type === 'computer').map((p) => p.name);
	const humans = game.players
		.filter((p) => p.type === 'user')
		.map((p) => p.name)
		.sort();
	return {
		status,
		uar: UAR_COMPUTERS.every((n) => computers.includes(n)),
		players: humans.length,
		displayTime: game.displayTime !== undefined ? Math.round(game.displayTime) : undefined,
		roster: humans
	};
}

export const SC2_POLL_UP = 4_000;
export const SC2_POLL_DOWN = 30_000;

/**
 * Polls the client API and reports presence changes; `null` = SC2 not
 * running. `readLobbyFile` (optional) returns the battlelobby temp file's
 * bytes — parsed for UAR identity, lobbyId and roster while in a lobby
 * (where /game is empty), and kept sticky through the game. It receives the
 * current status, because a miss means nothing in a lobby (the file does not
 * exist yet) and means a lost lobbyId in a game. Stop via the returned
 * function.
 */
export function watchSC2(
	onChange: (presence: SC2Presence | null) => void,
	base = 'http://localhost:6119',
	readLobbyFile?: (status: 'lobby' | 'ingame') => Uint8Array | null
): () => void {
	let stopped = false;
	let last = 'init';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastLobby: BattleLobbyInfo | null = null;

	async function probe(): Promise<SC2Presence | null> {
		let ui: UiResponse;
		try {
			const r = await fetch(`${base}/ui`, { signal: AbortSignal.timeout(2_000) });
			if (!r.ok) return null;
			ui = (await r.json()) as UiResponse;
		} catch {
			return null; // connection refused — SC2 not running
		}
		let game: GameResponse | null = null;
		try {
			const r = await fetch(`${base}/game`, { signal: AbortSignal.timeout(2_000) });
			if (r.ok) game = (await r.json()) as GameResponse;
		} catch {
			// /ui answered, /game hiccupped — derive from the screen list alone
		}
		const presence = derivePresence(ui, game);
		if (presence.status === 'menus') {
			lastLobby = null;
			return presence;
		}
		if (readLobbyFile) {
			let info: BattleLobbyInfo | null = null;
			try {
				const raw = readLobbyFile(presence.status);
				if (raw) info = parseBattleLobby(raw);
			} catch {
				// battlelobby unreadable — fall back to whatever we knew
			}
			if (info) lastLobby = info;
			// during the game the file may already be gone — stay sticky
			const eff = info ?? (presence.status === 'ingame' ? lastLobby : null);
			if (eff) {
				presence.lobbyId = eff.lobbyId;
				if (!presence.uar) presence.uar = eff.uar;
				// lobby rosters use the in-game profile names, like the
				// in-game roster does — consistent for the UI, and less
				// exposing than the account battletags of people who never
				// installed anything. Without the character code the file
				// carries ("Name#451"): the in-game roster and the site's
				// player pages both spell a profile bare, and sending the
				// code meant no roster line ever matched a reporter, so the
				// site listed everyone twice — once by name, once by tag.
				const names = eff.members?.map((m) => bareProfileName(m.profile)) ?? eff.battletags;
				if (presence.status === 'lobby' && names.length > 0) {
					presence.players = names.length;
					presence.roster = names;
				}
				// which roster entry is us: the pair carrying our battletag
				presence.members = eff.members;
			}
		}
		return presence;
	}

	async function tick(): Promise<void> {
		if (stopped) return;
		const presence = await probe();
		// the game clock ticks on every poll — bucket it to minutes so only
		// material changes count as changes (heartbeats, logs, UI pushes)
		const key = JSON.stringify(
			presence === null
				? null
				: { ...presence, displayTime: Math.floor((presence.displayTime ?? 0) / 60) }
		);
		if (key !== last) {
			last = key;
			onChange(presence);
		}
		timer = setTimeout(() => void tick(), presence === null ? SC2_POLL_DOWN : SC2_POLL_UP);
	}

	void tick();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
