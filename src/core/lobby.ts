/**
 * When a forming lobby is worth interrupting someone over — kept pure and
 * free of Electron so the rules are testable (main/index.ts owns the toast).
 *
 * The site collapses every open lobby into one group on purpose (nothing
 * observable tells two apart while they are open, see uar-shared
 * `groupPresence`), so "a lobby formed" is that group appearing at all.
 */

export interface LobbyToastState {
	/** Who was in the lobby last poll; null before the first one ever. */
	known: string[] | null;
	/** The lobby we last announced, for flap suppression. */
	last: { who: string[]; at: number } | null;
}

export const NO_LOBBY_TOAST: LobbyToastState = { known: null, last: null };

export interface LobbyToastInput {
	/** Battletags in the lobby group right now (empty = no lobby). */
	members: string[];
	/** Our own battletag, when signed in. */
	me: string | null;
	/** The user's notifyLobby setting. */
	enabled: boolean;
	now: number;
	/** A lobby with the same faces inside this window is the same lobby. */
	gapMs: number;
}

/**
 * `toast` is the battletags to announce, or null for "stay quiet". The
 * returned state must always replace the old one, announcement or not:
 * tracking who is in the lobby is what makes the *next* call correct.
 */
export function decideLobbyToast(
	state: LobbyToastState,
	input: LobbyToastInput
): { toast: string[] | null; state: LobbyToastState } {
	const members = [...input.members].sort();
	const quiet = { toast: null, state: { ...state, known: members } };

	// a lobby already open when we started, or when the server changed, is
	// not news — the first poll only establishes the baseline
	if (state.known === null) return quiet;
	// fires on the lobby appearing, not on every join: an already-populated
	// lobby that gains a member was announced when it formed
	if (members.length === 0 || state.known.length > 0) return quiet;
	if (!input.enabled) return quiet;
	// we are in it — we were there when it formed
	if (input.me !== null && members.includes(input.me)) return quiet;
	// presence goes stale after ~2 min without a heartbeat, so a lobby can
	// blink out and back; the same faces returning is that, not a new lobby
	if (
		state.last !== null &&
		input.now - state.last.at < input.gapMs &&
		members.some((m) => state.last!.who.includes(m))
	) {
		return quiet;
	}
	return { toast: members, state: { known: members, last: { who: members, at: input.now } } };
}

/** "A and B", "A, B and 3 more" — the toast headline's subject. */
export function listNames(names: string[]): string {
	if (names.length <= 2) return names.join(' and ');
	return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
