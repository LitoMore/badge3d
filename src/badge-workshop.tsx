import {
	type SubmitEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import {
	ArrowRight,
	Check,
	Link,
	Focus,
	Monitor,
	Moon,
	Rotate3d,
	RotateCcw,
	Sun,
	TriangleAlert,
} from 'lucide-react';
import * as THREE from 'three';
import {STLExporter} from 'three/addons/exporters/STLExporter.js';
import {strToU8, zipSync} from 'fflate';
import {badgeFilenameStem} from './badge-url.js';
import {BadgePreview} from './badge-preview.js';
import {
	type ModelParameters,
	type ModelStats,
	isMesh,
	nonEmptyString,
	parseSvgNumber,
	svgMetrics,
} from './badge-model.js';

const DEFAULT_BADGE = 'https://img.shields.io/badge/build-passing-brightgreen';
const EXAMPLES = [
	['BUILD', DEFAULT_BADGE],
	['COVERAGE', 'https://img.shields.io/codecov/c/github/codecov/umbrella'],
	['VERSION', 'https://img.shields.io/npm/v/typescript'],
	['JSR', 'https://jsr.io/badges/@std/path'],
] as const;
const DEFAULT_MODEL_HEIGHT = 15;
const DEFAULT_BASE_HEIGHT = 1.5;
const DEFAULT_RELIEF = 1;
const DEFAULT_BADGE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="88" height="20" role="img" aria-label="build: passing"><title>build: passing</title><filter id="blur"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="88" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="37" height="20" fill="#555"/><rect x="37" width="51" height="20" fill="#44BB00"/><rect width="88" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="195" y="150" fill-opacity=".8" filter="url(#blur)" textLength="270">build</text><text x="195" y="150" fill-opacity=".3" textLength="270">build</text></g><text x="195" y="140" textLength="270">build</text></g><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="615" y="150" fill-opacity=".8" filter="url(#blur)" textLength="410">passing</text><text x="615" y="150" fill-opacity=".3" textLength="410">passing</text></g><text x="615" y="140" textLength="410">passing</text></g></g></svg>';

type AdjustableModelParameter = Exclude<keyof ModelParameters, 'radius'>;

type ColorTheme = 'system' | 'light' | 'dark';

type PrintablePart = {
	color: string;
	meshes: THREE.Mesh[];
};

function parseBadgeUrl(value: string) {
	const target = new URL(value);
	const isShields = ['shields.io', 'img.shields.io'].includes(target.hostname);
	const isJsrBadge =
		target.hostname === 'jsr.io' && target.pathname.startsWith('/badges/');
	if (target.protocol !== 'https:' || (!isShields && !isJsrBadge)) {
		throw new Error('Paste a secure Shields.io URL.');
	}

	return target;
}

function printableModel(model: THREE.Group) {
	const printable = model.clone(true);
	const previewNodes: THREE.Object3D[] = [];
	printable.traverse((node) => {
		if (node.userData.previewOnly === true) {
			previewNodes.push(node);
		}
	});
	for (const node of previewNodes) {
		node.parent?.remove(node);
	}

	printable.rotation.set(0, 0, 0);
	printable.updateMatrixWorld(true);
	return printable;
}

function meshColor(mesh: THREE.Mesh) {
	const materials = Array.isArray(mesh.material)
		? mesh.material
		: [mesh.material];
	const material = materials.find((candidate) => 'color' in candidate) as
		| (THREE.Material & {
				color?: THREE.Color;
		  })
		| undefined;
	return `#${material?.color?.getHexString(THREE.SRGBColorSpace) ?? '808080'}`.toUpperCase();
}

function printableParts(printable: THREE.Group) {
	const byColor = new Map<string, THREE.Mesh[]>();
	printable.traverse((node) => {
		if (!isMesh(node)) {
			return;
		}

		const color = meshColor(node);
		const meshes = byColor.get(color) ?? [];
		meshes.push(node);
		byColor.set(color, meshes);
	});
	return Array.from(byColor, ([color, meshes]): PrintablePart => ({
		color,
		meshes,
	}));
}

function partAsGroup(part: PrintablePart) {
	const group = new THREE.Group();
	for (const source of part.meshes) {
		const geometry = source.geometry.clone();
		geometry.applyMatrix4(source.matrixWorld);
		group.add(new THREE.Mesh(geometry));
	}

	group.updateMatrixWorld(true);
	return group;
}

function downloadBlob(blob: Blob, filename: string) {
	const href = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = href;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => {
		URL.revokeObjectURL(href);
	}, 0);
}

function xmlEscape(value: string) {
	return value.replaceAll(
		/["&'<>]/gu,
		(character) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&apos;',
			})[character] ?? character,
	);
}

function printableName(value: string) {
	// Bambu Studio rejects filename separators and control characters in part names.
	const name = value
		.replaceAll(/["*/:<>?\\|]+/gu, ' - ')
		.replaceAll(/\p{Control}/gu, ' ')
		.replaceAll(/\s+/gu, ' ')
		.trim();
	return name.length > 0 ? name : 'Badge part';
}

async function create3mf(printable: THREE.Group) {
	// The exporter interpolates names into XML without escaping them.
	printable.traverse((node) => {
		node.name = xmlEscape(printableName(node.name));
	});
	const {defaultPrintConfig, exportTo3MF: exportTo3mf} =
		await import('three-3mf-exporter');
	return exportTo3mf(printable, {
		metadata: {
			// Bambu Studio uses the exporter's Application marker to load filament colors.
			...defaultPrintConfig.metadata,
			ApplicationTitle: 'Badge3D multicolor badge',
		},
	});
}

function RangeControl({
	label,
	value,
	min,
	max,
	step,
	unit,
	onChange,
}: {
	readonly label: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly unit: string;
	readonly onChange: (value: number) => void;
}) {
	const percentage = ((value - min) / (max - min)) * 100;
	return (
		<label className="range-control">
			<span>
				<b>{label}</b>
				<output>
					{value.toFixed(step < 1 ? 1 : 0)} {unit}
				</output>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				style={{'--range': `${percentage}%`} as React.CSSProperties}
				onChange={(event) => {
					onChange(Number(event.target.value));
				}}
			/>
		</label>
	);
}

export function BadgeWorkshop() {
	const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
		try {
			const storedTheme = localStorage.getItem('badge3d-color-theme');
			return storedTheme === 'light' || storedTheme === 'dark'
				? storedTheme
				: 'system';
		} catch {
			return 'system';
		}
	});
	// eslint-disable-next-line react/hook-use-state -- This captures the initial URL once; it intentionally has no setter.
	const [initialBadgeUrl] = useState(
		() =>
			nonEmptyString(
				new URLSearchParams(globalThis.location.search).get('badgeUrl')?.trim(),
			) ?? DEFAULT_BADGE,
	);
	const [url, setUrl] = useState(initialBadgeUrl);
	const [loadedBadgeUrl, setLoadedBadgeUrl] = useState(initialBadgeUrl);
	const [svg, setSvg] = useState(
		initialBadgeUrl === DEFAULT_BADGE ? DEFAULT_BADGE_SVG : '',
	);
	const [shareFeedback, setShareFeedback] = useState({url: '', message: ''});
	const shareMessage = shareFeedback.url === url ? shareFeedback.message : '';
	const [status, setStatus] = useState(
		initialBadgeUrl === DEFAULT_BADGE ? 'Ready' : 'Building model…',
	);
	const [loading, setLoading] = useState(initialBadgeUrl !== DEFAULT_BADGE);
	const [loadError, setLoadError] = useState('');
	const [modelReady, setModelReady] = useState(false);
	const [exporting3mf, setExporting3mf] = useState(false);
	const [exportError, setExportError] = useState('');
	const [parameters, setParameters] = useState<ModelParameters>({
		height: DEFAULT_MODEL_HEIGHT,
		baseHeight: DEFAULT_BASE_HEIGHT,
		relief: DEFAULT_RELIEF,
		radius: (DEFAULT_MODEL_HEIGHT * 3) / 20,
	});
	const [stats, setStats] = useState<ModelStats>({
		width: (DEFAULT_MODEL_HEIGHT * 88) / 20,
		height: DEFAULT_MODEL_HEIGHT,
		depth: DEFAULT_BASE_HEIGHT + DEFAULT_RELIEF,
		triangles: 0,
	});
	const [isAutoRotating, setIsAutoRotating] = useState(false);
	const [resetToken, setResetToken] = useState(0);
	const modelRef = useRef<THREE.Group | undefined>(null);

	useEffect(() => {
		const root = document.documentElement;
		const systemTheme = globalThis.matchMedia('(prefers-color-scheme: dark)');
		const themeColor = document.querySelector<HTMLMetaElement>(
			'meta[name="theme-color"]',
		);

		const applyTheme = () => {
			if (colorTheme === 'system') {
				delete root.dataset.theme;
				themeColor?.setAttribute(
					'content',
					systemTheme.matches ? '#171816' : '#f2eee5',
				);
			} else {
				root.dataset.theme = colorTheme;
				themeColor?.setAttribute(
					'content',
					colorTheme === 'dark' ? '#171816' : '#f2eee5',
				);
			}
		};

		try {
			if (colorTheme === 'system') {
				localStorage.removeItem('badge3d-color-theme');
			} else {
				localStorage.setItem('badge3d-color-theme', colorTheme);
			}
		} catch {
			// The theme still applies for this visit when storage is unavailable.
		}

		applyTheme();
		if (colorTheme === 'system') {
			systemTheme.addEventListener('change', applyTheme);
		}

		return () => {
			systemTheme.removeEventListener('change', applyTheme);
		};
	}, [colorTheme]);

	const loadBadge = useCallback(async (nextUrl: string) => {
		setLoading(true);
		setModelReady(false);
		modelRef.current = undefined;
		setLoadError('');
		setStatus('Building model…');
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort();
		}, 12_000);
		try {
			const target = parseBadgeUrl(nextUrl);
			const response = await fetch(target, {
				headers: {Accept: 'image/svg+xml'},
				signal: controller.signal,
			});
			const source = await response.text();
			if (!response.ok || !source.trimStart().startsWith('<svg')) {
				throw new Error('That URL did not return a valid SVG badge.');
			}

			if (source.length > 250_000) {
				throw new Error('That SVG is too large to process.');
			}

			setSvg(source);
			setLoadedBadgeUrl(target.href);
			const {doc, height: sourceHeight} = svgMetrics(source);
			const nativeRadius = parseSvgNumber(
				nonEmptyString(
					doc
						.querySelector(':scope clipPath rect[rx], :scope > rect[rx]')
						?.getAttribute('rx'),
				) ?? '0',
			);
			setParameters((current) => ({
				...current,
				radius: nativeRadius * (current.height / sourceHeight),
			}));
		} catch (error) {
			const message =
				error instanceof DOMException && error.name === 'AbortError'
					? 'The badge request timed out. Try again.'
					: error instanceof Error
						? error.message
						: 'Conversion failed. Check the URL.';
			setLoadError(message);
			setStatus(message);
		} finally {
			clearTimeout(timeout);
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (new URLSearchParams(globalThis.location.search).has('badgeUrl')) {
			globalThis.history.replaceState(
				globalThis.history.state,
				'',
				globalThis.location.pathname + globalThis.location.hash,
			);
		}

		if (initialBadgeUrl === DEFAULT_BADGE) {
			return;
		}

		const timeout = setTimeout(() => {
			void loadBadge(initialBadgeUrl);
		}, 0);
		return () => {
			clearTimeout(timeout);
		};
	}, [initialBadgeUrl, loadBadge]);

	useEffect(() => {
		if (shareFeedback.message !== 'Link copied!') {
			return;
		}

		const timeout = setTimeout(() => {
			setShareFeedback({url: '', message: ''});
		}, 1000);
		return () => {
			clearTimeout(timeout);
		};
	}, [shareFeedback]);

	const copyShareableLink = async () => {
		try {
			parseBadgeUrl(url);
		} catch {
			setShareFeedback({
				url,
				message: 'Enter a secure Shields.io URL to share.',
			});
			return;
		}

		const shareUrl = new URL(
			globalThis.location.pathname,
			globalThis.location.origin,
		);
		shareUrl.searchParams.set('badgeUrl', url.trim());
		try {
			await navigator.clipboard.writeText(shareUrl.href);
			setShareFeedback({url, message: 'Link copied!'});
		} catch {
			setShareFeedback({url, message: 'Unable to copy. Please try again.'});
		}
	};

	const convert = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		void loadBadge(url);
	};

	const updateParameter = (key: AdjustableModelParameter, value: number) => {
		setParameters((current) =>
			key === 'height'
				? {
						...current,
						height: value,
						radius: current.radius * (value / current.height),
					}
				: {...current, [key]: value},
		);
	};

	const resetParameters = () => {
		setParameters((current) => ({
			height: DEFAULT_MODEL_HEIGHT,
			baseHeight: DEFAULT_BASE_HEIGHT,
			relief: DEFAULT_RELIEF,
			radius: current.radius * (DEFAULT_MODEL_HEIGHT / current.height),
		}));
	};

	const onModelBuilding = useCallback(() => {
		modelRef.current = undefined;
		setModelReady(false);
		setStatus('Preparing text…');
	}, []);

	const onPreviewError = useCallback((message: string) => {
		modelRef.current = undefined;
		setModelReady(false);
		setSvg('');
		setLoadError(message);
		setStatus(message);
		setLoading(false);
	}, []);

	const onModelReady = useCallback(
		(group: THREE.Group, nextStats: ModelStats) => {
			group.userData.filenameStem = badgeFilenameStem(loadedBadgeUrl);
			modelRef.current = group;
			setStats(nextStats);
			setModelReady(true);
			setStatus('Ready');
		},
		[loadedBadgeUrl],
	);

	const getExportParts = () => {
		const model = modelRef.current;
		if (!model) {
			return null;
		}

		const printable = printableModel(model);
		return {
			printable,
			parts: printableParts(printable),
			filenameStem: model.userData.filenameStem as string,
		};
	};

	const downloadStl = () => {
		const exported = getExportParts();
		if (!exported) {
			return;
		}

		const {printable, filenameStem} = exported;
		const data = new STLExporter().parse(printable, {binary: true});
		downloadBlob(new Blob([data], {type: 'model/stl'}), `${filenameStem}.stl`);
	};

	const download3mf = async () => {
		if (exporting3mf) {
			return;
		}

		const model = modelRef.current;
		if (!model) {
			return;
		}

		const filenameStem = model.userData.filenameStem as string;
		setExporting3mf(true);
		setExportError('');
		try {
			const blob = await create3mf(printableModel(model));
			downloadBlob(blob, `${filenameStem}-multicolor.3mf`);
		} catch (error) {
			setExportError(
				error instanceof Error
					? error.message
					: 'Unable to export 3MF. Try again.',
			);
		} finally {
			setExporting3mf(false);
		}
	};

	const downloadColorStls = () => {
		const exported = getExportParts();
		if (!exported) {
			return;
		}

		const files: Record<string, Uint8Array> = {};
		for (const [index, part] of exported.parts.entries()) {
			const group = partAsGroup(part);
			const data = new STLExporter().parse(group, {binary: true});
			files[
				`${exported.filenameStem}-color-${String(index + 1).padStart(2, '0')}-${part.color.slice(1).toLowerCase()}.stl`
			] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			group.traverse((node) => {
				if (isMesh(node)) {
					node.geometry.dispose();
				}
			});
		}

		files['README.txt'] = strToU8(
			'Badge3D multicolor STL package\n\nImport every STL at the same time and keep their original coordinates.\nCombine them as parts of one object, then assign each part to the matching filament or extruder.\nThe hexadecimal color in each filename records the source badge color.\n',
		);
		const data = zipSync(files, {level: 6});
		downloadBlob(
			new Blob([data], {type: 'application/zip'}),
			`${exported.filenameStem}-color-stls.zip`,
		);
	};

	return (
		<main className="app-shell">
			<header className="workspace-header">
				<div className="wordmark">
					<img className="brand-logo" src="/badge3d.webp" alt="" />
					<h1>
						Badge<b>3D</b>
					</h1>
				</div>
				<p>Turn a Shields.io badge into a model you can print.</p>
				<div className="header-actions">
					<div className="theme-switcher" role="group" aria-label="Color theme">
						<button
							type="button"
							className={colorTheme === 'system' ? 'selected' : ''}
							aria-pressed={colorTheme === 'system'}
							title="Follow system theme"
							onClick={() => {
								setColorTheme('system');
							}}
						>
							<Monitor aria-hidden="true" size={13} strokeWidth={1.75} />
							<span>System</span>
						</button>
						<button
							type="button"
							className={colorTheme === 'light' ? 'selected' : ''}
							aria-pressed={colorTheme === 'light'}
							title="Use light theme"
							onClick={() => {
								setColorTheme('light');
							}}
						>
							<Sun aria-hidden="true" size={13} strokeWidth={1.75} />
							<span>Light</span>
						</button>
						<button
							type="button"
							className={colorTheme === 'dark' ? 'selected' : ''}
							aria-pressed={colorTheme === 'dark'}
							title="Use dark theme"
							onClick={() => {
								setColorTheme('dark');
							}}
						>
							<Moon aria-hidden="true" size={13} strokeWidth={1.75} />
							<span>Dark</span>
						</button>
					</div>
					<a
						className="github-link"
						href="https://github.com/LitoMore/badge3d"
						target="_blank"
						rel="noreferrer"
						aria-label="View Badge3D on GitHub"
					>
						<svg
							aria-hidden="true"
							width="15"
							height="15"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
						</svg>
						<span>GITHUB</span>
					</a>
				</div>
			</header>

			<section className="workbench" aria-label="Badge model editor">
				<div className="input-panel panel">
					<div className="source-intro">
						<div className="panel-heading">
							<div>
								<small>Badge source</small>
								<h2>Choose your badge</h2>
							</div>
						</div>
						<p>Paste any secure Shields.io URL or start with an example.</p>
					</div>
					<div className="source-controls">
						<form onSubmit={convert}>
							<label htmlFor="badge-url">SHIELDS.IO URL</label>
							<div className="url-row">
								<input
									required
									id="badge-url"
									type="url"
									value={url}
									placeholder="https://img.shields.io/badge/..."
									onChange={(event) => {
										setUrl(event.target.value);
									}}
								/>
								<button
									className="primary-button"
									type="submit"
									disabled={loading}
								>
									<span>{loading ? 'BUILDING…' : 'BUILD MODEL'}</span>
									<ArrowRight aria-hidden="true" size={14} strokeWidth={1.75} />
								</button>
							</div>
						</form>
						<div className="source-actions">
							<div className="examples">
								<span>EXAMPLES</span>
								{EXAMPLES.map(([label, exampleUrl]) => (
									<button
										key={label}
										type="button"
										className={url === exampleUrl ? 'selected' : ''}
										onClick={() => {
											setUrl(exampleUrl);
											void loadBadge(exampleUrl);
										}}
									>
										{label}
									</button>
								))}
							</div>
							<div className="share-link-row">
								<button
									type="button"
									disabled={url.trim().length === 0}
									aria-describedby={
										shareMessage.length > 0 ? 'share-feedback' : undefined
									}
									onMouseDown={(event) => {
										// Keep the source focused: blurring it can clear Safari's
										// user activation before the click reaches the clipboard.
										if (
											event.button === 0 &&
											globalThis.document.activeElement?.id === 'badge-url'
										) {
											event.preventDefault();
										}
									}}
									onClick={() => {
										void copyShareableLink();
									}}
								>
									{shareMessage === 'Link copied!' ? (
										<Check aria-hidden="true" size={12} strokeWidth={1.75} />
									) : shareMessage.length > 0 ? (
										<TriangleAlert
											aria-hidden="true"
											size={12}
											strokeWidth={1.75}
										/>
									) : (
										<Link aria-hidden="true" size={12} strokeWidth={1.75} />
									)}
									Copy shareable link
								</button>
								{shareMessage !== 'Link copied!' && shareMessage.length > 0 ? (
									<div className="share-tooltip" role="tooltip">
										{shareMessage}
									</div>
								) : null}
							</div>
						</div>
						<div id="share-feedback" className="share-feedback" role="status">
							{shareMessage}
						</div>
					</div>
				</div>

				<div className="preview-panel panel">
					<div className="panel-heading preview-heading">
						<div>
							<small>Interactive viewport</small>
							<h2>Inspect the model</h2>
						</div>
						<span
							className={
								loadError.length > 0
									? 'model-status error'
									: 'model-status ready-dot'
							}
						>
							{status}
						</span>
					</div>
					<div className="preview-stage">
						{svg.length > 0 ? (
							<BadgePreview
								svg={svg}
								params={parameters}
								isAutoRotating={isAutoRotating}
								resetToken={resetToken}
								onBuilding={onModelBuilding}
								onReady={onModelReady}
								onError={onPreviewError}
							/>
						) : loading ? (
							<div className="preview-loading">PREPARING MODEL…</div>
						) : (
							<div className="preview-loading preview-error">
								<b>MODEL COULD NOT BE BUILT</b>
								<span>
									{loadError.length > 0
										? loadError
										: 'Try another Shields.io URL.'}
								</span>
							</div>
						)}
						<div className="view-tools">
							<button
								type="button"
								className={isAutoRotating ? 'selected' : ''}
								aria-pressed={isAutoRotating}
								onClick={() => {
									setIsAutoRotating((value) => !value);
								}}
							>
								<Rotate3d aria-hidden="true" />
								<span>Auto rotate</span>
							</button>
							<button
								type="button"
								onClick={() => {
									setResetToken((value) => value + 1);
								}}
							>
								<Focus aria-hidden="true" />
								<span>Reset view</span>
							</button>
						</div>
						<div className="canvas-hint">
							DRAG TO ROTATE · SPACE + DRAG TO PAN · SCROLL TO ZOOM
						</div>
					</div>
					<div className="model-stats">
						<span>
							<small>SIZE</small>
							<b>
								{stats.width.toFixed(0)} × {stats.height.toFixed(1)} ×{' '}
								{stats.depth.toFixed(1)} mm
							</b>
						</span>
						<span>
							<small>MESH</small>
							<b>{stats.triangles.toLocaleString()} △</b>
						</span>
						<span>
							<small>STATUS</small>
							<b className="watertight">● PRINTABLE</b>
						</span>
					</div>
				</div>

				<div className="settings-panel panel">
					<div className="panel-heading">
						<div>
							<small>Print dimensions</small>
							<h2>Tune the model</h2>
						</div>
						<button
							className="settings-reset"
							type="button"
							onClick={resetParameters}
						>
							<RotateCcw aria-hidden="true" size={12} strokeWidth={1.75} />
							<span>RESET</span>
						</button>
					</div>
					<div className="settings-controls">
						<RangeControl
							label="Model height"
							value={parameters.height}
							min={8}
							max={30}
							step={0.1}
							unit="mm"
							onChange={(v) => {
								updateParameter('height', v);
							}}
						/>
						<RangeControl
							label="Base thickness"
							value={parameters.baseHeight}
							min={1.2}
							max={5}
							step={0.1}
							unit="mm"
							onChange={(v) => {
								updateParameter('baseHeight', v);
							}}
						/>
						<RangeControl
							label="Letter relief"
							value={parameters.relief}
							min={0.3}
							max={2}
							step={0.1}
							unit="mm"
							onChange={(v) => {
								updateParameter('relief', v);
							}}
						/>
					</div>
					<div className="print-note">
						<span aria-hidden="true">i</span>
						<p>
							<b>PRINT TIP</b>0.2 mm layers · 15% infill · no supports
						</p>
					</div>
				</div>

				<div className="export-panel panel">
					<div className="panel-heading">
						<div>
							<small>Ready for your slicer</small>
							<h2>Export the model</h2>
						</div>
					</div>
					<div className="export-actions">
						<button
							className="download-button"
							type="button"
							disabled={!modelReady || loading || exporting3mf}
							aria-busy={exporting3mf}
							onClick={() => {
								void download3mf();
							}}
						>
							<span>↓</span>
							<b>{exporting3mf ? 'EXPORTING 3MF…' : 'DOWNLOAD 3MF'}</b>
							<small>MULTICOLOR PARTS + FILAMENT COLORS</small>
						</button>
						<div className="export-secondary">
							<button
								type="button"
								disabled={!modelReady || loading}
								onClick={downloadStl}
							>
								<b>SINGLE-COLOR STL</b>
								<small>UNIVERSAL COMPATIBILITY</small>
							</button>
							<button
								type="button"
								disabled={!modelReady || loading}
								onClick={downloadColorStls}
							>
								<b>COLOR STL ZIP</b>
								<small>SEPARATE ALIGNED PARTS</small>
							</button>
						</div>
					</div>
					{exportError.length > 0 ? <p role="alert">{exportError}</p> : null}
					<p className="export-note">
						3MF includes filament colors for Bambu Studio. Review printer and
						filament settings before slicing.
					</p>
				</div>
			</section>

			<footer className="author-footer">
				<span>
					Crafted and maintained with{' '}
					<span className="footer-heart" aria-label="love">
						♥
					</span>{' '}
					by{' '}
					<a
						href="https://github.com/LitoMore"
						target="_blank"
						rel="noreferrer"
					>
						LitoMore
					</a>
					, a member of the{' '}
					<a href="https://shields.io" target="_blank" rel="noreferrer">
						Shields.io
					</a>{' '}
					team.
				</span>{' '}
				<span>
					Like badges? Check out another fun project -{' '}
					<a href="https://beads.shields.io" target="_blank" rel="noreferrer">
						Badge Beadgrid
					</a>
					. {'\u{B7}'} 3MF export powered by{' '}
					<a
						href="https://github.com/LittleSound/bekuto3d/tree/main/packages/three-3mf-exporter"
						target="_blank"
						rel="noreferrer"
					>
						three-3mf-exporter
					</a>
					.
				</span>
			</footer>
		</main>
	);
}
