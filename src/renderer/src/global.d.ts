import type { PresenceGroup } from 'uar-shared/presence';
import type { PresenceEntry } from '../../core/api.ts';

export interface Snapshot {
	version: string;
	server: string;
	dev: boolean;
	paused: boolean;
	dirs: string[];
	autoDetected: boolean;
	history: { at: string; file: string; kind: string; detail?: string }[];
	ready: {
		count: number;
		names: string[];
		players: { battletag: string; avatar: string | null; until: string }[];
		ok: boolean;
	};
	me: { battletag: string; avatar: string | null; toon: string | null } | null;
	meReady: boolean;
	meUntil: string | null;
	updateVersion: string | null;
	updateDownloading: string | null;
	sc2: {
		status: 'menus' | 'lobby' | 'ingame';
		uar: boolean;
		players?: number;
		displayTime?: number;
	} | null;
	presenceList: PresenceEntry[] | null;
	/** the site's grouping of `presenceList`; null against a server without it */
	presenceGroups: {
		lobbies: PresenceGroup<PresenceEntry>[];
		games: PresenceGroup<PresenceEntry>[];
	} | null;
	presenceKnown?: Record<string, { toon: string; avatar?: string }>;
	config: {
		noBackfill: boolean;
		notifyUploads: boolean;
		notifyReady: boolean;
		notifyLobby: boolean;
		autostart: boolean;
	};
}

declare global {
	interface Window {
		uarCompanion: {
			snapshot: () => Promise<Snapshot>;
			setConfig: (patch: Record<string, unknown>) => Promise<Snapshot>;
			addFolder: () => Promise<Snapshot>;
			removeFolder: (path: string) => Promise<Snapshot>;
			redetect: () => Promise<Snapshot>;
			pause: (paused: boolean) => Promise<Snapshot>;
			openWebsite: () => Promise<void>;
			openGithub: () => Promise<void>;
			openLog: () => Promise<void>;
	installUpdate: () => Promise<void>;
			login: () => Promise<Snapshot>;
			logout: () => Promise<Snapshot>;
			setReady: (on: boolean) => Promise<Snapshot>;
			onUpdate: (cb: (snapshot: Snapshot) => void) => () => void;
		};
	}
}

export {};
