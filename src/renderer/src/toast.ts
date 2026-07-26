const params = new URLSearchParams(location.search);
document.getElementById('title')!.textContent = params.get('title') ?? '';
document.getElementById('sub')!.textContent = params.get('sub') ?? '';
document.getElementById('toast')!.addEventListener('click', () => {
	// preload API is present when the window was opened by the app
	(window as unknown as { uarTray?: { openWebsite: () => void } }).uarTray?.openWebsite();
});
