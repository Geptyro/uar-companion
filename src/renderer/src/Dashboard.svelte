<script lang="ts">
	/**
	 * What the app is doing right now: the replay feed, and the one control
	 * that belongs next to it. Everything you set rather than watch moved to
	 * Settings.
	 */
	import { Button, Card, Tag } from 'sveltekit-commons';
	import type { Snapshot } from './global.d.ts';

	let {
		snap,
		act
	}: {
		snap: Snapshot;
		act: (run: () => Promise<Snapshot>) => Promise<void>;
	} = $props();

	const KIND_LABEL: Record<string, string> = {
		uploaded: 'uploaded',
		queued: 'queued',
		duplicate: 'known',
		rejected: 'rejected',
		skipped: 'skipped',
		waiting: 'waiting',
		error: 'retrying'
	};
	/**
	 * How each feed state reads as a Tag. Three of them are states rather than
	 * things — a rejection is a failure, a wait is a caution — so they take the
	 * contract's own names and follow whatever the palette does with them.
	 * Queued is the exception: "in flight, nothing wrong" has no contract name,
	 * so it borrows the MOS blue by tint, which is what that prop is for.
	 */
	const KIND_TONE: Record<string, { kind?: 'accent' | 'danger' | 'warn'; tint?: string }> = {
		uploaded: { kind: 'accent' },
		queued: { tint: 'var(--mos)' },
		rejected: { kind: 'danger' },
		error: { kind: 'danger' },
		waiting: { kind: 'warn' }
	};

	function time(iso: string): string {
		const d = new Date(iso);
		const today = new Date().toDateString() === d.toDateString();
		return today
			? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

<section class="block">
	<!-- no heading: the shell's crumb already says which page this is, and the
	     site does not repeat it in the content column either -->
	<div class="head">
		<span class="watching mono">
			{#if snap.dirs.length === 0}
				no folder watched
			{:else}
				watching {snap.dirs.length}
				{snap.dirs.length === 1 ? 'folder' : 'folders'}
			{/if}
		</span>
		<Button variant="ghost" onclick={() => act(() => window.uarCompanion.pause(!snap.paused))}>
			{snap.paused ? 'Resume' : 'Pause'}
		</Button>
	</div>

	<Card>
		{#if snap.dirs.length === 0}
			<p class="note m0 warn">
				No StarCraft II replay folder found — add your <code>Replays\Multiplayer</code> folder
				in Settings.
			</p>
		{:else if snap.history.length > 0}
			<ul class="feed">
				{#each snap.history as h ((h.at ?? '') + h.file + h.kind)}
					<li>
						<span class="when mono">{time(h.at)}</span>
						<Tag {...KIND_TONE[h.kind] ?? {}}>{KIND_LABEL[h.kind] ?? h.kind}</Tag>
						<span class="file">{h.file}</span>
						{#if h.detail}<span class="detail" title={h.detail}>{h.detail}</span>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="note m0 small">
				Nothing yet — finish a game of Undead Assault Reborn and the replay shows up here.
			</p>
		{/if}
	</Card>
</section>

<style>
	.block {
		display: flex;
		flex-direction: column;
		min-width: 0;
		max-width: 860px;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		margin-bottom: 10px;
	}
	.watching {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.feed li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 3.5px 0;
		font-size: 12.5px;
	}
	.when {
		min-width: 42px;
		flex: none;
	}
	.file {
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.detail {
		color: var(--text-faint);
		font-size: 11.5px;
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.m0 {
		margin: 0;
	}
	.small {
		font-size: 12px;
	}
	.warn {
		color: var(--item);
	}
</style>
