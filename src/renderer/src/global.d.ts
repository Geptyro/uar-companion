export interface Snapshot {
	version: string;
	server: string;
	status: string;
	paused: boolean;
	queued: number;
	uploaded: number;
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
	sc2: {
		status: 'menus' | 'lobby' | 'ingame';
		uar: boolean;
		players?: number;
		displayTime?: number;
	} | null;
	presenceList:
		| {
				battletag: string;
				avatar: string | null;
				toon: string | null;
				status: 'lobby' | 'ingame';
				uar: boolean;
				players?: number;
				displayTime?: number;
		  }[]
		| null;
	config: {
		noBackfill: boolean;
		notifyUploads: boolean;
		notifyReady: boolean;
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
			login: () => Promise<Snapshot>;
			logout: () => Promise<Snapshot>;
			setReady: (on: boolean) => Promise<Snapshot>;
			onUpdate: (cb: (snapshot: Snapshot) => void) => () => void;
		};
	}
}

export {};
