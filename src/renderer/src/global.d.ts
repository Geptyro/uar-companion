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
	ready: { count: number; names: string[]; ok: boolean };
	config: {
		noBackfill: boolean;
		notifyUploads: boolean;
		notifyReady: boolean;
		autostart: boolean;
	};
}

declare global {
	interface Window {
		uarTray: {
			snapshot: () => Promise<Snapshot>;
			setConfig: (patch: Record<string, unknown>) => Promise<Snapshot>;
			addFolder: () => Promise<Snapshot>;
			removeFolder: (path: string) => Promise<Snapshot>;
			redetect: () => Promise<Snapshot>;
			pause: (paused: boolean) => Promise<Snapshot>;
			openWebsite: () => Promise<void>;
			openLog: () => Promise<void>;
			onUpdate: (cb: (snapshot: Snapshot) => void) => () => void;
		};
	}
}

export {};
