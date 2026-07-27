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
	let winWidth = $state(window.innerWidth);

	/**
	 * Narrow window: the chips drop their wording and keep icon + count, so
	 * the top bar's cluster still fits on one line. Keep in step with the
	 * 620px media query below, which sheds the wordmark at the same point.
	 */
	const compact = $derived(winWidth <= 620);

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

<svelte:window bind:innerWidth={winWidth} />

{#if snap}
	<div class="shell">
		<header class="topbar">
			<span class="brand-mark">UAR</span>
			<div class="brand-text">
				<span class="brand-name">
					<b>UAR Companion</b>
					<span class="ver">v{snap.version}</span>
				</span>
				{#if snap.dev}
					<span class="devtag" title="Development build — {snap.server}">
						DEV · {snap.server.replace(/^https?:\/\//, '')}
					</span>
				{/if}
				{#if snap.updateVersion}
					<button
						class="updatepill"
						onclick={() => window.uarCompanion.installUpdate()}
						title="Restart now and install v{snap.updateVersion}"
					>
						Update to v{snap.updateVersion}
					</button>
				{:else if snap.updateDownloading}
					<span class="updatepill downloading" title="Downloading in the background">
						Downloading v{snap.updateDownloading}…
					</span>
				{/if}
			</div>
			<div class="top-actions">
				<PresenceChips
					lobbies={split.lobbies}
					games={split.games}
					known={snap.presenceKnown ?? {}}
					toonHref={(toon: string) => `${snap!.server}/players/${toon}`}
					href={(m: { toon: string | null }) => (m.toon ? `${snap!.server}/players/${m.toon}` : null)}
					onchipclick={() => window.uarCompanion.openWebsite()}
					{compact}
				/>
				{#if snap.ready.ok}
					<HoverPop disabled={readyActive.length === 0} heading={`Ready to play · ${readyActive.length}`}>
						{#snippet trigger()}
							<!-- snippets are closures: Svelte's {#if snap} narrowing
							     doesn't reach inside them, hence the assertions -->
							<ReadyChip
								signedIn={snap!.me != null}
								minutes={myMinutes}
								level={myMinutes === null ? 'high' : readyLevel(myMinutes)}
								count={readyActive.length}
								{busy}
								locked={inMatch}
								lockedStatus={snap!.sc2?.status === 'ingame' ? 'ingame' : 'lobby'}
								ontoggle={(on: boolean) => act(() => window.uarCompanion.setReady(on))}
								onguest={() => act(window.uarCompanion.login)}
								{compact}
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
						{compact}
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
						<div class="settings-body">
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
									Update v{snap.updateVersion} is downloaded. Installing restarts the app — it
									takes a few seconds, and uploads resume on their own.
								</p>
							{/if}
						</div>
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
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}
	/* version sits under the name, not beside it: two short lines against the
	   32px mark instead of one long one */
	.brand-name {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.brand-text b {
		font-size: 14.5px;
		line-height: 1.1;
	}
	.devtag {
		font: 600 9.5px/1 var(--mono);
		letter-spacing: 0.06em;
		padding: 3px 7px;
		border-radius: 99px;
		background: var(--hostile);
		color: #fff;
		white-space: nowrap;
	}
	.ver {
		font: 500 10.5px/1 var(--mono);
		color: var(--sidebar-ink-2);
	}
	/* sits where the version does: noticed on sight, never in the way */
	.updatepill {
		font: 600 9.5px/1 var(--mono);
		letter-spacing: 0.06em;
		padding: 3px 8px;
		border: 1px solid var(--accent);
		border-radius: 99px;
		background: var(--accent);
		color: var(--on-accent);
		white-space: nowrap;
		cursor: pointer;
	}
	.updatepill:hover {
		filter: brightness(1.1);
	}
	.updatepill.downloading {
		border-color: var(--sidebar-border, var(--border));
		background: transparent;
		color: var(--sidebar-ink-2);
		cursor: default;
	}
	.top-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		/* the status text used to be the spacer that held the chips right */
		margin-left: auto;
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
	/* the window can be made short — the controls scroll, the buttons stay put */
	.settings-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
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
		/* a long folder list must not crowd the settings card out of a short
		   window — it scrolls instead of pushing */
		max-height: 132px;
		overflow-y: auto;
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

	/* Shrunk down, the two columns stop being readable long before the window
	   runs out of room: stack everything and let the page scroll instead.
	   The wide layout is one chain of flex and grid boxes sized to the
	   viewport, each with min-height: 0 — leave any of it in place while the
	   cards stop clipping and the content spills over the next section. So
	   this drops the whole model and goes back to plain block flow, where a
	   box is as tall as what's in it and overlap cannot happen. */
	@media (max-width: 720px) {
		main.grid {
			display: block;
			/* y only: the base rule's overflow-x stays hidden, so nothing is
			   ever cut off sideways */
			overflow-y: auto;
		}
		.col,
		.block,
		.block.fill,
		.block.fill :global(.card),
		.feed,
		.settings-body {
			display: block;
			overflow: visible;
		}
		.dirs {
			max-height: none;
		}
		/* margin-top: auto has nothing to push against outside a flex column */
		.block.fill .card-foot {
			margin-top: 12px;
		}
	}

	/* Last thing the top bar can spare before the chips would be clipped: the
	   wordmark. The 32px mark still says which app this is, and the update
	   pill — the one thing in there worth acting on — stays. */
	@media (max-width: 620px) {
		.brand-text b,
		.ver,
		.devtag {
			display: none;
		}
	}

	/* Narrower than the chip cluster itself: the bar stops being one line and
	   wraps rather than clip. Nothing is hidden — it just grows a row when it
	   has to. */
	@media (max-width: 460px) {
		.topbar {
			flex: 0 0 auto;
			flex-wrap: wrap;
			row-gap: 6px;
			padding: 7px 12px;
		}
		.top-actions {
			flex-wrap: wrap;
		}
	}
</style>
