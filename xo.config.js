import {fixupConfigRules} from '@eslint/compat';
import prettier from 'eslint-config-prettier';
import xoReact from 'eslint-config-xo-react';

export default [
	...fixupConfigRules(xoReact()),
	prettier,
	{prettier: true},
	{
		files: ['src/**/*.{ts,tsx}'],
		rules: {
			// Keep browser code compatible with our ES2022 target.
			'require-unicode-regexp': ['error', {requireFlag: 'u'}],
		},
	},
];
