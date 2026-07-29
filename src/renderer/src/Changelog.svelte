<script lang="ts">
	/**
	 * What changed, per release, newest first — the same entries and the same
	 * reading order as the site's changelog.
	 *
	 * Minor entries are pulled out of the main list and stacked compactly at the
	 * bottom of their release: a one-line packaging fix should not sit at the
	 * same weight as the feature the release is named after.
	 */
	import { SectionHeading, Tag } from 'sveltekit-commons';
	import { releases } from './lib/changelog-data.ts';
	import type { ChangelogEntry } from './lib/changelog.ts';

	let { version, onopen }: { version: string; onopen: (url: string) => void } = $props();

	const TYPE_TINT: Record<ChangelogEntry['type'], 'accent' | 'ok' | 'warn' | undefined> = {
		feature: 'accent',
		performance: 'ok',
		improvement: undefined,
		fix: 'warn'
	};

	function date(iso: string): string {
		if (!iso) return '';
		const d = new Date(iso + 'T00:00:00');
		return Number.isNaN(d.getTime())
			? iso
			: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	}

	/** links inside an entry belong in the browser, not in this window */
	function intercept(e: MouseEvent) {
		const a = (e.target as HTMLElement).closest('a');
		if (!a) return;
		e.preventDefault();
		onopen(a.getAttribute('href') ?? '');
	}

	const major = (r: (typeof releases)[number]) => r.entries.filter((e) => e.impact !== 'minor');
	const minor = (r: (typeof releases)[number]) => r.entries.filter((e) => e.impact === 'minor');
</script>

<div class="log">
	{#each releases as release (release.version)}
		{@const current = release.version === `v${version}`}
		<section class="release" class:current>
			<header class="rel-head">
				<h2 class="rel-ver">
					{release.version}
					{#if current}<span class="badge">running</span>{/if}
				</h2>
				{#if release.date}<span class="rel-date">{date(release.date)}</span>{/if}
			</header>

			<div class="entries">
				{#each major(release) as entry (entry.title)}
					<article class="entry" class:lead={entry.impact === 'major'}>
						<div class="entry-head">
							<h3 class="entry-title">{entry.title}</h3>
							<Tag kind={TYPE_TINT[entry.type]}>{entry.type}</Tag>
							<span class="area">{entry.area}</span>
						</div>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- built at compile time from our own files -->
						<div class="body" onclick={intercept} role="presentation">{@html entry.html}</div>
					</article>
				{/each}
			</div>

			{#if minor(release).length > 0}
				<ul class="minor">
					{#each minor(release) as entry (entry.title)}
						<li>
							<span class="minor-title">{entry.title}</span>
							<span class="area">{entry.area}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	{#if releases.length === 0}
		<SectionHeading>Nothing recorded yet</SectionHeading>
	{/if}
</div>

<style>
	.log {
		display: flex;
		flex-direction: column;
		gap: 34px;
		max-width: 760px;
	}

	.release {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.rel-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding-bottom: 8px;
		border-bottom: var(--border-width) solid var(--border);
	}

	.rel-ver {
		margin: 0;
		font: 600 15px/1 var(--font-mono);
		color: var(--text);
	}

	/* the release you are actually running, so the list has a "you are here" */
	.current .rel-ver {
		color: var(--accent);
	}

	.badge {
		margin-left: 6px;
		font: 500 9.5px/1 var(--font-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		padding: 3px 6px;
		border: 1px solid var(--accent);
		border-radius: 99px;
		color: var(--accent);
	}

	.rel-date {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.entries {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.entry-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	.entry-title {
		margin: 0;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--text);
	}

	/* the release's headline change carries the extra weight */
	.lead .entry-title {
		font-size: 15px;
	}

	.area {
		font: 500 9.5px/1 var(--font-mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.body {
		margin-top: 5px;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-dim);
	}

	.body :global(p) {
		margin: 0 0 8px;
	}
	.body :global(p:last-child) {
		margin-bottom: 0;
	}
	.body :global(ul) {
		margin: 8px 0 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.body :global(strong) {
		color: var(--text);
		font-weight: 600;
	}
	.body :global(code) {
		font: 11.5px/1 var(--font-mono);
		padding: 1px 4px;
		border-radius: var(--radius-1, 3px);
		background: var(--surface-raised);
	}
	.body :global(a) {
		color: var(--accent);
		cursor: pointer;
	}

	/* the tail of small stuff: present, findable, not competing */
	.minor {
		margin: 0;
		padding: 12px 0 0;
		list-style: none;
		border-top: var(--border-width) solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.minor li {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.minor-title {
		font-size: 12px;
		color: var(--text-faint);
	}
</style>
