import { contextBridge, ipcRenderer } from 'electron';

const api = {
	snapshot: () => ipcRenderer.invoke('snapshot'),
	setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('set-config', patch),
	addFolder: () => ipcRenderer.invoke('add-folder'),
	removeFolder: (path: string) => ipcRenderer.invoke('remove-folder', path),
	redetect: () => ipcRenderer.invoke('redetect'),
	pause: (paused: boolean) => ipcRenderer.invoke('pause', paused),
	openWebsite: () => ipcRenderer.invoke('open-website'),
	openGithub: () => ipcRenderer.invoke('open-github'),
	openLog: () => ipcRenderer.invoke('open-log'),
	installUpdate: () => ipcRenderer.invoke('install-update'),
	login: () => ipcRenderer.invoke('login'),
	logout: () => ipcRenderer.invoke('logout'),
	setReady: (on: boolean) => ipcRenderer.invoke('set-ready', on),
	onUpdate: (cb: (snapshot: unknown) => void) => {
		const handler = (_e: unknown, s: unknown) => cb(s);
		ipcRenderer.on('update', handler);
		return () => ipcRenderer.off('update', handler);
	}
};

contextBridge.exposeInMainWorld('uarCompanion', api);

export type UarTrayApi = typeof api;
