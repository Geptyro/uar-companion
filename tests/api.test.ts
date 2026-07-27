import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMe, parseReadyRoster, parsePresence, parsePresenceList } from '../src/core/api.ts';

test('parseMe: signed in, signed out, malformed', () => {
	assert.deepEqual(parseMe({ battletag: 'Foo#1', avatar: 'https://x/y.jpg', toon: '2-S2-1-1' }), {
		battletag: 'Foo#1',
		avatar: 'https://x/y.jpg',
		toon: '2-S2-1-1'
	});
	assert.deepEqual(parseMe({ battletag: 'Foo#1' }), { battletag: 'Foo#1', avatar: null, toon: null });
	assert.equal(parseMe({ battletag: null, avatar: null, toon: null }), null);
	assert.equal(parseMe({}), null);
	assert.equal(parseMe(null), null);
});

test('parseReadyRoster: own flag and player defaults', () => {
	const r = parseReadyRoster({
		me: true,
		until: '2026-01-01T01:00:00Z',
		players: [
			{ battletag: 'A#1', avatar: 'https://x/a.jpg', until: '2026-01-01T01:00:00Z' },
			{ battletag: 'B#2', until: '2026-01-01T02:00:00Z' }
		]
	});
	assert.equal(r.meReady, true);
	assert.equal(r.meUntil, '2026-01-01T01:00:00Z');
	assert.deepEqual(r.players[1], { battletag: 'B#2', avatar: null, until: '2026-01-01T02:00:00Z' });

	assert.deepEqual(parseReadyRoster({}), { meReady: false, meUntil: null, players: [] });
	assert.deepEqual(parseReadyRoster({ me: false, until: null, players: [] }).meReady, false);
});

test('parsePresenceList: entries with defaults, empty bodies', () => {
	const list = parsePresenceList({
		players: [
			{ battletag: 'A#1', status: 'ingame', uar: true, players: 12, displayTime: 300 },
			{ battletag: 'B#2', avatar: 'https://x/b.jpg', toon: 't', status: 'lobby', uar: false }
		]
	});
	assert.deepEqual(list[0], {
		battletag: 'A#1',
		avatar: null,
		toon: null,
		status: 'ingame',
		uar: true,
		players: 12,
		displayTime: 300,
		roster: undefined,
		lobbyId: null,
		selfName: undefined
	});
	assert.equal(list[1].status, 'lobby');
	assert.deepEqual(parsePresenceList({}), []);
	assert.deepEqual(parsePresenceList(null), []);
});

test('parsePresence: takes the server groups, or leaves us to group locally', () => {
	const body = {
		players: [
			{ battletag: 'A#1', status: 'ingame', uar: true, players: 3, lobbyId: 7 },
			{ battletag: 'B#2', status: 'ingame', uar: true, players: 3 }
		],
		known: { A: { toon: 't-a' } },
		groups: {
			lobbies: [],
			games: [
				{
					key: 'id:7',
					status: 'ingame',
					uar: true,
					players: 3,
					displayTime: 300,
					members: [
						{ battletag: 'A#1', status: 'ingame', uar: true, lobbyId: 7 },
						{ battletag: 'B#2', status: 'ingame', uar: true }
					]
				}
			]
		}
	};
	const parsed = parsePresence(body);
	assert.equal(parsed.groups?.games.length, 1, 'one game, not one per reporter');
	assert.equal(parsed.groups?.games[0].key, 'id:7');
	assert.equal(parsed.groups?.games[0].members.length, 2);
	assert.equal(parsed.groups?.games[0].members[0].avatar, null, 'members get entry defaults');
	assert.equal(parsed.groups?.lobbies.length, 0);
	assert.deepEqual(parsed.known, { A: { toon: 't-a' } });

	// a server that predates the field: no groups, group them ourselves
	assert.equal(parsePresence({ players: body.players }).groups, undefined);
	assert.equal(parsePresence({ players: [], groups: { games: [] } }).groups, undefined);
	assert.equal(parsePresence(null).groups, undefined);
});
