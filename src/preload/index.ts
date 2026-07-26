import { contextBridge, ipcRenderer } from 'electron';

const api = {
	snapshot: () => ipcRenderer.invoke('snapshot'),
	setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('set-config', patch),
	addFolder: () => ipcRenderer.invoke('add-folder'),
	removeFolder: (path: string) => ipcRenderer.invoke('remove-folder', path),
	redetect: () => ipcRenderer.invoke('redetect'),
	pause: (paused: boolean) => ipcRenderer.invoke('pause', paused),
	openWebsite: () => ipcRenderer.invoke('open-website'),
	openLog: () => ipcRenderer.invoke('open-log'),
	onUpdate: (cb: (snapshot: unknown) => void) => {
		const handler = (_e: unknown, s: unknown) => cb(s);
		ipcRenderer.on('update', handler);
		return () => ipcRenderer.off('update', handler);
	}
};

contextBridge.exposeInMainWorld('uarTray', api);

export type UarTrayApi = typeof api;
