/**
 * Lints the entries that are actually committed, rather than the parser that
 * reads them (that is changelog.test.ts).
 *
 * The parser cannot fail a build over a bad entry — a changelog is never worth
 * blocking a release for — so a misfiled `area:` reaches the Changelog pane
 * silently, under a heading for a part of the app the change never touched.
 * This is the reader that does raise its voice, and it runs in CI as part of
 * `npm test`.
 *
 * `npm run changelog:check` runs just this file, which is the one to reach for
 * while writing an entry.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { lintEntry } from '../src/renderer/src/lib/changelog.ts';

const root = fileURLToPath(new URL('../changelog', import.meta.url));

/**
 * Every entry file, as `<folder>/<name>.md` paths relative to changelog/.
 *
 * README.md is the format doc, not an entry, and release.json is not markdown.
 * unreleased/ is included on purpose: an entry is worth checking while it is
 * still being written, not first at the release that rolls it up.
 */
function entryFiles(): string[] {
	return readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((dir) =>
			readdirSync(join(root, dir.name))
				.filter((f) => f.endsWith('.md') && f !== 'README.md')
				.map((f) => `${dir.name}/${f}`)
		)
		.sort();
}

const files = entryFiles();

test('there are entries to check at all', () => {
	// guards against a silent pass after a rename of changelog/ or of the layout
	assert.ok(files.length > 0, `no entry files under ${root}`);
});

for (const file of files) {
	test(`changelog/${file} is on-schema`, () => {
		const problems = lintEntry(readFileSync(join(root, file), 'utf8'));
		assert.deepEqual(
			problems.map((p) => `${p.field}: ${p.message}`),
			[]
		);
	});
}
