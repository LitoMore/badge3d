// eslint-disable-next-line import-x/no-unassigned-import -- Load the existing module declaration before augmenting it.
import 'opentype.js';

// @types/opentype.js targets 1.x; 2.x also accepts SVG serialization options.
declare module 'opentype.js' {
	// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- An interface is required to merge with the library's Path class.
	interface Path {
		toPathData(options: {
			decimalPlaces: number;
			optimize: boolean;
			flipY: boolean;
		}): string;
	}
}
