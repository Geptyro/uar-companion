import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import fg from 'fast-glob';

/**
 * Candidate glob patterns for Replays/Multiplayer folders per OS. On
 * Windows, pass the real Documents folder (Electron's
 * app.getPath('documents') — OneDrive often redirects it away from
 * %USERPROFILE%\Documents).
 */
export function replayDirGlobs(documents?: string): string[] {
	const home = homedir().replaceAll('\\', '/');
	const tail = '/StarCraft II/Accounts/*/*/Replays/Multiplayer';
	switch (process.platform) {
		case 'win32': {
			const globs: string[] = [];
			if (documents) globs.push(documents.replaceAll('\\', '/') + tail);
			globs.push(home + '/Documents' + tail, home + '/OneDrive/Documents' + tail);
			return globs;
		}
		case 'darwin':
			return [home + '/Library/Application Support/Blizzard' + tail];
		default:
			// the usual SC2-under-Wine layouts: Lutris prefixes under ~/Games,
			// plain Wine, Steam Proton, and Bottles (flatpak)
			return [
				home + '/Games/*/drive_c/users/*/Documents' + tail,
				home + '/Games/*/drive_c/users/*/My Documents' + tail,
				home + '/Games/*/pfx/drive_c/users/*/Documents' + tail,
				home + '/.wine/drive_c/users/*/Documents' + tail,
				home + '/.wine/drive_c/users/*/My Documents' + tail,
				home + '/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/*/Documents' + tail,
				home +
					'/.var/app/com.usebottles.bottles/data/bottles/bottles/*/drive_c/users/*/Documents' +
					tail
			];
	}
}

/**
 * Candidate globs for SC2's lobby temp file (replay.server.battlelobby) —
 * written while sitting in a lobby; lists the map's cache hashes.
 */
export function battleLobbyGlobs(): string[] {
	const home = homedir().replaceAll('\\', '/');
	const tail = '/Temp/StarCraft II/TempWriteReplayP*/replay.server.battlelobby';
	switch (process.platform) {
		case 'win32': {
			const local = (process.env.LOCALAPPDATA ?? home + '/AppData/Local').replaceAll('\\', '/');
			return [local + tail];
		}
		case 'darwin':
			return [home + '/Library/Caches/Blizzard/StarCraft II' + tail];
		default:
			return [
				home + '/Games/*/drive_c/users/*/AppData/Local' + tail,
				home + '/Games/*/pfx/drive_c/users/*/AppData/Local' + tail,
				home + '/.wine/drive_c/users/*/AppData/Local' + tail,
				home + '/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/*/AppData/Local' + tail
			];
	}
}

/** The newest battlelobby file, or null when none exists. */
export function findBattleLobby(): string | null {
	let best: string | null = null;
	let bestM = 0;
	for (const pattern of battleLobbyGlobs()) {
		for (const m of fg.sync(pattern, { absolute: true, suppressErrors: true })) {
			try {
				const mt = statSync(m).mtimeMs;
				if (mt > bestM) {
					bestM = mt;
					best = m;
				}
			} catch {
				// vanished
			}
		}
	}
	return best;
}

/** Expands the candidate globs into the folders that actually exist —
 * deduplicated by realpath (Wine's "My Documents" symlinks "Documents", so
 * two globs can hit the same directory). */
export function discoverReplayDirs(documents?: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const pattern of replayDirGlobs(documents)) {
		for (const m of fg.sync(pattern, { onlyDirectories: true, absolute: true, suppressErrors: true })) {
			try {
				if (!statSync(m).isDirectory()) continue;
				const real = realpathSync(m);
				if (!seen.has(real)) {
					seen.add(real);
					out.push(real);
				}
			} catch {
				// vanished between glob and stat
			}
		}
	}
	return out.sort();
}
