import process from 'node:process';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {sites} from './build/sites-vite-plugin.js';

// MacOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig({
	server: {
		...(isCodexSeatbeltSandbox && {
			watch: {useFsEvents: false, usePolling: true},
		}),
	},
	plugins: [react(), sites()],
});
