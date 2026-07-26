import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'uar-shared/tokens.css';
import 'uar-shared/base.css';
import { mount } from 'svelte';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
