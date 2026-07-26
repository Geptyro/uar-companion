import { MPQArchive } from './mpq.ts';

/** Mirrors MAP_TITLE in the website's upload endpoint. */
export const MAP_TITLE = 'Undead Assault reborn';

export const MAX_UPLOAD_SIZE = 16 * 1024 * 1024;

/**
 * Opens the replay archive and looks for the map title in the small
 * replay.details entry — patch-proof (no versioned protocol decode) and
 * cheap enough to run on every new file. Throws when the file is not a
 * readable SC2 replay.
 */
export function isUARReplay(data: Uint8Array): boolean {
	const archive = new MPQArchive(data);
	const details = archive.readFile('replay.details');
	if (!details) throw new Error('replay.details missing from archive');
	return Buffer.from(details.buffer, details.byteOffset, details.byteLength).includes(
		Buffer.from(MAP_TITLE)
	);
}
