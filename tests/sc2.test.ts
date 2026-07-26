import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	derivePresence,
	isUarBattleLobby,
	parseBattleLobby,
	UAR_CACHE_HASHES
} from '../src/core/sc2.ts';

const uarSlots = [
	{ id: 13, name: 'UT Army', type: 'computer', race: 'Terr', result: 'Undecided' },
	{ id: 14, name: 'Undead', type: 'computer', race: 'Zerg', result: 'Undecided' },
	{ id: 15, name: 'PMC', type: 'computer', race: 'Terr', result: 'Undecided' }
];
const humans = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: i + 1,
		name: `Player${i}`,
		type: 'user',
		race: 'Terr',
		result: 'Undecided'
	}));

test('derives ingame UAR from empty screens + computer fingerprint', () => {
	const p = derivePresence(
		{ activeScreens: [] },
		{ isReplay: false, displayTime: 123.4, players: [...humans(12), ...uarSlots] }
	);
	assert.deepEqual(p, {
		status: 'ingame',
		uar: true,
		players: 12,
		displayTime: 123,
		roster: humans(12).map((h) => h.name).sort()
	});
});

test('non-UAR game lacks the fingerprint', () => {
	const p = derivePresence(
		{ activeScreens: [] },
		{ isReplay: false, displayTime: 5, players: [...humans(2)] }
	);
	assert.equal(p.status, 'ingame');
	assert.equal(p.uar, false);
});

test('lobby and menus from screen names', () => {
	assert.equal(
		derivePresence({ activeScreens: ['ScreenBattleLobby/ScreenBattleLobby'] }, null).status,
		'lobby'
	);
	const menus = derivePresence({ activeScreens: ['ScreenHome/ScreenHome'] }, null);
	assert.deepEqual(menus, { status: 'menus', uar: false });
});

test('real private-lobby payload (captured 2026-07-26) derives lobby', () => {
	// verbatim from a live SC2 client while the user sat in a private lobby
	const ui = {
		activeScreens: [
			'ScreenBackgroundSC2/ScreenBackgroundSC2',
			'ScreenNavigationSC2/ScreenNavigationSC2',
			'ScreenForegroundSC2/ScreenForegroundSC2',
			'ScreenBattleLobby/ScreenBattleLobby',
			'ScreenCustom/ScreenCustom'
		]
	};
	const game = { isReplay: false, displayTime: 0.0, players: [] };
	// note: /game is EMPTY in a lobby — the UAR fingerprint only exists in-game
	assert.deepEqual(derivePresence(ui, game), { status: 'lobby', uar: false });
});

test('missing activeScreens means ingame, ui-only derive works', () => {
	assert.equal(derivePresence({}, null).status, 'ingame');
	assert.deepEqual(derivePresence({ activeScreens: [] }, null), { status: 'ingame', uar: false });
});

test('real solo-public in-game payload (captured 2026-07-26) derives UAR', () => {
	// verbatim from a live solo public game: one human + the three NPC slots
	const game = {
		isReplay: false,
		displayTime: 57.0,
		players: [
			{ id: 1, name: 'KanaxStratz', type: 'user', race: 'Terr', result: 'Undecided' },
			{ id: 13, name: 'UT Army', type: 'computer', race: 'Terr', result: 'Undecided' },
			{ id: 14, name: 'Undead', type: 'computer', race: 'Zerg', result: 'Undecided' },
			{ id: 15, name: 'PMC', type: 'computer', race: 'Terr', result: 'Undecided' }
		]
	};
	assert.deepEqual(derivePresence({ activeScreens: [] }, game), {
		status: 'ingame',
		uar: true,
		players: 1,
		displayTime: 57,
		roster: ['KanaxStratz']
	});
});

test('real battlelobby capture yields uar + lobbyId + battletags', () => {
	// captured live 2026-07-26; lobbyId verified against the replay's
	// initData m_randomValue for the same game
	const info = parseBattleLobby(
		readFileSync(new URL('../testdata/battlelobby-solo.bin', import.meta.url))
	);
	// KanaxStratz#451 = SC2 profile name+code, Kanax#2515 = the Battle.net
	// battletag (what site accounts key on); map-author tags (Znimu#743,
	// Finite#521) live before the id block and must be excluded
	assert.deepEqual(info, {
		uar: true,
		lobbyId: 355265080,
		battletags: ['Kanax#2515'],
		members: [{ profile: 'KanaxStratz#451', battletag: 'Kanax#2515' }]
	});
});

test('12-player battlelobby capture: id + full roster (captured 2026-07-26)', () => {
	// real public game; lobbyId verified against the replay's initData
	const info = parseBattleLobby(
		readFileSync(new URL('../testdata/battlelobby-multi.bin', import.meta.url))
	);
	assert.equal(info.uar, true);
	assert.equal(info.lobbyId, 1593144024);
	assert.equal(info.battletags.length, 12, 'one account battletag per human player');
	assert.ok(info.battletags.includes('Kanax#2515'));
	// profile name and account battletag can differ completely
	assert.ok(
		info.members?.some((m) => m.profile === 'DynamiteHero#725' && m.battletag === 'BttlTgsSuxxx#2914')
	);
	// the map author's tags sit before the id block and must not leak in
	assert.ok(!info.battletags.some((b) => b.startsWith('Znimu#')));
});

test('battlelobby blob matches on any known UAR cache hash', () => {
	const uar = Buffer.from(
		`junk C:\\...\\Cache\\0d\\3d\\${UAR_CACHE_HASHES[1]}.s2ma more junk`,
		'utf8'
	);
	assert.equal(isUarBattleLobby(uar), true);
	assert.equal(isUarBattleLobby(Buffer.from('some other map cache list', 'utf8')), false);
});

test('replays never count as UAR presence', () => {
	const p = derivePresence(
		{ activeScreens: [] },
		{ isReplay: true, displayTime: 5, players: [...humans(1), ...uarSlots] }
	);
	assert.equal(p.uar, false);
});
