<script lang="ts">
	/**
	 * Everything you set rather than watch, in the order you are likely to want
	 * it: where the replays come from, what the app is allowed to interrupt you
	 * for, and then the account and the diagnostics.
	 */
	import { Button, Card, SectionHeading, Toggle } from 'sveltekit-commons';
	import type { Snapshot } from './global.d.ts';

	let {
		snap,
		act,
		busy
	}: {
		snap: Snapshot;
		act: (run: () => Promise<Snapshot>) => Promise<void>;
		busy: boolean;
	} = $props();

	function toggle(
		key:
			| 'noBackfill'
			| 'notifyUploads'
			| 'notifyReady'
			| 'notifyLobby'
			| 'notifyInGame'
			| 'autostart'
	) {
		return act(() => window.uarCompanion.setConfig({ [key]: !snap.config[key] }));
	}
</script>

<div class="settings">
	<section class="block">
		<SectionHeading>Replay folders</SectionHeading>
		<Card>
			<p class="note m0 small mono lead">
				{snap.autoDetected ? 'auto-detected' : 'chosen by you'}
			</p>
			{#if snap.dirs.length === 0}
				<p class="note m0 warn">
					No StarCraft II replay folder found — add your <code>Replays\Multiplayer</code> folder.
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

	<section class="block">
		<SectionHeading>Notifications</SectionHeading>
		<Card>
			<div class="rows">
				<Toggle
					checked={snap.config.notifyReady}
					onchange={() => toggle('notifyReady')}
					label="Notify when a player flags (or unflags) ready"
				/>
				<Toggle
					checked={snap.config.notifyLobby}
					onchange={() => toggle('notifyLobby')}
					label="Notify when a lobby forms"
				/>
				<Toggle
					checked={snap.config.notifyUploads}
					onchange={() => toggle('notifyUploads')}
					label="Notify when a replay is uploaded"
				/>
				<Toggle
					checked={snap.config.notifyInGame}
					onchange={() => toggle('notifyInGame')}
					label="Also notify while I'm in a lobby or a game"
				/>
			</div>
			<p class="note m0 small hint">
				That last one is off to begin with: while you are in a lobby or a game the app stays
				quiet, because an interruption costs the most exactly then. These are your desktop's
				own notifications too, so whatever you have set for games — Focus Assist, Do Not
				Disturb — holds them back while you play.
			</p>
		</Card>
	</section>

	<section class="block">
		<SectionHeading>Uploads and startup</SectionHeading>
		<Card>
			<div class="rows">
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
			</div>
			<p class="note m0 small privacy">
				Only Undead Assault Reborn replays are ever uploaded — every file is checked on your
				machine first, and uploads respect the server's limits.
			</p>
		</Card>
	</section>

	<section class="block">
		<SectionHeading>This build</SectionHeading>
		<Card>
			<dl class="facts">
				<dt>Version</dt>
				<dd class="mono">v{snap.version}</dd>
				<dt>Server</dt>
				<dd class="mono">{snap.server.replace(/^https?:\/\//, '')}</dd>
				{#if snap.me}
					<dt>Signed in</dt>
					<dd class="mono">{snap.me.battletag}</dd>
				{/if}
			</dl>
			{#if snap.updateVersion}
				<p class="note m0 small update">
					Update v{snap.updateVersion} is downloaded. Installing restarts the app — it takes a
					few seconds, and uploads resume on their own.
				</p>
				<div class="card-foot">
					<Button onclick={() => window.uarCompanion.installUpdate()}>
						Restart and install v{snap.updateVersion}
					</Button>
				</div>
			{:else if snap.updateDownloading}
				<p class="note m0 small update">Downloading v{snap.updateDownloading}…</p>
			{:else if snap.updateAvailable}
				<p class="note m0 small update">
					Update v{snap.updateAvailable} is available. It is not downloaded yet — fetching a
					hundred megabytes in the background is the kind of thing you feel in a game, so the
					moment is yours to pick.
				</p>
				<div class="card-foot">
					<Button disabled={busy} onclick={() => act(window.uarCompanion.downloadUpdate)}>
						Download v{snap.updateAvailable}
					</Button>
				</div>
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

<style>
	.settings {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 640px;
	}
	.block {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.block :global(h2.section) {
		margin: 16px 0 10px;
	}
	.block:first-child :global(h2.section) {
		margin-top: 0;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.lead {
		margin-bottom: 8px;
		color: var(--text-faint);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-size: 9.5px;
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
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--text-dim);
		word-break: break-all;
		user-select: text;
	}
	button.x {
		background: none;
		border: 0;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 13px;
	}
	button.x:hover {
		color: var(--hostile);
	}

	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 14px;
		margin: 0;
		font-size: 12.5px;
	}
	.facts dt {
		color: var(--text-faint);
	}
	.facts dd {
		margin: 0;
		color: var(--text-dim);
		user-select: text;
	}

	.card-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid var(--border);
	}

	.m0 {
		margin: 0;
	}
	.small {
		font-size: 12px;
	}
	.hint,
	.privacy {
		margin-top: 10px;
		color: var(--text-faint);
	}
	.update {
		margin-top: 8px;
		color: var(--accent);
	}
	.warn {
		color: var(--item);
	}
</style>
