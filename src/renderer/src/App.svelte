<script lang="ts">
	/**
	 * The window: the site's shell — top bar, collapsing rail, content column —
	 * around one of three views.
	 *
	 * The shell is sveltekit-commons' AppShell, the same component the website
	 * runs. It has no router in it, so "navigation" here is a variable: the nav
	 * rows are anchors for the look and the keyboard, and their click sets the
	 * view rather than going anywhere. `closeOn` gets the view, which is what
	 * shuts the drawer on a narrow window after a pick.
	 */
	import { onMount } from 'svelte';
	import { AppShell, HoverPop, NavItem, NavSection } from 'sveltekit-commons';
	import { AccountChip, BnetButton, PresenceChips, ReadyChip, ReadyPlayers } from 'uar-shared';
	import { minutesLeft, readyLevel, activeReady } from 'uar-shared/ready';
	import { splitPresence } from 'uar-shared/presence';
	import Changelog from './Changelog.svelte';
	import Dashboard from './Dashboard.svelte';
	import Settings from './Settings.svelte';
	import { releasesAfter } from './lib/changelog.ts';
	import { releases } from './lib/changelog-data.ts';
	import type { Snapshot } from './global.d.ts';

	type View = 'dashboard' | 'changelog' | 'settings';

	let snap = $state<Snapshot | null>(null);
	let busy = $state(false);
	let now = $state(Date.now());
	let view = $state<View>('dashboard');

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
	// the site groups; only an older server leaves us to do it locally
	const split = $derived(snap?.presenceGroups ?? splitPresence(snap?.presenceList ?? []));

	/**
	 * Releases newer than the running build — the changelog row wears the count,
	 * so an offered update can be read before it is taken.
	 */
	const unread = $derived(snap ? releasesAfter(releases, snap.version).length : 0);

	const TITLES: Record<View, string> = {
		dashboard: 'Activity',
		changelog: 'Changelog',
		settings: 'Settings'
	};

	async function act(run: () => Promise<Snapshot>) {
		busy = true;
		try {
			snap = await run();
		} finally {
			busy = false;
		}
	}

	function go(next: View, close: () => void) {
		return (e: MouseEvent) => {
			e.preventDefault();
			view = next;
			close();
		};
	}
</script>

{#if snap}
	<AppShell navKey="uar-companion:nav-open" navLabel="Main" closeOn={view}>
		{#snippet brand()}
			<span class="brand-mark">UAR</span>
		{/snippet}

		{#snippet crumb()}
			<h1 class="crumb-title">{TITLES[view]}</h1>
			{#if snap!.dev}
				<span class="devtag" title="Development build — {snap!.server}">
					DEV · {snap!.server.replace(/^https?:\/\//, '')}
				</span>
			{/if}
		{/snippet}

		{#snippet tools(compact: boolean)}
			<PresenceChips
				lobbies={split.lobbies}
				games={split.games}
				known={snap!.presenceKnown ?? {}}
				toonHref={(toon: string) => `${snap!.server}/players/${toon}`}
				href={(m: { toon: string | null }) => (m.toon ? `${snap!.server}/players/${m.toon}` : null)}
				onchipclick={() => window.uarCompanion.openWebsite()}
				{compact}
			/>
			{#if snap!.ready.ok}
				<HoverPop
					disabled={readyActive.length === 0}
					heading={`Ready to play · ${readyActive.length}`}
				>
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
			{#if snap!.me}
				<AccountChip
					{compact}
					battletag={snap!.me.battletag}
					avatar={snap!.me.avatar}
					title="Open the website"
					onclick={() => window.uarCompanion.openWebsite()}
					oncog={() => (view = 'settings')}
					cogTitle="Settings"
				/>
			{:else}
				<BnetButton onclick={() => act(window.uarCompanion.login)} disabled={busy} />
			{/if}
		{/snippet}

		{#snippet nav(close: () => void)}
			<NavSection>App</NavSection>
			<NavItem
				href="#dashboard"
				label="Activity"
				active={view === 'dashboard'}
				onclick={go('dashboard', close)}
			>
				{#snippet icon()}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M3 12h4l3 8 4-16 3 8h4" />
					</svg>
				{/snippet}
				{#snippet trailing()}{snap!.paused ? 'paused' : ''}{/snippet}
			</NavItem>
			<NavItem
				href="#changelog"
				label="Changelog"
				active={view === 'changelog'}
				onclick={go('changelog', close)}
			>
				{#snippet icon()}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M4 4h11l5 5v11H4z" />
						<path d="M8 12h8M8 16h5" />
					</svg>
				{/snippet}
				{#snippet trailing()}{unread > 0 ? `+${unread}` : `v${snap!.version}`}{/snippet}
			</NavItem>
			<NavItem
				href="#settings"
				label="Settings"
				active={view === 'settings'}
				onclick={go('settings', close)}
			>
				{#snippet icon()}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="3" />
						<path
							d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
						/>
					</svg>
				{/snippet}
			</NavItem>

			<!-- short enough to survive the rail: NavSection keeps its text when
			     the labels fold away, and 58px holds about four characters -->
			<NavSection>Site</NavSection>
			<NavItem
				href={snap!.server}
				label="Website"
				dense
				onclick={(e: MouseEvent) => {
					e.preventDefault();
					window.uarCompanion.openWebsite();
					close();
				}}
			>
				{#snippet icon()}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="9" />
						<path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
					</svg>
				{/snippet}
			</NavItem>
		{/snippet}

		{#snippet foot()}
			{#if snap!.updateVersion}
				<button class="updatepill" onclick={() => window.uarCompanion.installUpdate()}>
					<span class="dot"></span>
					<span class="pill-label">Restart for v{snap!.updateVersion}</span>
				</button>
			{:else if snap!.updateDownloading}
				<span class="updatepill quiet">
					<span class="dot"></span>
					<span class="pill-label">Downloading v{snap!.updateDownloading}…</span>
				</span>
			{:else if snap!.updateAvailable}
				<button class="updatepill" onclick={() => act(window.uarCompanion.downloadUpdate)}>
					<span class="dot"></span>
					<span class="pill-label">Get v{snap!.updateAvailable}</span>
				</button>
			{/if}
		{/snippet}

		{#if view === 'dashboard'}
			<Dashboard {snap} {act} />
		{:else if view === 'changelog'}
			<Changelog
				version={snap.version}
				onopen={(url: string) => url && window.uarCompanion.openWebsite()}
			/>
		{:else}
			<Settings {snap} {act} {busy} />
		{/if}
	</AppShell>
{/if}

<style>
	/* AppShell subtracts this when it lines the heading up with the content */
	:global(.shell) {
		--brand-w: 32px;
	}

	.brand-mark {
		display: grid;
		place-items: center;
		width: var(--brand-w);
		height: 32px;
		border-radius: var(--radius-2);
		background: var(--accent);
		color: var(--accent-contrast);
		font: 700 11px/1 var(--font-mono);
		letter-spacing: 0.03em;
	}

	/* the window's one heading, sized like the site's crumb */
	.crumb-title {
		margin: 0;
		font-size: 15.5px;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.devtag {
		font: 600 9.5px/1 var(--font-mono);
		letter-spacing: 0.06em;
		padding: 3px 7px;
		border-radius: 99px;
		background: var(--hostile);
		color: #fff;
		white-space: nowrap;
		flex: none;
	}

	/* In the sidebar footer, so it folds to a dot with the rail: collapsed
	   there is no room for words, and a lit dot at the bottom of the rail is
	   still the "something is waiting" the pill is for. */
	.updatepill {
		display: flex;
		align-items: center;
		justify-content: var(--nav-justify, flex-start);
		gap: 8px;
		width: 100%;
		padding: 6px var(--nav-pad-x, 10px);
		border: 1px solid var(--accent);
		border-radius: 99px;
		background: transparent;
		color: var(--accent);
		font: 600 9.5px/1 var(--font-mono);
		letter-spacing: 0.06em;
		text-align: left;
		cursor: pointer;
	}
	.updatepill:hover {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.updatepill.quiet {
		border-color: var(--border);
		color: var(--text-faint);
		cursor: default;
	}
	.dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
	}
	.pill-label {
		display: var(--label-display, block);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
