import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildChangelog,
	compareVersions,
	parseEntry,
	releasesAfter,
	renderMarkdown,
	ENTRY_AREAS,
	ENTRY_TYPES
} from '../src/renderer/src/lib/changelog.ts';

test('compareVersions orders numerically, not as text', () => {
	assert.ok(compareVersions('v0.10.0', 'v0.9.0') > 0);
	assert.ok(compareVersions('v0.6.0', 'v0.6.1') < 0);
	assert.equal(compareVersions('v1.2.3', 'v1.2.3'), 0);
});

test('parseEntry reads the frontmatter and falls back on junk', () => {
	const e = parseEntry(`---
title: 'A title: with a colon'
type: performance
area: uploads
impact: major
---
Body text.`);
	assert.equal(e.title, 'A title: with a colon');
	assert.equal(e.type, 'performance');
	assert.equal(e.area, 'uploads');
	assert.equal(e.impact, 'major');
	assert.equal(e.body, 'Body text.');

	const junk = parseEntry('no frontmatter here');
	assert.equal(junk.type, 'improvement');
	assert.equal(junk.area, 'window');
	assert.equal(junk.impact, 'normal');
	assert.equal(junk.body, 'no frontmatter here');
});

test('renderMarkdown covers the subset the entries use', () => {
	assert.equal(renderMarkdown('plain **bold** and `code`'), '<p>plain <strong>bold</strong> and <code>code</code></p>');
	assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
	// entries are hard-wrapped at 78 columns, so a long bullet continues below
	assert.equal(renderMarkdown('- one that\n  wrapped\n- two'), '<ul><li>one that wrapped</li><li>two</li></ul>');
	assert.equal(renderMarkdown('a <script>'), '<p>a &lt;script&gt;</p>');
	// a relative link has nowhere to go in a window with no router
	assert.equal(renderMarkdown('[x](/players)'), '<p>[x](/players)</p>');
	assert.match(renderMarkdown('[x](https://uar.example/p)'), /^<p><a href="https:\/\/uar\.example\/p">x<\/a><\/p>$/);
});

test('buildChangelog sorts releases newest first and leads with the major entry', () => {
	const entries = {
		'/changelog/v0.1.0/a.md': '---\ntitle: Old\ntype: feature\narea: uploads\n---\nx',
		'/changelog/v0.2.0/b.md': '---\ntitle: Small\ntype: fix\narea: window\nimpact: minor\n---\nx',
		'/changelog/v0.2.0/c.md': '---\ntitle: Headline\ntype: feature\narea: presence\nimpact: major\n---\nx'
	};
	const releases = buildChangelog(entries, {
		'/changelog/v0.1.0/release.json': { date: '2026-01-01' },
		'/changelog/v0.2.0/release.json': { date: '2026-02-01' }
	});
	assert.deepEqual(
		releases.map((r) => r.version),
		['v0.2.0', 'v0.1.0']
	);
	assert.equal(releases[0].date, '2026-02-01');
	assert.deepEqual(
		releases[0].entries.map((e) => e.title),
		['Headline', 'Small'],
		'major leads, minor trails'
	);
});

test('releasesAfter is what an offered update would bring', () => {
	const releases = buildChangelog(
		{
			'/changelog/v0.6.0/a.md': '---\ntitle: A\n---\nx',
			'/changelog/v0.7.0/b.md': '---\ntitle: B\n---\nx'
		},
		{}
	);
	assert.deepEqual(releasesAfter(releases, '0.6.0').map((r) => r.version), ['v0.7.0']);
	assert.deepEqual(releasesAfter(releases, '0.7.0'), []);
	assert.deepEqual(releasesAfter(releases, null), []);
});

const CHANGELOG = fileURLToPath(new URL('../changelog', import.meta.url));

/** Everything release.ts would have to understand, checked the same way. */
function assertEntry(where: string, raw: string) {
	assert.match(raw, /^---\r?\n/, `${where}: starts with frontmatter`);
	const e = parseEntry(raw);
	assert.ok(e.title, `${where}: has a title`);
	// parseEntry defaults silently, so compare against the file itself
	const declared = raw.match(/^type:\s*(.+)$/m)?.[1].trim();
	assert.ok(
		declared && (ENTRY_TYPES as readonly string[]).includes(declared),
		`${where}: type "${declared}" is one of ${ENTRY_TYPES.join(', ')}`
	);
	const area = raw.match(/^area:\s*(.+)$/m)?.[1].trim();
	assert.ok(
		area && (ENTRY_AREAS as readonly string[]).includes(area),
		`${where}: area "${area}" is one of ${ENTRY_AREAS.join(', ')}`
	);
	assert.ok(e.body.length > 0, `${where}: has a body`);
}

/**
 * The shipped entries are data the view renders verbatim — a typo in a `type:`
 * silently downgrades an entry to "improvement", and a release with no
 * release.json loses its date. Cheaper to catch here than to notice in the app.
 */
test('every released changelog entry is well-formed', () => {
	const dirs = readdirSync(CHANGELOG).filter((d) => statSync(join(CHANGELOG, d)).isDirectory());
	const versions = dirs.filter((d) => d !== 'unreleased');
	assert.ok(versions.length > 0, 'there is a changelog to check');
	for (const v of versions) {
		assert.match(v, /^v\d+\.\d+\.\d+$/, `${v}: version folders are vX.Y.Z or unreleased`);
		const files = readdirSync(join(CHANGELOG, v));
		assert.ok(files.includes('release.json'), `${v}: has a release.json`);
		const meta = JSON.parse(readFileSync(join(CHANGELOG, v, 'release.json'), 'utf8'));
		assert.match(meta.date, /^\d{4}-\d{2}-\d{2}$/, `${v}: release.json has an ISO date`);

		const mds = files.filter((f) => f.endsWith('.md'));
		assert.ok(mds.length > 0, `${v}: has at least one entry`);
		for (const f of mds) assertEntry(`${v}/${f}`, readFileSync(join(CHANGELOG, v, f), 'utf8'));
	}
});

/**
 * The pending entries get no second look — `npm run release` moves them into a
 * version folder and pushes a tag in one go, so a bad `type:` would ship. They
 * are held to the released ones' standard here, before that.
 */
test('pending entries in unreleased/ are release-ready', () => {
	const dir = join(CHANGELOG, 'unreleased');
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.md') || f === 'README.md') continue;
		assertEntry(`unreleased/${f}`, readFileSync(join(dir, f), 'utf8'));
	}
});
