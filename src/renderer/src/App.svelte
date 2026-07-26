<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snapshot } from './global.d.ts';
	import icon from './assets/icon.png';

	let snap = $state<Snapshot | null>(null);

	onMount(() => {
		void window.uarTray.snapshot().then((s) => (snap = s));
		return window.uarTray.onUpdate((s) => (snap = s));
	});

	async function toggle(key: 'noBackfill' | 'notifyUploads' | 'notifyReady' | 'autostart') {
		if (!snap) return;
		snap = await window.uarTray.setConfig({ [key]: !snap.config[key] });
	}

	function time(iso: string): string {
		const d = new Date(iso);
		const today = new Date().toDateString() === d.toDateString();
		return today
			? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	const KIND_LABEL: Record<string, string> = {
		uploaded: 'uploaded',
		queued: 'queued',
		duplicate: 'known',
		rejected: 'rejected',
		skipped: 'skipped',
		waiting: 'waiting',
		error: 'retrying'
	};
</script>

{#if snap}
	<main>
		<header>
			<img src={icon} alt="" width="34" height="34" />
			<div class="head">
				<h1>UAR Tray <span class="ver">v{snap.version}</span></h1>
				<p class="status" class:paused={snap.paused}>{snap.status}</p>
			</div>
			<button
				class="ghost"
				onclick={() => window.uarTray.pause(!snap!.paused).then((s) => (snap = s))}
			>
				{snap.paused ? 'Resume' : 'Pause'}
			</button>
		</header>

		<section class="card ready">
			<div class="count" class:off={!snap.ready.ok}>
				{snap.ready.ok ? snap.ready.count : '–'}
			</div>
			<div class="grow">
				<h2>Ready to play</h2>
				{#if !snap.ready.ok}
					<p class="dim">Unavailable right now.</p>
				{:else if snap.ready.count === 0}
					<p class="dim">Nobody is flagged ready — flag yourself on the website.</p>
				{:else}
					<div class="chips">
						{#each snap.ready.names as name (name)}<span class="chip">{name}</span>{/each}
					</div>
				{/if}
			</div>
			<button class="ghost" onclick={() => window.uarTray.openWebsite()}>Open website</button>
		</section>

		<section class="card">
			<div class="cardhead">
				<h2>Watched folders {#if snap.autoDetected}<span class="tag">auto-detected</span>{/if}</h2>
				<div>
					<button class="ghost" onclick={() => window.uarTray.redetect().then((s) => (snap = s))}>
						Re-detect
					</button>
					<button class="ghost" onclick={() => window.uarTray.addFolder().then((s) => (snap = s))}>
						Add folder…
					</button>
				</div>
			</div>
			{#if snap.dirs.length === 0}
				<p class="warn">
					No StarCraft II replay folder found. Click “Add folder…” and pick your
					<code>Replays\Multiplayer</code> folder.
				</p>
			{:else}
				<ul class="dirs">
					{#each snap.dirs as dir (dir)}
						<li>
							<span class="path">{dir}</span>
							{#if !snap.autoDetected}
								<button
									class="x"
									title="Stop watching"
									onclick={() => window.uarTray.removeFolder(dir).then((s) => (snap = s))}
								>
									✕
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="card">
			<div class="cardhead">
				<h2>Activity</h2>
				<button class="ghost" onclick={() => window.uarTray.openLog()}>Open log</button>
			</div>
			{#if snap.history.length === 0}
				<p class="dim">
					Nothing yet — finish a game of Undead Assault Reborn and the replay shows up here.
				</p>
			{:else}
				<ul class="feed">
					{#each snap.history as h ((h.at ?? '') + h.file + h.kind)}
						<li>
							<span class="when">{time(h.at)}</span>
							<span class="badge {h.kind}">{KIND_LABEL[h.kind] ?? h.kind}</span>
							<span class="file">{h.file}</span>
							{#if h.detail}<span class="detail">{h.detail}</span>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="card">
			<h2>Settings</h2>
			<label>
				<input
					type="checkbox"
					checked={snap.config.notifyReady}
					onchange={() => toggle('notifyReady')}
				/>
				Show a popup when a player flags (or unflags) ready to play
			</label>
			<label>
				<input
					type="checkbox"
					checked={snap.config.notifyUploads}
					onchange={() => toggle('notifyUploads')}
				/>
				Notify me when a replay is uploaded
			</label>
			<label>
				<input
					type="checkbox"
					checked={snap.config.autostart}
					onchange={() => toggle('autostart')}
				/>
				Start with the computer (minimized to the tray)
			</label>
			<label>
				<input
					type="checkbox"
					checked={!snap.config.noBackfill}
					onchange={() => toggle('noBackfill')}
				/>
				Also upload replays from before UAR Tray was installed
			</label>
			<p class="dim small">
				Only Undead Assault Reborn replays are ever uploaded — every replay is checked on your
				machine first. Uploads are spaced out to respect the server's limits.
			</p>
		</section>
	</main>
{/if}

<style>
	:global(*) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		background: #14171c;
		color: #e7e4dc;
		font:
			14px/1.5 system-ui,
			sans-serif;
		-webkit-user-select: none;
		user-select: none;
	}
	main {
		max-width: 760px;
		margin: 0 auto;
		padding: 18px 20px 40px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	header {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.head {
		flex: 1;
	}
	h1 {
		font-size: 18px;
		margin: 0;
	}
	.ver {
		color: #8a8577;
		font-size: 12px;
		font-weight: normal;
	}
	.status {
		margin: 2px 0 0;
		color: #9fb3a0;
		font-size: 13px;
	}
	.status.paused {
		color: #d9a94b;
	}
	h2 {
		font-size: 14px;
		margin: 0 0 8px;
	}
	.card {
		background: #1c2129;
		border: 1px solid #2a313c;
		border-radius: 10px;
		padding: 14px 16px;
	}
	.cardhead {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px;
	}
	.ready {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.ready .grow {
		flex: 1;
	}
	.count {
		font-size: 34px;
		font-weight: 700;
		color: #e8b34b;
		min-width: 44px;
		text-align: center;
	}
	.count.off {
		color: #555c66;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		background: #2a313c;
		border-radius: 20px;
		padding: 2px 10px;
		font-size: 12.5px;
	}
	.tag {
		font-size: 11px;
		color: #8a8577;
		border: 1px solid #2a313c;
		border-radius: 4px;
		padding: 1px 6px;
		margin-left: 6px;
		font-weight: normal;
	}
	.dirs,
	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.dirs li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
		border-top: 1px solid #232935;
	}
	.dirs li:first-child {
		border-top: 0;
	}
	.path {
		flex: 1;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: #b8b4a8;
		word-break: break-all;
		user-select: text;
	}
	.feed li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 0;
		border-top: 1px solid #232935;
		font-size: 13px;
	}
	.feed li:first-child {
		border-top: 0;
	}
	.when {
		color: #6d7480;
		font-size: 11.5px;
		min-width: 44px;
	}
	.badge {
		font-size: 11px;
		border-radius: 4px;
		padding: 1px 6px;
		background: #2a313c;
		color: #b8b4a8;
	}
	.badge.uploaded {
		background: #1d3527;
		color: #7fd49a;
	}
	.badge.queued {
		background: #1e2f43;
		color: #7ab3e8;
	}
	.badge.rejected,
	.badge.error {
		background: #3d2224;
		color: #e88a8a;
	}
	.badge.waiting {
		background: #3a3022;
		color: #d9a94b;
	}
	.file {
		color: #e7e4dc;
	}
	.detail {
		color: #6d7480;
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.warn {
		color: #d9a94b;
		margin: 4px 0 0;
	}
	label {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		cursor: pointer;
	}
	input[type='checkbox'] {
		accent-color: #e8b34b;
	}
	.dim {
		color: #8a8577;
		margin: 2px 0;
	}
	.small {
		font-size: 12px;
	}
	button.ghost {
		background: transparent;
		border: 1px solid #2a313c;
		color: #b8b4a8;
		border-radius: 6px;
		padding: 4px 12px;
		cursor: pointer;
		font-size: 12.5px;
	}
	button.ghost:hover {
		border-color: #e8b34b;
		color: #e8b34b;
	}
	button.x {
		background: none;
		border: 0;
		color: #6d7480;
		cursor: pointer;
		font-size: 13px;
	}
	button.x:hover {
		color: #e88a8a;
	}
	code {
		font-size: 12px;
		background: #232935;
		padding: 1px 4px;
		border-radius: 4px;
	}
</style>
