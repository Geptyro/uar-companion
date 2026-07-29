import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'sveltekit-commons/tokens.css';
import 'uar-shared/palette.css';
import 'sveltekit-commons/base.css';
import { mount } from 'svelte';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
