import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battleLobbyGlobs } from '../src/core/paths.ts';

/**
 * node --test isolates each file, so faking the platform here is contained.
 *
 * TMPDIR has to be pinned along with TEMP/TMP: `os.tmpdir()` picks its branch
 * from the *real* platform at startup, so overriding process.platform does not
 * redirect it, and on POSIX it reads TMPDIR first. A Linux runner leaves TMPDIR
 * unset and falls through to the TMP we faked, which is how these tests passed
 * there and failed on macOS — where TMPDIR is always set — until it was pinned.
 */
function asWindows<T>(env: Record<string, string | undefined>, run: () => T): T {
	const platform = process.platform;
	const saved = { ...process.env };
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	Object.assign(process.env, env, { TMPDIR: env.TEMP });
	try {
		return run();
	} finally {
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
		process.env = saved;
	}
}

test('battleLobbyGlobs: a stock Windows install resolves to one path', () => {
	const globs = asWindows(
		{
			LOCALAPPDATA: 'C:\\Users\\Bob\\AppData\\Local',
			TEMP: 'C:\\Users\\Bob\\AppData\\Local\\Temp',
			TMP: 'C:\\Users\\Bob\\AppData\\Local\\Temp'
		},
		battleLobbyGlobs
	);
	assert.deepEqual(globs, [
		'C:/Users/Bob/AppData/Local/Temp/StarCraft II/TempWriteReplayP*/replay.server.battlelobby'
	]);
});

test('battleLobbyGlobs: a redirected TEMP is searched too', () => {
	// group policy, a second drive or a RAM disk moves TEMP off the profile;
	// missing it costs the player their lobbyId for the whole game
	const globs = asWindows(
		{
			LOCALAPPDATA: 'C:\\Users\\Bob\\AppData\\Local',
			TEMP: 'D:\\fasttemp\\',
			TMP: 'D:\\fasttemp\\'
		},
		battleLobbyGlobs
	);
	assert.deepEqual(globs, [
		'C:/Users/Bob/AppData/Local/Temp/StarCraft II/TempWriteReplayP*/replay.server.battlelobby',
		'D:/fasttemp/StarCraft II/TempWriteReplayP*/replay.server.battlelobby'
	]);
});

test('battleLobbyGlobs: every candidate is a forward-slash absolute glob', () => {
	for (const g of battleLobbyGlobs()) {
		assert.ok(!g.includes('\\'), `${g} still has backslashes`);
		assert.ok(g.endsWith('/replay.server.battlelobby'), `${g} does not name the file`);
	}
});
