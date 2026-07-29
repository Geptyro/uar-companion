/**
 * Changelog entries: one markdown file per user-visible change under
 * changelog/vX.Y.Z/, the same shape the website uses, so a change written for
 * one reads the same in the other.
 *
 * Dependency-free and free of Vite glob syntax on purpose — plain node:test
 * loads this, while changelog-data.ts does the importing.
 */

export const ENTRY_TYPES = ['feature', 'improvement', 'performance', 'fix'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** What part of the app a change lands in. */
export const ENTRY_AREAS = ['uploads', 'presence', 'window', 'updates', 'packaging'] as const;
export type EntryArea = (typeof ENTRY_AREAS)[number];

// Display order: major leads its release, minor trails (and renders compact).
export const ENTRY_IMPACTS = ['major', 'normal', 'minor'] as const;
export type EntryImpact = (typeof ENTRY_IMPACTS)[number];

export interface ChangelogEntry {
	title: string;
	type: EntryType;
	area: EntryArea;
	impact: EntryImpact;
	html: string;
}

export interface ChangelogRelease {
	version: string;
	date: string;
	entries: ChangelogEntry[];
}

const VERSION_RE = /changelog\/(v\d+\.\d+\.\d+)\//;

export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, '').split('.').map(Number);
	const pb = b.replace(/^v/, '').split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

export interface ParsedEntry {
	title: string;
	type: EntryType;
	area: EntryArea;
	impact: EntryImpact;
	body: string;
}

export function parseEntry(raw: string): ParsedEntry {
	const meta: Record<string, string> = {};
	let body = raw;
	const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (fm) {
		body = raw.slice(fm[0].length);
		for (const line of fm[1].split(/\r?\n/)) {
			const kv = line.match(/^(\w+):\s*(.*)$/);
			// a title with a colon in it is quoted in the file
			if (kv) meta[kv[1]] = kv[2].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
		}
	}
	const type = (ENTRY_TYPES as readonly string[]).includes(meta.type ?? '')
		? (meta.type as EntryType)
		: 'improvement';
	const area = (ENTRY_AREAS as readonly string[]).includes(meta.area ?? '')
		? (meta.area as EntryArea)
		: 'window';
	const impact = (ENTRY_IMPACTS as readonly string[]).includes(meta.impact ?? '')
		? (meta.impact as EntryImpact)
		: 'normal';
	return { title: meta.title ?? '', type, area, impact, body: body.trim() };
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function inline(text: string): string {
	return escapeHtml(text)
		.split(/(`[^`]+`)/)
		.map((part) => {
			if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
				return `<code>${part.slice(1, -1)}</code>`;
			}
			return part
				.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) =>
					// only absolute http(s): a relative link has nowhere to go in a
					// window with no router, and the shell opens externals in a browser
					/^https?:\/\//.test(href) ? `<a href="${href}">${label}</a>` : m
				);
		})
		.join('');
}

/** Entry bodies use a small markdown subset: paragraphs, "- " lists, **bold**, `code`, links. */
export function renderMarkdown(md: string): string {
	return md
		.trim()
		.split(/\n\s*\n/)
		.map((block) =>
			block
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
		)
		.filter((lines) => lines.length)
		.map((lines) => {
			if (lines.every((l) => l.startsWith('- '))) {
				return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
			}
			// a wrapped list item continues its bullet rather than starting a
			// paragraph: the files are hard-wrapped at 78 columns
			if (lines[0].startsWith('- ')) {
				const items: string[] = [];
				for (const l of lines) {
					if (l.startsWith('- ')) items.push(l.slice(2));
					else items[items.length - 1] += ' ' + l;
				}
				return `<ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
			}
			return `<p>${inline(lines.join(' '))}</p>`;
		})
		.join('\n');
}

const typeRank = (t: EntryType) => ENTRY_TYPES.indexOf(t);
const areaRank = (a: EntryArea) => ENTRY_AREAS.indexOf(a);
const impactRank = (i: EntryImpact) => ENTRY_IMPACTS.indexOf(i);

/**
 * Assemble releases (newest first) from raw glob maps:
 * entryFiles = path -> raw markdown, releaseFiles = path -> release.json content.
 */
export function buildChangelog(
	entryFiles: Record<string, string>,
	releaseFiles: Record<string, { date?: string }>
): ChangelogRelease[] {
	const byVersion = new Map<string, ChangelogEntry[]>();
	for (const [path, raw] of Object.entries(entryFiles)) {
		const v = VERSION_RE.exec(path)?.[1];
		if (!v) continue;
		const e = parseEntry(raw);
		const title = e.title || (path.split('/').pop() ?? '').replace(/\.md$/, '');
		let list = byVersion.get(v);
		if (!list) byVersion.set(v, (list = []));
		list.push({ title, type: e.type, area: e.area, impact: e.impact, html: renderMarkdown(e.body) });
	}
	const dates = new Map<string, string>();
	for (const [path, json] of Object.entries(releaseFiles)) {
		const v = VERSION_RE.exec(path)?.[1];
		if (v && json?.date) dates.set(v, json.date);
	}
	return [...byVersion.entries()]
		.sort(([a], [b]) => compareVersions(b, a))
		.map(([version, entries]) => ({
			version,
			date: dates.get(version) ?? '',
			entries: entries.sort(
				(x, y) =>
					impactRank(x.impact) - impactRank(y.impact) ||
					typeRank(x.type) - typeRank(y.type) ||
					areaRank(x.area) - areaRank(y.area) ||
					x.title.localeCompare(y.title)
			)
		}));
}

/**
 * Releases newer than the running build — what an update would bring, and what
 * a fresh install has just gained. `null` version (dev, unknown) shows nothing.
 */
export function releasesAfter(
	releases: ChangelogRelease[],
	version: string | null
): ChangelogRelease[] {
	if (!version) return [];
	return releases.filter((r) => compareVersions(r.version, version) > 0);
}
