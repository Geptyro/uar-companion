/**
 * Release in one step: roll changelog/unreleased/ entries into a version
 * folder, bump the version, commit, tag, and push main + tag. The release
 * workflow builds Linux, Windows and macOS from the tag and attaches them to
 * the GitHub release, which is also where electron-updater looks — so the tag
 * is the release, and a running install picks it up within ten minutes.
 *
 * Unlike the website's, this one owns the version number too: it is in
 * package.json, shown in the window, and what the updater compares against.
 *
 * Usage:  npm run release v0.7.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseEntry } from '../src/renderer/src/lib/changelog.ts';

function git(...args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const version = process.argv[2] ?? '';
if (!/^v\d+\.\d+\.\d+$/.test(version)) {
	console.error('Usage: npm run release vX.Y.Z');
	process.exit(1);
}
const bare = version.slice(1);

if (git('status', '--porcelain', '--', 'src', 'tests', 'resources')) {
	console.error('Uncommitted work outside changelog/ — commit it first, so the tag builds it.');
	process.exit(1);
}
git('fetch', '--tags', '--quiet', 'origin');
if (git('tag', '-l', version)) {
	console.error(`Tag ${version} already exists — pick the next version (check \`git tag\`).`);
	process.exit(1);
}
const dir = join('changelog', version);
if (existsSync(dir)) {
	console.error(`${dir} already exists.`);
	process.exit(1);
}

// Move only tracked entries: an uncommitted entry belongs to another
// session's unfinished work and must stay in unreleased/.
const tracked = git('ls-files', '--', 'changelog/unreleased')
	.split('\n')
	.filter((f) => f.endsWith('.md') && basename(f) !== 'README.md');
if (!tracked.length) {
	console.error('No tracked entries in changelog/unreleased/ — nothing to release.');
	process.exit(1);
}
const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'changelog/unreleased')
	.split('\n')
	.filter(Boolean);
if (untracked.length) {
	console.warn(
		`Leaving uncommitted entries behind (another session's WIP?):\n  ${untracked.join('\n  ')}`
	);
}

mkdirSync(dir);
// notable = non-minor entries; the headline is the major one's title, which is
// how every release commit here has been worded by hand so far
let notable = 0;
let headline = '';
for (const f of tracked) {
	const entry = parseEntry(readFileSync(f, 'utf8'));
	if (entry.impact !== 'minor') notable++;
	if (entry.impact === 'major' && !headline) headline = entry.title;
	git('mv', f, join(dir, basename(f)));
}
const date = new Date().toISOString().slice(0, 10);
writeFileSync(join(dir, 'release.json'), JSON.stringify({ date, notable }) + '\n');
git('add', '--', join(dir, 'release.json'));

// the version the app reports, the updater compares, and the installer carries
for (const file of ['package.json', 'package-lock.json']) {
	const raw = readFileSync(file, 'utf8');
	// only the top-level "version", which is the first one in both files
	const next = raw.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${bare}"`);
	if (next === raw) {
		console.error(`${file}: no version field to bump — aborting before the tag.`);
		process.exit(1);
	}
	writeFileSync(file, next);
}

const subject = headline ? `${version}: ${headline[0].toLowerCase()}${headline.slice(1)}` : version;
execFileSync(
	'git',
	['commit', '-m', subject, '--', 'changelog', 'package.json', 'package-lock.json'],
	{ stdio: 'inherit' }
);

git('tag', version);
execFileSync('git', ['push', 'origin', 'main', version], { stdio: 'inherit' });

console.log(`\n${subject}`);
console.log(`${tracked.length} entr${tracked.length === 1 ? 'y' : 'ies'} rolled up, tagged, pushed.`);
console.log('The Release workflow builds all three platforms from the tag — watch Actions.');
