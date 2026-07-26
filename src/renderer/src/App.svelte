<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Card,
		Button,
		Tag,
		Toggle,
		SectionHeading,
		ReadyChip,
		ReadyPlayers,
		BnetButton,
		AccountChip,
		PresenceChips,
		HoverPop
	} from 'uar-shared';
	import { minutesLeft, readyLevel, activeReady } from 'uar-shared/ready';
	import { splitPresence } from 'uar-shared/presence';
	import type { Snapshot } from './global.d.ts';

	let snap = $state<Snapshot | null>(null);
	let busy = $state(false);
	let now = $state(Date.now());

	onMount(() => {
		void window.uarCompanion.snapshot().then((s) => (snap = s));
		const tick = setInterval(() => (now = Date.now()), 15_000);
		const off = window.uarCompanion.onUpdate((s) => {
			snap = s;
			now = Date.now();
		});
		return () => {
			clearInterval(tick);
			off();
		};
	});

	const myMinutes = $derived(
		snap?.meReady && snap.meUntil && Date.parse(snap.meUntil) > now
			? minutesLeft(snap.meUntil, now)
			: null
	);
	const readyActive = $derived(snap ? activeReady(snap.ready.players, now) : []);
	/** in a lobby or game: flagging is blocked (and the flag auto-withdraws) */
	const inMatch = $derived(snap?.sc2 != null && snap.sc2.status !== 'menus');
	const split = $derived(splitPresence(snap?.presenceList ?? []));

	const sc2Label = $derived.by(() => {
		const p = snap?.sc2;
		if (!p) return null;
		if (p.status === 'menus') return 'SC2 running — in the menus';
		const what = p.status === 'lobby' ? 'lobby' : 'game';
		const uar = p.uar ? 'UAR ' : '';
		const extra = [
			p.players !== undefined ? `${p.players} players` : null,
			p.status === 'ingame' && p.displayTime ? `${Math.floor(p.displayTime / 60)} min` : null
		]
			.filter(Boolean)
			.join(', ');
		return `In a ${uar}${what}${extra ? ` (${extra})` : ''}`;
	});

	async function toggle(key: 'noBackfill' | 'notifyUploads' | 'notifyReady' | 'autostart') {
		if (!snap) return;
		snap = await window.uarCompanion.setConfig({ [key]: !snap.config[key] });
	}

	async function act(run: () => Promise<Snapshot>) {
		busy = true;
		try {
			snap = await run();
		} finally {
			busy = false;
		}
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
	const KIND_TONE: Record<string, 'accent' | 'hostile' | 'mos' | 'item' | undefined> = {
		uploaded: 'accent',
		queued: 'mos',
		rejected: 'hostile',
		error: 'hostile',
		waiting: 'item'
	};
</script>

{#if snap}
	<div class="shell">
		<header class="topbar">
			<span class="brand-mark">UAR</span>
			<div class="brand-text">
				<b>UAR Companion</b>
				<span class="ver">v{snap.version}</span>
			</div>
			<span class="top-status" class:paused={snap.paused}>
				{snap.status}{sc2Label ? ` · ${sc2Label}` : ''}
			</span>
			<div class="top-actions">
				<PresenceChips
					lobbies={split.lobbies}
					games={split.games}
					onchipclick={() => window.uarCompanion.openWebsite()}
				/>
				{#if snap.ready.ok}
					<HoverPop disabled={readyActive.length === 0} heading={`Ready to play · ${readyActive.length}`}>
						{#snippet trigger()}
							<ReadyChip
								signedIn={snap.me != null}
								minutes={myMinutes}
								level={myMinutes === null ? 'high' : readyLevel(myMinutes)}
								count={readyActive.length}
								{busy}
								locked={inMatch}
								lockedStatus={snap.sc2?.status === 'ingame' ? 'ingame' : 'lobby'}
								ontoggle={(on: boolean) => act(() => window.uarCompanion.setReady(on))}
								onguest={() => act(window.uarCompanion.login)}
							/>
						{/snippet}
						{#if readyActive.length > 0}
							<ReadyPlayers
								players={readyActive}
								{now}
								statusOf={(bt: string) =>
									snap?.presenceList?.find((p) => p.battletag === bt)?.status}
							/>
						{/if}
					</HoverPop>
				{/if}
				{#if snap.me}
					<AccountChip
						battletag={snap.me.battletag}
						avatar={snap.me.avatar}
						title="Open the website"
						onclick={() => window.uarCompanion.openWebsite()}
						oncog={() => act(window.uarCompanion.logout)}
						cogTitle="Sign out"
					/>
				{:else}
					<BnetButton onclick={() => act(window.uarCompanion.login)} disabled={busy} />
				{/if}
			</div>
		</header>

		<main class="grid">
			<div class="col">
				<section class="block fill">
					<SectionHeading>Activity</SectionHeading>
					<Card>
						{#if snap.history.length > 0}
							<ul class="feed">
								{#each snap.history as h ((h.at ?? '') + h.file + h.kind)}
									<li>
										<span class="when mono">{time(h.at)}</span>
										<Tag kind={KIND_TONE[h.kind]}>{KIND_LABEL[h.kind] ?? h.kind}</Tag>
										<span class="file">{h.file}</span>
										{#if h.detail}<span class="detail" title={h.detail}>{h.detail}</span>{/if}
									</li>
								{/each}
							</ul>
						{:else}
							<p class="note m0 small">
								Nothing yet — finish a game of Undead Assault Reborn and the replay shows up
								here.
							</p>
						{/if}
					</Card>
				</section>
			</div>

			<div class="col">
				<section class="block">
					<SectionHeading>Replays</SectionHeading>
					<Card>
						<div class="row-head">
							<span class="mono">
								{snap.autoDetected ? 'auto-detected folders' : 'watched folders'}
							</span>
							<span class="grow"></span>
							<Button variant="ghost" onclick={() => act(() => window.uarCompanion.pause(!snap!.paused))}>
								{snap.paused ? 'Resume' : 'Pause'}
							</Button>
						</div>
						{#if snap.dirs.length === 0}
							<p class="note m0 warn">
								No StarCraft II replay folder found — add your
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
												onclick={() => act(() => window.uarCompanion.removeFolder(dir))}
											>
												✕
											</button>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
						<div class="card-foot">
							<Button variant="ghost" onclick={() => act(window.uarCompanion.redetect)}>Re-detect</Button>
							<Button variant="ghost" onclick={() => act(window.uarCompanion.addFolder)}>
								Add folder…
							</Button>
						</div>
					</Card>
				</section>

				<section class="block fill">
					<SectionHeading>Settings</SectionHeading>
					<Card>
						<Toggle
							checked={snap.config.notifyReady}
							onchange={() => toggle('notifyReady')}
							label="Notify when a player flags (or unflags) ready"
						/>
						<Toggle
							checked={snap.config.notifyUploads}
							onchange={() => toggle('notifyUploads')}
							label="Notify when a replay is uploaded"
						/>
						<Toggle
							checked={snap.config.autostart}
							onchange={() => toggle('autostart')}
							label="Start with the computer (in the tray)"
						/>
						<Toggle
							checked={!snap.config.noBackfill}
							onchange={() => toggle('noBackfill')}
							label="Also upload replays from before install"
						/>
						<p class="note m0 small privacy">
							Only Undead Assault Reborn replays are ever uploaded — every file is checked on
							your machine first, and uploads respect the server's limits.
						</p>
						{#if snap.updateVersion}
							<p class="note m0 small update">
								Update v{snap.updateVersion} downloaded — installs on the next restart (or from
								the tray menu).
							</p>
						{/if}
						<div class="card-foot">
							{#if snap.me}
								<Button variant="ghost" onclick={() => act(window.uarCompanion.logout)}>Sign out</Button>
							{/if}
							<Button variant="ghost" onclick={() => window.uarCompanion.openGithub()}>GitHub</Button>
							<Button variant="ghost" onclick={() => window.uarCompanion.openLog()}>Open log</Button>
						</div>
					</Card>
				</section>
			</div>
		</main>
	</div>
{/if}

<style>
	.shell {
		height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* topbar — same band as the website's */
	.topbar {
		flex: 0 0 var(--topbar-h);
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 16px 0 14px;
		background: var(--sidebar);
		color: var(--sidebar-ink);
		border-bottom: 1px solid var(--sidebar-line);
	}
	.brand-mark {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--r-sm);
		background: var(--accent);
		color: var(--on-accent);
		font: 700 11px/1 var(--mono);
		letter-spacing: 0.03em;
		flex-shrink: 0;
	}
	.brand-text {
		display: flex;
		align-items: baseline;
		gap: 8px;
		white-space: nowrap;
	}
	.brand-text b {
		font-size: 14.5px;
	}
	.ver {
		font: 500 10.5px/1 var(--mono);
		color: var(--sidebar-ink-2);
	}
	.top-status {
		flex: 1;
		font-size: 12px;
		color: var(--sidebar-ink-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.top-status.paused {
		color: var(--item);
	}
	.top-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	/* fixed-size dashboard: two columns, only the activity list scrolls */
	main.grid {
		flex: 1;
		min-height: 0;
		display: grid;
		/* minmax(0, …): tracks keep their share even when content is wide */
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		column-gap: 18px;
		padding: 0 18px 16px;
		overflow: hidden;
	}
	.col {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.block {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.block :global(.card) {
		min-width: 0;
	}
	.block.fill {
		flex: 1;
	}
	.block :global(h2.section) {
		margin: 16px 0 10px;
	}
	.block.fill :global(.card) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.card-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid var(--border);
	}
	.block.fill .card-foot {
		margin-top: auto;
	}
	.privacy {
		margin-top: 10px;
	}

	.m0 {
		margin: 0;
	}
	.small {
		font-size: 12px;
	}
	.grow {
		flex: 1;
	}

	/* replays card */
	.row-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.dirs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.dirs li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
		border-top: 1px solid var(--border);
	}
	.path {
		flex: 1;
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--ink-2);
		word-break: break-all;
		user-select: text;
	}
	button.x {
		background: none;
		border: 0;
		color: var(--ink-3);
		cursor: pointer;
		font-size: 13px;
	}
	button.x:hover {
		color: var(--hostile);
	}
	.warn {
		color: var(--item);
	}

	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
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
	}
	.file {
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.detail {
		color: var(--ink-3);
		font-size: 11.5px;
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.update {
		margin-top: 8px;
		color: var(--accent);
	}
</style>
