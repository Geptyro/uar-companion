import { statSync } from 'node:fs';
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
				home + '/.wine/drive_c/users/*/Documents' + tail,
				home + '/.wine/drive_c/users/*/My Documents' + tail,
				home + '/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/*/Documents' + tail,
				home +
					'/.var/app/com.usebottles.bottles/data/bottles/bottles/*/drive_c/users/*/Documents' +
					tail
			];
	}
}

/** Expands the candidate globs into the folders that actually exist. */
export function discoverReplayDirs(documents?: string): string[] {
	const out = new Set<string>();
	for (const pattern of replayDirGlobs(documents)) {
		for (const m of fg.sync(pattern, { onlyDirectories: true, absolute: true, suppressErrors: true })) {
			try {
				if (statSync(m).isDirectory()) out.add(m);
			} catch {
				// vanished between glob and stat
			}
		}
	}
	return [...out].sort();
}
