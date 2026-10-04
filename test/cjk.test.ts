import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Window} from 'happy-dom';
import {createServer} from 'vite';
import {STLExporter} from 'three/addons/exporters/STLExporter.js';
import type {Mesh} from 'three';
import {exportTo3MF as exportTo3mf} from 'three-3mf-exporter';
import {unzipSync, strFromU8} from 'fflate';
import type * as BadgeModel from '../src/badge-model.js';

function badgeSvg(text: string) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="20"><g fill="#fff" font-size="110" transform="scale(.1)"><text x="900" y="140" textLength="1600">${text}</text></g></svg>`;
}

await test('CJK fonts and printable outlines', async (t) => {
	const server = await createServer({
		configFile: false,
		server: {middlewareMode: true, watch: null, ws: false},
		resolve: {
			// Use the package's ESM entry when running Vite SSR in Node.
			alias: {
				'opentype.js': fileURLToPath(
					new URL(
						'../node_modules/opentype.js/dist/opentype.mjs',
						import.meta.url,
					),
				),
			},
		},
	});
	const window = new Window();
	const requests: string[] = [];
	let isFailNextRequest = false;
	Object.defineProperties(globalThis, {
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Match the browser's DOM constructor name.
		DOMParser: {value: window.DOMParser, configurable: true},
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Match the browser's DOM constructor name.
		XMLSerializer: {value: window.XMLSerializer, configurable: true},
	});
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push(url);
		if (isFailNextRequest) {
			isFailNextRequest = false;
			return new Response(null, {status: 503});
		}

		const path = url.includes('NotoSansCJK')
			? '../public/fonts/NotoSansCJKsc-Regular.otf'
			: '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
		return new Response(await readFile(new URL(path, import.meta.url)));
	});
	t.after(async () => {
		Reflect.deleteProperty(globalThis, 'DOMParser');
		Reflect.deleteProperty(globalThis, 'XMLSerializer');
		await server.close();
		await window.happyDOM.close();
	});
	const {loadBadgeFonts, getTextOutline, buildModel} =
		(await server.ssrLoadModule('/src/badge-model.ts')) as typeof BadgeModel;

	await t.test(
		'Latin badges skip CJK, ignore hidden text, and retry failures',
		async () => {
			isFailNextRequest = true;
			await assert.rejects(
				loadBadgeFonts(badgeSvg('build')),
				/Unable to load/v,
			);
			const fonts = await loadBadgeFonts(badgeSvg('build'));
			assert.equal(fonts.length, 1);
			const withHiddenCjk = badgeSvg('build').replace(
				'</svg>',
				'<g aria-hidden="true"><text>中文</text></g></svg>',
			);
			const hiddenFonts = await loadBadgeFonts(withHiddenCjk);
			assert.equal(hiddenFonts.length, 1);
			assert.equal(requests.length, 2);
			assert.ok(requests.every((url) => !url.includes('NotoSansCJK')));
		},
	);

	await t.test(
		'CJK loads once for concurrent badges and can retry a failed fetch',
		async () => {
			isFailNextRequest = true;
			await assert.rejects(loadBadgeFonts(badgeSvg('中文')), /Unable to load/v);
			const [chinese, korean] = await Promise.all([
				loadBadgeFonts(badgeSvg('中文')),
				loadBadgeFonts(badgeSvg('한국어')),
			]);
			assert.equal(chinese.length, 2);
			assert.equal(chinese[1], korean[1]);
			assert.equal(
				requests.filter((url) => url.includes('NotoSansCJK')).length,
				2,
			);
		},
	);

	const fonts = await loadBadgeFonts(badgeSvg('中文'));
	const parameters = {height: 12, baseHeight: 2, relief: 0.6, radius: 1.8};
	await t.test(
		'preserves both corners of the flat top of 小 at badge size',
		() => {
			const {group} = buildModel(badgeSvg('小'), parameters, fonts);
			const text = group.getObjectByName('Raised text - 小') as Mesh;
			const positions = text.geometry.getAttribute('position');
			const top = text.geometry.boundingBox!.max.y;
			const topCorners = new Set<number>();
			for (let index = 0; index < positions.count; index += 1) {
				if (Math.abs(positions.getY(index) - top) < 0.000001) {
					topCorners.add(positions.getX(index));
				}
			}

			assert.equal(
				topCorners.size,
				2,
				'The top edge must retain its left and right corners.',
			);
			text.geometry.dispose();
		},
	);
	await Promise.all(
		[
			'中文',
			'繁體中文',
			'日本語ひらがなカタカナ',
			'한국어',
			'build中文日本語한국어',
			'中文，。𠮷',
		].map(async (text) =>
			t.test(`generates raised geometry and binary STL for ${text}`, () => {
				assert.ok(
					[...text].every((character) =>
						fonts.some((font) => font.charToGlyphIndex(character) !== 0),
					),
				);

				const {group, stats} = buildModel(badgeSvg(text), parameters, fonts);
				const raisedText = group.getObjectByName(`Raised text - ${text}`);
				assert.ok(raisedText);
				assert.ok(stats.triangles > 100);
				const stl = new STLExporter().parse(group, {binary: true});
				assert.equal(stl.getUint32(80, true), stats.triangles);
				assert.equal(stl.byteLength, 84 + stats.triangles * 50);
				group.traverse((object) => {
					if (!('geometry' in object)) {
						return;
					}

					const mesh = object as Mesh;
					assert.ok(
						mesh.geometry
							.getAttribute('position')
							.array.every((value) => Number.isFinite(value)),
					);
					mesh.geometry.dispose();
				});
			}),
		),
	);

	await t.test(
		'exports CJK geometry and Unicode part names in 3MF',
		async () => {
			const text = '中文日本語한국어';
			const {group} = buildModel(badgeSvg(text), parameters, fonts);
			const blob = await exportTo3mf(group);
			const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
			const modelXml = strFromU8(files['3D/3dmodel.model']);
			assert.ok(modelXml.includes(`Raised text - ${text}`));
			assert.ok(modelXml.includes('<triangle '));
		},
	);

	await t.test('preserves Latin kerning and scales mixed font units', () => {
		assert.deepEqual(
			getTextOutline(fonts, 'AV badge', 11).commands,
			getTextOutline([fonts[0]], 'AV badge', 11).commands,
		);
		const latin = fonts[0].charToGlyph('A');
		const cjk = fonts[1].charToGlyph('中');
		const cursor = (latin.advanceWidth! / fonts[0].unitsPerEm) * 11;
		const {commands} = getTextOutline(fonts, 'A中', 11);
		const firstCjkCommand = commands[latin.path.commands.length];
		const expected = cjk.path.commands[0];
		assert.equal(firstCjkCommand.type, 'M');
		assert.equal(expected.type, 'M');
		if (!(firstCjkCommand.type === 'M' && expected.type === 'M')) {
			return;
		}

		assert.equal(
			firstCjkCommand.x,
			cursor + (expected.x * 11) / fonts[1].unitsPerEm,
		);
		assert.equal(firstCjkCommand.y, (expected.y * 11) / fonts[1].unitsPerEm);
	});

	await t.test(
		'normalizes decomposed Hangul and reports unsupported characters',
		() => {
			assert.deepEqual(
				getTextOutline(fonts, '한국어'.normalize('NFD'), 11).commands,
				getTextOutline(fonts, '한국어', 11).commands,
			);
			assert.throws(
				() => getTextOutline(fonts, String.fromCodePoint(0x10_ff_ff), 11),
				/No outline font supports/v,
			);
		},
	);
});
