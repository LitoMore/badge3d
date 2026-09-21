import * as THREE from 'three';
import * as opentype from 'opentype.js';
import {SVGLoader} from 'three/addons/loaders/SVGLoader.js';
import fontUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url';

export type ModelParameters = {
	height: number;
	baseHeight: number;
	relief: number;
	radius: number;
};

export type ModelStats = {
	width: number;
	height: number;
	depth: number;
	triangles: number;
};

let badgeFontPromise: Promise<opentype.Font> | undefined;

export async function loadBadgeFont() {
	badgeFontPromise ??= fetch(fontUrl)
		.then(async (response) => {
			if (!response.ok) {
				throw new Error('Unable to load the outline font.');
			}

			return response.arrayBuffer();
		})
		.then((buffer) => opentype.parse(buffer))
		.catch((error: unknown) => {
			badgeFontPromise = undefined;
			throw error;
		});
	return badgeFontPromise;
}

function roundedRect(width: number, height: number, radius: number) {
	const x = -width / 2;
	const y = -height / 2;
	const r = Math.min(radius, width / 2, height / 2);
	const shape = new THREE.Shape();
	shape.moveTo(x + r, y);
	shape.lineTo(x + width - r, y);
	shape.quadraticCurveTo(x + width, y, x + width, y + r);
	shape.lineTo(x + width, y + height - r);
	shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
	shape.lineTo(x + r, y + height);
	shape.quadraticCurveTo(x, y + height, x, y + height - r);
	shape.lineTo(x, y + r);
	shape.quadraticCurveTo(x, y, x + r, y);
	return shape;
}

export function roundedPlateGeometry(
	width: number,
	height: number,
	radius: number,
) {
	const geometry = new THREE.ShapeGeometry(
		roundedRect(width, height, radius),
		12,
	);
	const positions = geometry.getAttribute('position');
	const uv = new Float32Array(positions.count * 2);
	for (let index = 0; index < positions.count; index += 1) {
		uv[index * 2] = (positions.getX(index) + width / 2) / width;
		uv[index * 2 + 1] = (positions.getY(index) + height / 2) / height;
	}

	geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	return geometry;
}

function segmentShape({
	xMin,
	xMax,
	height,
	radius,
	shouldRoundLeft,
	shouldRoundRight,
}: {
	xMin: number;
	xMax: number;
	height: number;
	radius: number;
	shouldRoundLeft: boolean;
	shouldRoundRight: boolean;
}) {
	const bottom = -height / 2;
	const top = height / 2;
	const r = Math.min(radius, height / 2, (xMax - xMin) / 2);
	const leftRadius = shouldRoundLeft ? r : 0;
	const rightRadius = shouldRoundRight ? r : 0;
	const shape = new THREE.Shape();
	shape.moveTo(xMin + leftRadius, bottom);
	shape.lineTo(xMax - rightRadius, bottom);
	if (rightRadius > 0) {
		shape.quadraticCurveTo(xMax, bottom, xMax, bottom + rightRadius);
	} else {
		shape.lineTo(xMax, bottom);
	}

	shape.lineTo(xMax, top - rightRadius);
	if (rightRadius > 0) {
		shape.quadraticCurveTo(xMax, top, xMax - rightRadius, top);
	} else {
		shape.lineTo(xMax, top);
	}

	shape.lineTo(xMin + leftRadius, top);
	if (leftRadius > 0) {
		shape.quadraticCurveTo(xMin, top, xMin, top - leftRadius);
	} else {
		shape.lineTo(xMin, top);
	}

	shape.lineTo(xMin, bottom + leftRadius);
	if (leftRadius > 0) {
		shape.quadraticCurveTo(xMin, bottom, xMin + leftRadius, bottom);
	} else {
		shape.lineTo(xMin, bottom);
	}

	return shape;
}

export function nonEmptyString(value: unknown) {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonzeroNumber(value: number | undefined) {
	// Zero and NaN viewBox entries need the SVG attribute fallback.
	return value === 0 || Number.isNaN(value) ? undefined : value;
}

export function parseSvgNumber(value: string) {
	// SVG lengths may include units; coerce only their leading numeric value.
	const numericPrefix =
		/^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?)/u.exec(
			value.trimStart(),
		)?.[0];
	return Number(numericPrefix);
}

export function svgMetrics(svg: string) {
	const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
	const root = doc.documentElement;
	const viewBox = root.getAttribute('viewBox')?.split(/[ ,]+/u).map(Number);
	const width =
		nonzeroNumber(viewBox?.[2]) ??
		parseSvgNumber(nonEmptyString(root.getAttribute('width')) ?? '100');
	const height =
		nonzeroNumber(viewBox?.[3]) ??
		parseSvgNumber(nonEmptyString(root.getAttribute('height')) ?? '20');
	const isSocial = normalizeSocialBadge(doc);
	return {doc, width, height, social: isSocial};
}

function normalizeSocialBadge(doc: Document) {
	// Social badges hide the whole text group for accessibility, but only the
	// individually hidden text nodes are visual shadows.
	const labelOverlay = doc.querySelector('rect[id="llink"]');
	if (!labelOverlay) {
		return false;
	}

	let ancestor = labelOverlay.parentElement;
	while (ancestor && ancestor !== doc.documentElement) {
		ancestor.removeAttribute('aria-hidden');
		ancestor = ancestor.parentElement;
	}

	labelOverlay.remove();
	doc.querySelectorAll('[stroke]').forEach((node) => {
		node.setAttribute('stroke', 'none');
	});
	return true;
}

function socialBadgeShapes(doc: Document, width: number, height: number) {
	const rects = [...doc.querySelectorAll(':scope > g > rect[fill]')].filter(
		(node) => Number(node.getAttribute('height')) >= height * 0.95,
	);
	const arrow = doc.querySelector(':scope > g > path[fill]');
	const arrowPoints = arrow
		? (new SVGLoader()
				.parse(
					`<svg xmlns="http://www.w3.org/2000/svg">${new XMLSerializer().serializeToString(arrow)}</svg>`,
				)
				.paths[0]?.subPaths[0]?.getPoints()
				// eslint-disable-next-line unicorn/no-array-reverse -- This fresh array can be mutated; avoid requiring ES2023 toReversed().
				.reverse() ?? [])
		: [];
	return rects.map((rect) => {
		const x = Number(rect.getAttribute('x'));
		const y = Number(rect.getAttribute('y'));
		const w = Number(rect.getAttribute('width'));
		const h = Number(rect.getAttribute('height'));
		const r = Math.min(Number(rect.getAttribute('rx')), w / 2, h / 2);
		const shape = new THREE.Shape();
		const move = (px: number, py: number) =>
			shape.moveTo(px - width / 2, height / 2 - py);
		const line = (px: number, py: number) =>
			shape.lineTo(px - width / 2, height / 2 - py);
		const curve = (cx: number, cy: number, px: number, py: number) =>
			shape.quadraticCurveTo(
				cx - width / 2,
				height / 2 - cy,
				px - width / 2,
				height / 2 - py,
			);
		move(x + r, y);
		line(x + w - r, y);
		curve(x + w, y, x + w, y + r);
		line(x + w, y + h - r);
		curve(x + w, y + h, x + w - r, y + h);
		line(x + r, y + h);
		curve(x, y + h, x, y + h - r);
		// Integrate the pointer into the bubble outline, so it is a single solid
		// rather than overlapping extrusions with internal faces.
		if (arrowPoints.length > 0 && Math.abs(arrowPoints[0].x - x) < 0.001) {
			for (const point of arrowPoints) {
				line(point.x, point.y);
			}
		}

		line(x, y + r);
		curve(x, y, x + r, y);
		shape.closePath();
		return {
			shape,
			fill: nonEmptyString(rect.getAttribute('fill')) ?? '#fafafa',
		};
	});
}

function imageHref(node: Element) {
	return (
		nonEmptyString(node.getAttribute('href')) ??
		nonEmptyString(
			node.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
		) ??
		''
	);
}

function decodeSvgDataUri(source: string) {
	const comma = source.indexOf(',');
	if (comma === -1) {
		return null;
	}

	const metadata = source.slice(5, comma).toLowerCase();
	if (
		!source.toLowerCase().startsWith('data:') ||
		!metadata.startsWith('image/svg+xml')
	) {
		return null;
	}

	try {
		const payload = source.slice(comma + 1);
		if (metadata.split(';').includes('base64')) {
			// eslint-disable-next-line no-restricted-globals -- atob is a supported browser API; no Node deprecation applies here.
			const binary = atob(payload);
			const bytes = Uint8Array.from(binary, (character) =>
				// eslint-disable-next-line unicorn/prefer-code-point -- atob returns single-byte code units, not Unicode text.
				character.charCodeAt(0),
			);
			return new TextDecoder().decode(bytes);
		}

		return decodeURIComponent(payload);
	} catch {
		return null;
	}
}

function svgImageViewport(root: Element, node: Element) {
	const viewBox = root.getAttribute('viewBox')?.split(/[ ,]+/u).map(Number);
	const minX = nonzeroNumber(viewBox?.[0]) ?? 0;
	const minY = nonzeroNumber(viewBox?.[1]) ?? 0;
	const viewWidth =
		nonzeroNumber(viewBox?.[2]) ??
		parseSvgNumber(nonEmptyString(root.getAttribute('width')) ?? '0');
	const viewHeight =
		nonzeroNumber(viewBox?.[3]) ??
		parseSvgNumber(nonEmptyString(root.getAttribute('height')) ?? '0');
	const x = parseSvgNumber(nonEmptyString(node.getAttribute('x')) ?? '0');
	const y = parseSvgNumber(nonEmptyString(node.getAttribute('y')) ?? '0');
	const width = parseSvgNumber(
		nonEmptyString(node.getAttribute('width')) ?? '0',
	);
	const height = parseSvgNumber(
		nonEmptyString(node.getAttribute('height')) ?? '0',
	);
	if (
		[viewWidth, viewHeight, width, height].some(
			(value) => !(Number.isFinite(value) && value > 0),
		)
	) {
		return null;
	}

	return {minX, minY, viewWidth, viewHeight, x, y, width, height};
}

function svgImageLayout(
	{
		viewWidth,
		viewHeight,
		width,
		height,
	}: NonNullable<ReturnType<typeof svgImageViewport>>,
	preserveAspectRatio: string,
) {
	let scaleX = width / viewWidth;
	let scaleY = height / viewHeight;
	let offsetX = 0;
	let offsetY = 0;
	if (!preserveAspectRatio.startsWith('none')) {
		const scale = preserveAspectRatio.includes('slice')
			? Math.max(scaleX, scaleY)
			: Math.min(scaleX, scaleY);
		const renderedWidth = viewWidth * scale;
		const renderedHeight = viewHeight * scale;
		offsetX = preserveAspectRatio.includes('xMin')
			? 0
			: preserveAspectRatio.includes('xMax')
				? width - renderedWidth
				: (width - renderedWidth) / 2;
		offsetY = preserveAspectRatio.includes('YMin')
			? 0
			: preserveAspectRatio.includes('YMax')
				? height - renderedHeight
				: (height - renderedHeight) / 2;
		scaleX = scale;
		scaleY = scale;
	}

	return {
		scaleX,
		scaleY,
		offsetX,
		offsetY,
		renderedHeight: viewHeight * scaleY,
	};
}

function embeddedSvgImage(node: Element) {
	const source = decodeSvgDataUri(imageHref(node));
	if (source === null || source.length === 0) {
		return null;
	}

	const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
	if (
		doc.querySelector('parsererror') !== null ||
		doc.documentElement.localName !== 'svg'
	) {
		return null;
	}

	const viewport = svgImageViewport(doc.documentElement, node);
	if (viewport === null) {
		return null;
	}

	const preserveAspectRatio =
		nonEmptyString(node.getAttribute('preserveAspectRatio')) ?? 'xMidYMid meet';
	return {
		doc,
		minX: viewport.minX,
		minY: viewport.minY,
		viewWidth: viewport.viewWidth,
		viewHeight: viewport.viewHeight,
		x: viewport.x,
		y: viewport.y,
		...svgImageLayout(viewport, preserveAspectRatio),
	};
}

function cumulativeScale(node: Element) {
	let scale = 1;
	let current: Element | undefined = node;
	while (current) {
		const transform = current.getAttribute('transform') ?? '';
		const scaleValue = /scale\(\s*(?<scale>[\d.]+)/u.exec(transform)?.groups
			?.scale;
		if (scaleValue !== undefined) {
			scale *= Number(scaleValue);
		}

		current = current.parentElement ?? undefined;
	}

	return scale;
}

function inheritedTextFill(node: Element) {
	let current: Element | undefined = node;
	while (current) {
		const directFill = current.getAttribute('fill');
		const styleFill = current
			.getAttribute('style')
			?.match(/(?:^|;)\s*fill\s*:\s*(?<fill>[^;]+)/iu)?.groups?.fill;
		const fill = nonEmptyString(directFill) ?? styleFill;
		if (
			fill !== undefined &&
			fill !== 'none' &&
			fill.length > 0 &&
			!fill.startsWith('url(')
		) {
			return fill.trim();
		}

		current = current.parentElement ?? undefined;
	}

	return '#fff';
}

function svgColor(fill: string, fallback = 0x34_36_3a) {
	const color = new THREE.Color(fallback);
	if (
		fill !== 'currentColor' &&
		/^(?:#[\da-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|[a-z]+)$/iu.test(fill)
	) {
		color.setStyle(fill);
	}

	return color;
}

function badgeSegments(doc: Document, svgWidth: number, svgHeight: number) {
	return (
		[...doc.querySelectorAll(':scope > g > rect[fill]')]
			.map((node) => ({
				x: parseSvgNumber(nonEmptyString(node.getAttribute('x')) ?? '0'),
				y: parseSvgNumber(nonEmptyString(node.getAttribute('y')) ?? '0'),
				width: parseSvgNumber(
					nonEmptyString(node.getAttribute('width')) ?? '0',
				),
				height: parseSvgNumber(
					nonEmptyString(node.getAttribute('height')) ?? String(svgHeight),
				),
				fill: node.getAttribute('fill') ?? '',
			}))
			.filter(
				(segment) =>
					segment.width > 0 &&
					segment.height >= svgHeight * 0.95 &&
					segment.y <= svgHeight * 0.05 &&
					!segment.fill.startsWith('url(') &&
					segment.fill !== 'none',
			)
			.map((segment) => ({
				...segment,
				x: Math.max(0, segment.x),
				width: Math.min(segment.width, svgWidth - Math.max(0, segment.x)),
			}))
			.filter((segment) => segment.width > 0)
			// eslint-disable-next-line unicorn/no-array-sort -- This fresh array can be mutated; avoid requiring ES2023 toSorted().
			.sort((left, right) => left.x - right.x)
	);
}

function appendGlyphCommand(
	outline: opentype.Path,
	command: opentype.PathCommand,
	cursor: number,
	unitScale: number,
) {
	switch (command.type) {
		case 'M': {
			outline.moveTo(cursor + command.x * unitScale, command.y * unitScale);

			return;
		}

		case 'L': {
			outline.lineTo(cursor + command.x * unitScale, command.y * unitScale);

			return;
		}

		case 'Q': {
			outline.quadraticCurveTo(
				cursor + command.x1 * unitScale,
				command.y1 * unitScale,
				cursor + command.x * unitScale,
				command.y * unitScale,
			);

			return;
		}

		case 'C': {
			outline.bezierCurveTo(
				cursor + command.x1 * unitScale,
				command.y1 * unitScale,
				cursor + command.x2 * unitScale,
				command.y2 * unitScale,
				cursor + command.x * unitScale,
				command.y * unitScale,
			);

			return;
		}

		case 'Z': {
			outline.closePath();
		}
	}
}

function getTextOutline(font: opentype.Font, text: string, fontSize: number) {
	const outline = new opentype.Path();
	const characters = [...text];
	const unitScale = fontSize / font.unitsPerEm;
	let cursor = 0;

	for (const [index, character] of characters.entries()) {
		const glyph = font.charToGlyph(character);
		for (const command of glyph.path.commands) {
			appendGlyphCommand(outline, command, cursor, unitScale);
		}

		const nextCharacter = characters.at(index + 1);
		const nextGlyph =
			nextCharacter === undefined ? undefined : font.charToGlyph(nextCharacter);
		cursor += (glyph.advanceWidth ?? font.unitsPerEm) * unitScale;
		if (nextGlyph) {
			cursor += font.getKerningValue(glyph, nextGlyph) * unitScale;
		}
	}

	return outline;
}

function addLogoToGroup(
	group: THREE.Group,
	image: NonNullable<ReturnType<typeof embeddedSvgImage>>,
	{
		imageIndex,
		parameters,
		mmPerUnit,
		width,
		height,
	}: {
		imageIndex: number;
		parameters: ModelParameters;
		mmPerUnit: number;
		width: number;
		height: number;
	},
) {
	const embeddedRoot = new XMLSerializer().serializeToString(
		image.doc.documentElement,
	);
	const flipY = image.minY * 2 + image.viewHeight;
	const parsed = new SVGLoader().parse(
		`<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(0 ${flipY}) scale(1 -1)">${embeddedRoot}</g></svg>`,
	);
	const logoName =
		nonEmptyString(image.doc.querySelector('title')?.textContent?.trim()) ??
		`Logo ${imageIndex + 1}`;

	for (const [pathIndex, path] of parsed.paths.entries()) {
		const shapes = path.toShapes();
		if (shapes.length === 0) {
			continue;
		}

		const geometry = new THREE.ExtrudeGeometry(shapes, {
			depth: parameters.relief,
			bevelEnabled: false,
			curveSegments: 9,
		});
		geometry.scale(image.scaleX * mmPerUnit, image.scaleY * mmPerUnit, 1);
		const color = path.color.clone();
		const mesh = new THREE.Mesh(geometry, [
			new THREE.MeshBasicMaterial({color}),
			new THREE.MeshStandardMaterial({
				color,
				roughness: 0.46,
				metalness: 0,
			}),
		]);
		mesh.name = `Raised logo - ${logoName}${parsed.paths.length > 1 ? ` (${pathIndex + 1})` : ''}`;
		mesh.position.set(
			(image.x + image.offsetX - image.minX * image.scaleX) * mmPerUnit -
				width / 2,
			height / 2 -
				(image.y +
					image.offsetY +
					image.renderedHeight +
					image.minY * image.scaleY) *
					mmPerUnit,
			parameters.baseHeight,
		);
		group.add(mesh);
	}
}

export function buildModel(
	svg: string,
	parameters: ModelParameters,
	font: opentype.Font,
) {
	const {doc, width: svgWidth, height: svgHeight, social} = svgMetrics(svg);
	const mmPerUnit = parameters.height / svgHeight;
	const width = svgWidth * mmPerUnit;
	const {height} = parameters;
	const group = new THREE.Group();
	group.name = 'Printable badge';

	const segments = badgeSegments(doc, svgWidth, svgHeight);
	if (social) {
		for (const [index, {shape, fill}] of socialBadgeShapes(
			doc,
			svgWidth,
			svgHeight,
		).entries()) {
			const geometry = new THREE.ExtrudeGeometry(shape, {
				depth: parameters.baseHeight,
				bevelEnabled: false,
				curveSegments: 10,
			});
			geometry.scale(mmPerUnit, mmPerUnit, 1);
			const color = svgColor(fill);
			const mesh = new THREE.Mesh(geometry, [
				new THREE.MeshBasicMaterial({color}),
				new THREE.MeshStandardMaterial({
					color,
					roughness: 0.58,
					metalness: 0.02,
				}),
			]);
			mesh.name = `Badge color segment ${index + 1} - ${fill}`;
			group.add(mesh);
		}
	} else if (segments.length > 0) {
		for (const [index, segment] of segments.entries()) {
			const xMin = segment.x * mmPerUnit - width / 2;
			const xMax = (segment.x + segment.width) * mmPerUnit - width / 2;
			const color = svgColor(segment.fill);
			const geometry = new THREE.ExtrudeGeometry(
				segmentShape({
					xMin,
					xMax,
					height,
					radius: parameters.radius,
					shouldRoundLeft: segment.x <= 0.001,
					shouldRoundRight: segment.x + segment.width >= svgWidth - 0.001,
				}),
				{depth: parameters.baseHeight, bevelEnabled: false, curveSegments: 10},
			);
			const mesh = new THREE.Mesh(geometry, [
				new THREE.MeshBasicMaterial({color}),
				new THREE.MeshStandardMaterial({
					color,
					roughness: 0.58,
					metalness: 0.02,
				}),
			]);
			mesh.name = `Badge color segment ${index + 1} - ${segment.fill}`;
			group.add(mesh);
		}
	} else {
		const baseGeometry = new THREE.ExtrudeGeometry(
			roundedRect(width, height, parameters.radius),
			{depth: parameters.baseHeight, bevelEnabled: false, curveSegments: 10},
		);
		const base = new THREE.Mesh(
			baseGeometry,
			new THREE.MeshStandardMaterial({
				color: 0x34_36_3a,
				roughness: 0.62,
				metalness: 0.05,
			}),
		);
		base.name = 'Badge base';
		group.add(base);
	}

	const logoImages = [...doc.querySelectorAll('image')]
		.map((node) => embeddedSvgImage(node))
		.filter((image) => image !== null);
	for (const [imageIndex, image] of logoImages.entries()) {
		addLogoToGroup(group, image, {
			imageIndex,
			parameters,
			mmPerUnit,
			width,
			height,
		});
	}

	const visibleText = [...doc.querySelectorAll('text')].filter(
		(node) => !node.closest('[aria-hidden="true"]'),
	);

	for (const node of visibleText) {
		const content = node.textContent?.trim();
		if (content === undefined || content.length === 0) {
			continue;
		}

		const scale = cumulativeScale(node);
		const x =
			parseSvgNumber(nonEmptyString(node.getAttribute('x')) ?? '0') * scale;
		const y =
			parseSvgNumber(nonEmptyString(node.getAttribute('y')) ?? '0') * scale;
		const textLength =
			parseSvgNumber(nonEmptyString(node.getAttribute('textLength')) ?? '0') *
			scale;
		const fontSize =
			parseSvgNumber(
				nonEmptyString(node.getAttribute('font-size')) ??
					nonEmptyString(
						node.closest('[font-size]')?.getAttribute('font-size'),
					) ??
					'11',
			) * scale;
		const outline = getTextOutline(font, content, fontSize);
		const bounds = outline.getBoundingBox();
		const naturalWidth = Math.max(0.001, bounds.x2 - bounds.x1);
		const desiredWidth = textLength > 0 ? textLength : naturalWidth;
		const horizontalScale = desiredWidth / naturalWidth;
		const pathData = outline.toPathData(3);
		const parsed = new SVGLoader().parse(
			`<svg xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="${pathData}"/></svg>`,
		);
		const shapes = parsed.paths.flatMap((path) => path.toShapes());
		if (shapes.length === 0) {
			continue;
		}

		const geometry = new THREE.ExtrudeGeometry(shapes, {
			depth: parameters.relief,
			bevelEnabled: false,
			curveSegments: 7,
		});
		geometry.scale(horizontalScale * mmPerUnit, mmPerUnit, 1);
		geometry.computeBoundingBox();
		const geometryBounds = geometry.boundingBox;
		if (!geometryBounds) {
			continue;
		}

		const geometryWidth = geometryBounds.max.x - geometryBounds.min.x;
		const textColor = svgColor(inheritedTextFill(node), 0xff_ff_ff);
		const capMaterial = new THREE.MeshBasicMaterial({color: textColor});
		const sideMaterial = new THREE.MeshStandardMaterial({
			color: textColor,
			roughness: 0.46,
			metalness: 0,
		});
		const mesh = new THREE.Mesh(geometry, [capMaterial, sideMaterial]);
		mesh.name = `Raised text - ${content}`;
		mesh.position.set(
			x * mmPerUnit - width / 2 - geometryWidth / 2 - geometryBounds.min.x,
			height / 2 - y * mmPerUnit,
			parameters.baseHeight,
		);
		group.add(mesh);
	}

	let triangles = 0;
	group.traverse((item) => {
		if (!isMesh(item)) {
			return;
		}

		const {geometry} = item;
		triangles +=
			(geometry.index?.count ?? geometry.attributes.position.count) / 3;
	});

	return {
		group,
		stats: {
			width,
			height,
			depth: parameters.baseHeight + parameters.relief,
			triangles: Math.round(triangles),
		},
	};
}

export async function createSvgTexture(svg: string) {
	return new Promise<THREE.Texture>((resolve, reject) => {
		const {doc} = svgMetrics(svg);
		doc.querySelectorAll('image').forEach((node) => {
			if (nonEmptyString(decodeSvgDataUri(imageHref(node))) !== undefined) {
				node.remove();
			}
		});
		doc
			.querySelectorAll('text, [aria-hidden="true"], [fill^="url("]')
			.forEach((node) => {
				node.remove();
			});
		doc.querySelectorAll('[clip-path]').forEach((node) => {
			node.removeAttribute('clip-path');
		});
		doc.querySelectorAll('filter, linearGradient, clipPath').forEach((node) => {
			node.remove();
		});
		const flatSvg = new XMLSerializer().serializeToString(doc.documentElement);
		const blob = new Blob([flatSvg], {type: 'image/svg+xml'});
		const url = URL.createObjectURL(blob);
		const image = new Image();
		const timeout = setTimeout(() => {
			image.src = '';
			URL.revokeObjectURL(url);
			reject(new Error('Badge artwork took too long to decode'));
		}, 5000);
		image.addEventListener('load', () => {
			clearTimeout(timeout);
			const texture = new THREE.Texture(image);
			texture.colorSpace = THREE.SRGBColorSpace;
			texture.magFilter = THREE.NearestFilter;
			texture.minFilter = THREE.NearestFilter;
			texture.generateMipmaps = false;
			texture.wrapS = THREE.ClampToEdgeWrapping;
			texture.wrapT = THREE.ClampToEdgeWrapping;
			texture.needsUpdate = true;
			URL.revokeObjectURL(url);
			resolve(texture);
		});

		image.addEventListener('error', () => {
			clearTimeout(timeout);
			URL.revokeObjectURL(url);
			reject(new Error('Unable to render badge texture'));
		});

		image.src = url;
	});
}

export function isMesh(object: THREE.Object3D): object is THREE.Mesh {
	return object instanceof THREE.Mesh;
}
