import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLobbyToast, listNames, NO_LOBBY_TOAST } from '../src/core/lobby.ts';

const GAP = 10 * 60_000;
const base = { me: 'Me#1', enabled: true, now: 1_000_000, gapMs: GAP };

/** Feeds successive polls through the decision, collecting what it announced. */
function poll(rounds: { members: string[]; now?: number; me?: string | null; enabled?: boolean }[]) {
	let state = NO_LOBBY_TOAST;
	const toasts: (string[] | null)[] = [];
	for (const r of rounds) {
		const out = decideLobbyToast(state, { ...base, ...r, members: r.members });
		state = out.state;
		toasts.push(out.toast);
	}
	return toasts;
}

test('decideLobbyToast: announces a lobby that forms after we are running', () => {
	const [first, formed] = poll([{ members: [] }, { members: ['A#1', 'B#2'] }]);
	assert.equal(first, null, 'the first poll only sets the baseline');
	assert.deepEqual(formed, ['A#1', 'B#2']);
});

test('decideLobbyToast: a lobby already open at startup is not news', () => {
	// the app launching into an existing lobby must not toast it
	const [first, again] = poll([{ members: ['A#1'] }, { members: ['A#1', 'B#2'] }]);
	assert.equal(first, null);
	assert.equal(again, null, 'joins do not re-announce a lobby we never announced');
});

test('decideLobbyToast: fires on the lobby forming, not on every join', () => {
	const toasts = poll([
		{ members: [] },
		{ members: ['A#1'] },
		{ members: ['A#1', 'B#2'] },
		{ members: ['A#1', 'B#2', 'C#3'] }
	]);
	assert.deepEqual(toasts, [null, ['A#1'], null, null]);
});

test('decideLobbyToast: our own lobby stays quiet', () => {
	assert.deepEqual(poll([{ members: [] }, { members: ['A#1', 'Me#1'] }]), [null, null]);
	// and signed out, nobody is "us"
	assert.deepEqual(poll([{ members: [] }, { members: ['A#1'], me: null }]), [null, ['A#1']]);
});

test('decideLobbyToast: the toggle silences it but keeps tracking', () => {
	const toasts = poll([
		{ members: [] },
		{ members: ['A#1'], enabled: false },
		{ members: [], enabled: false },
		{ members: ['B#2'], now: base.now + 1000 }
	]);
	assert.deepEqual(toasts, [null, null, null, ['B#2']], 'a later lobby still announces');
});

test('decideLobbyToast: a lobby blinking out and back is not a second lobby', () => {
	// presence goes stale after ~2 min without a heartbeat
	const toasts = poll([
		{ members: [] },
		{ members: ['A#1', 'B#2'] },
		{ members: [], now: base.now + 60_000 },
		{ members: ['A#1', 'B#2'], now: base.now + 90_000 },
		{ members: [], now: base.now + 120_000 },
		{ members: ['A#1', 'C#3'], now: base.now + 150_000 }
	]);
	assert.deepEqual(toasts, [null, ['A#1', 'B#2'], null, null, null, null]);
});

test('decideLobbyToast: the same faces past the gap are a genuinely new lobby', () => {
	const toasts = poll([
		{ members: [] },
		{ members: ['A#1'] },
		{ members: [], now: base.now + GAP + 1 },
		{ members: ['A#1'], now: base.now + GAP + 2 }
	]);
	assert.deepEqual(toasts, [null, ['A#1'], null, ['A#1']]);
});

test('decideLobbyToast: different players inside the gap do announce', () => {
	const toasts = poll([
		{ members: [] },
		{ members: ['A#1'] },
		{ members: [], now: base.now + 1000 },
		{ members: ['B#2', 'C#3'], now: base.now + 2000 }
	]);
	assert.deepEqual(toasts, [null, ['A#1'], null, ['B#2', 'C#3']]);
});

test('decideLobbyToast: members are announced in a stable order', () => {
	const [, toast] = poll([{ members: [] }, { members: ['C#3', 'A#1', 'B#2'] }]);
	assert.deepEqual(toast, ['A#1', 'B#2', 'C#3']);
});

test('listNames: two spelled out, more summarised', () => {
	assert.equal(listNames(['A']), 'A');
	assert.equal(listNames(['A', 'B']), 'A and B');
	assert.equal(listNames(['A', 'B', 'C']), 'A, B and 1 more');
	assert.equal(listNames(['A', 'B', 'C', 'D']), 'A, B and 2 more');
});
