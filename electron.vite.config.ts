import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	main: {},
	preload: {},
	renderer: {
		plugins: [svelte()],
		build: {
			rollupOptions: {
				input: {
					index: resolve(import.meta.dirname, 'src/renderer/index.html'),
					toast: resolve(import.meta.dirname, 'src/renderer/toast.html')
				}
			}
		}
	}
});
