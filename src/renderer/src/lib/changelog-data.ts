/**
 * Build-time changelog data. The entries live at the repo root, next to the
 * code they describe and in the same layout the website uses; Vite inlines
 * them into the renderer chunk, so the view needs no network and no files
 * alongside the packaged app.
 *
 * The globs are relative because the renderer's Vite root is src/renderer,
 * while the changelog is four levels up at the project root.
 */
import { buildChangelog } from './changelog.ts';

const entryFiles = import.meta.glob('../../../../changelog/v*/*.md', {
	eager: true,
	query: '?raw',
	import: 'default'
}) as Record<string, string>;

const releaseFiles = import.meta.glob('../../../../changelog/v*/release.json', {
	eager: true,
	import: 'default'
}) as Record<string, { date?: string }>;

export const releases = buildChangelog(entryFiles, releaseFiles);
