import process from 'node:process';
import {access, cp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Plugin} from 'vite';

async function doesPathExist(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}

		throw error;
	}
}

// Packages Sites metadata after Vite finishes compiling.
export function sites(): Plugin {
	let root = process.cwd();

	return {
		name: 'sites',
		apply: 'build',
		configResolved(config) {
			root = config.root;
		},
		async closeBundle() {
			const outputDirectory = resolve(root, 'dist', '.openai');
			const hostingConfig = resolve(root, '.openai', 'hosting.json');

			await rm(outputDirectory, {recursive: true, force: true});
			await mkdir(outputDirectory, {recursive: true});

			if (await doesPathExist(hostingConfig)) {
				await cp(hostingConfig, resolve(outputDirectory, 'hosting.json'));
			}
		},
	};
}
