import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {
	type ModelParameters,
	type ModelStats,
	type BadgeFonts,
	buildModel,
	createSvgTexture,
	isMesh,
	loadBadgeFonts,
	roundedPlateGeometry,
	svgMetrics,
} from './badge-model.js';

type PreviewProps = {
	readonly svg: string;
	readonly params: ModelParameters;
	readonly isAutoRotating: boolean;
	readonly resetToken: number;
	readonly onBuilding: () => void;
	readonly onReady: (group: THREE.Group, stats: ModelStats) => void;
	readonly onError: (message: string) => void;
};

type PreviewView = {
	position: THREE.Vector3;
	target: THREE.Vector3;
	zoom: number;
};

type PreviewResetAnimation = {
	startedAt: number;
	duration: number;
	progress: number;
	fromTarget: THREE.Vector3;
	toTarget: THREE.Vector3;
	fromOrbit: THREE.Spherical;
	currentOrbit: THREE.Spherical;
	toOrbit: THREE.Spherical;
	fromZoom: number;
	toZoom: number;
};

function fitPreviewCamera(
	camera: THREE.PerspectiveCamera,
	controls: OrbitControls,
	model: THREE.Object3D,
) {
	model.updateMatrixWorld(true);
	const bounds = new THREE.Box3().setFromObject(model);
	if (bounds.isEmpty()) {
		return;
	}

	const sphere = bounds.getBoundingSphere(new THREE.Sphere());
	const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
	const horizontalHalfFov = Math.atan(
		Math.tan(verticalHalfFov) * camera.aspect,
	);
	const viewDirection = new THREE.Vector3(0, -1, Math.sqrt(3)).normalize();
	const forward = viewDirection.clone().negate();
	const right = new THREE.Vector3()
		.crossVectors(forward, camera.up)
		.normalize();
	const viewUp = new THREE.Vector3().crossVectors(right, forward).normalize();
	const offset = new THREE.Vector3();
	let requiredDistance = 0;

	for (const x of [bounds.min.x, bounds.max.x]) {
		for (const y of [bounds.min.y, bounds.max.y]) {
			for (const z of [bounds.min.z, bounds.max.z]) {
				offset.set(x, y, z).sub(sphere.center);
				const depthOffset = offset.dot(viewDirection);
				const horizontalDistance =
					Math.abs(offset.dot(right)) /
					Math.max(Math.tan(horizontalHalfFov), 0.01);
				const verticalDistance =
					Math.abs(offset.dot(viewUp)) /
					Math.max(Math.tan(verticalHalfFov), 0.01);
				requiredDistance = Math.max(
					requiredDistance,
					depthOffset + horizontalDistance,
					depthOffset + verticalDistance,
				);
			}
		}
	}

	const distance = requiredDistance * 1.18;

	camera.zoom = 1;
	camera.position.copy(sphere.center).addScaledVector(viewDirection, distance);
	camera.near = Math.max(0.1, distance - sphere.radius * 2);
	camera.far = distance + sphere.radius * 8;
	camera.updateProjectionMatrix();
	controls.target.copy(sphere.center);
	controls.minDistance = Math.max(6, sphere.radius * 0.65);
	controls.maxDistance = Math.max(150, distance * 4);
	controls.update();
	controls.saveState();

	return {
		position: camera.position.clone(),
		target: controls.target.clone(),
		zoom: camera.zoom,
	};
}

export function BadgePreview({
	svg,
	params,
	isAutoRotating,
	resetToken,
	onBuilding,
	onReady,
	onError,
}: PreviewProps) {
	const hostRef = useRef<HTMLDivElement & {scene?: THREE.Scene}>(null);
	const rootRef = useRef<THREE.Group | undefined>(null);
	const cameraRef = useRef<THREE.PerspectiveCamera | undefined>(null);
	const controlsRef = useRef<OrbitControls | undefined>(null);
	const homeViewRef = useRef<PreviewView | undefined>(null);
	const resetAnimationRef = useRef<PreviewResetAnimation | undefined>(null);
	const [loadedFonts, setLoadedFonts] = useState<{
		svg: string;
		fonts: BadgeFonts;
	}>();

	useEffect(() => {
		let isActive = true;
		onBuilding();
		loadBadgeFonts(svg)
			.then((fonts) => {
				if (isActive) {
					setLoadedFonts({svg, fonts});
				}
			})
			.catch(() => {
				if (isActive) {
					onError('Unable to load the outline font. Please try again.');
				}
			});
		return () => {
			isActive = false;
		};
	}, [svg, onBuilding, onError]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
		camera.position.set(0, -56, 54);
		cameraRef.current = camera;
		const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.shadowMap.enabled = true;
		host.append(renderer.domElement);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.enablePan = false;
		controls.minDistance = 28;
		controls.maxDistance = 150;
		controls.target.set(0, 0, 0);
		controlsRef.current = controls;

		const canvas = renderer.domElement;
		const defaultLeftMouseButton = controls.mouseButtons.LEFT;
		let isPointerInside = false;
		canvas.tabIndex = 0;
		canvas.setAttribute(
			'aria-label',
			'Interactive 3D model. Drag to rotate, hold Space and drag to pan, and scroll to zoom.',
		);

		const setSpacePanning = (isActive: boolean) => {
			controls.enablePan = isActive;
			controls.mouseButtons.LEFT = isActive
				? THREE.MOUSE.PAN
				: defaultLeftMouseButton;
			canvas.classList.toggle('space-panning', isActive);
		};

		const handlePointerEnter = () => {
			isPointerInside = true;
		};

		const handlePointerLeave = () => {
			isPointerInside = false;
		};

		const cancelViewReset = () => {
			if (!resetAnimationRef.current) {
				return;
			}

			resetAnimationRef.current = null;
			controls.enabled = true;
		};

		const handlePointerDown = () => {
			canvas.focus({preventScroll: true});
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			const {target} = event;
			const isTyping =
				target instanceof HTMLElement &&
				(target.matches('input, textarea, select, button') ||
					target.isContentEditable);
			if (
				isTyping ||
				event.code !== 'Space' ||
				(!isPointerInside && document.activeElement !== canvas)
			) {
				return;
			}

			event.preventDefault();
			setSpacePanning(true);
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code === 'Space') {
				setSpacePanning(false);
			}
		};

		const handleWindowBlur = () => {
			setSpacePanning(false);
		};

		canvas.addEventListener('pointerenter', handlePointerEnter);
		canvas.addEventListener('pointerleave', handlePointerLeave);
		canvas.addEventListener('pointerdown', cancelViewReset, {capture: true});
		canvas.addEventListener('wheel', cancelViewReset, {capture: true});
		canvas.addEventListener('pointerdown', handlePointerDown);
		globalThis.addEventListener('keydown', handleKeyDown);
		globalThis.addEventListener('keyup', handleKeyUp);
		window.addEventListener('blur', handleWindowBlur);

		scene.add(new THREE.HemisphereLight(0xff_f4_dd, 0x14_16_18, 2.15));
		const key = new THREE.DirectionalLight(0xff_ff_ff, 3.8);
		key.position.set(-25, -20, 52);
		key.castShadow = true;
		scene.add(key);
		const rim = new THREE.DirectionalLight(0xff_9f_43, 2.4);
		rim.position.set(35, 15, 25);
		scene.add(rim);

		const grid = new THREE.GridHelper(120, 24, 0x5f_55_41, 0x35_34_30);
		grid.rotation.x = Math.PI / 2;
		grid.position.z = -0.15;
		scene.add(grid);

		const resize = () => {
			const width = host.clientWidth;
			const height = host.clientHeight;
			if (width === 0 || height === 0) {
				return;
			}

			renderer.setSize(width, height, false);
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
			if (!rootRef.current) {
				return;
			}

			cancelViewReset();
			homeViewRef.current =
				fitPreviewCamera(camera, controls, rootRef.current) ?? null;
		};

		const observer = new ResizeObserver(resize);
		observer.observe(host);
		resize();

		let frame = 0;
		const resetOffset = new THREE.Vector3();
		const resetOrbit = new THREE.Spherical();
		const animate = (time: number) => {
			frame = requestAnimationFrame(animate);
			const resetAnimation = resetAnimationRef.current;
			if (resetAnimation) {
				// Preserve OrbitControls' exponential damping response, then smoothly
				// compress its remaining distance to zero over a finite duration.
				const resetDampingSpeed = 1.6;
				const elapsedProgress = THREE.MathUtils.clamp(
					(time - resetAnimation.startedAt) / resetAnimation.duration,
					0,
					1,
				);
				const elapsedSeconds =
					(elapsedProgress * resetAnimation.duration) / 1000;
				const dampingRemaining =
					(1 - THREE.MathUtils.clamp(controls.dampingFactor, 0.01, 0.99)) **
					(elapsedSeconds * 60 * resetDampingSpeed);
				const settlingWindow = THREE.MathUtils.smootherstep(
					elapsedProgress,
					0,
					1,
				);
				resetAnimation.progress = 1 - dampingRemaining * (1 - settlingWindow);
				resetAnimation.currentOrbit.radius = Math.exp(
					THREE.MathUtils.lerp(
						Math.log(resetAnimation.fromOrbit.radius),
						Math.log(resetAnimation.toOrbit.radius),
						resetAnimation.progress,
					),
				);
				resetAnimation.currentOrbit.phi = THREE.MathUtils.lerp(
					resetAnimation.fromOrbit.phi,
					resetAnimation.toOrbit.phi,
					resetAnimation.progress,
				);
				resetAnimation.currentOrbit.theta = THREE.MathUtils.lerp(
					resetAnimation.fromOrbit.theta,
					resetAnimation.toOrbit.theta,
					resetAnimation.progress,
				);
				resetOrbit.copy(resetAnimation.currentOrbit);
				controls.target.lerpVectors(
					resetAnimation.fromTarget,
					resetAnimation.toTarget,
					resetAnimation.progress,
				);
				camera.position
					.copy(resetOffset.setFromSpherical(resetOrbit))
					.add(controls.target);
				camera.zoom = THREE.MathUtils.lerp(
					resetAnimation.fromZoom,
					resetAnimation.toZoom,
					resetAnimation.progress,
				);
				camera.updateProjectionMatrix();
				camera.lookAt(controls.target);

				if (resetAnimation.progress >= 1) {
					controls.target.copy(resetAnimation.toTarget);
					camera.position
						.copy(resetOffset.setFromSpherical(resetAnimation.toOrbit))
						.add(controls.target);
					camera.zoom = resetAnimation.toZoom;
					camera.updateProjectionMatrix();
					camera.lookAt(controls.target);
					resetAnimationRef.current = null;
					controls.enabled = true;
				}
			} else {
				controls.update();
			}

			renderer.render(scene, camera);
		};

		frame = requestAnimationFrame(animate);

		host.scene = scene;

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			controls.dispose();
			canvas.removeEventListener('pointerenter', handlePointerEnter);
			canvas.removeEventListener('pointerleave', handlePointerLeave);
			canvas.removeEventListener('pointerdown', cancelViewReset, {
				capture: true,
			});
			canvas.removeEventListener('wheel', cancelViewReset, {capture: true});
			canvas.removeEventListener('pointerdown', handlePointerDown);
			globalThis.removeEventListener('keydown', handleKeyDown);
			globalThis.removeEventListener('keyup', handleKeyUp);
			window.removeEventListener('blur', handleWindowBlur);
			resetAnimationRef.current = null;
			homeViewRef.current = null;
			cameraRef.current = null;
			controlsRef.current = null;
			renderer.dispose();
			renderer.domElement.remove();
		};
	}, []);

	useEffect(() => {
		const host = hostRef.current;
		const scene = host?.scene;
		if (!scene || loadedFonts?.svg !== svg) {
			return;
		}

		if (rootRef.current) {
			scene.remove(rootRef.current);
			rootRef.current.traverse((item) => {
				if (!isMesh(item)) {
					return;
				}

				item.geometry.dispose();
				const materials = Array.isArray(item.material)
					? item.material
					: [item.material];
				for (const material of materials) {
					material.dispose();
				}
			});
		}

		let model: ReturnType<typeof buildModel>;
		try {
			model = buildModel(svg, params, loadedFonts.fonts);
		} catch (error) {
			onError(
				error instanceof Error ? error.message : 'Unable to build the model.',
			);
			return;
		}

		const {group, stats} = model;
		group.rotation.x = -0.16;
		rootRef.current = group;
		scene.add(group);
		if (cameraRef.current && controlsRef.current) {
			resetAnimationRef.current = null;
			controlsRef.current.enabled = true;
			homeViewRef.current =
				fitPreviewCamera(cameraRef.current, controlsRef.current, group) ?? null;
		}

		onReady(group, stats);

		let isActive = true;
		// Social bases already reproduce the SVG silhouette and solid colors.
		// A rectangular preview overlay would cover the gap and the bubble pointer.
		if (!svgMetrics(svg).social) {
			createSvgTexture(svg)
				.then((texture) => {
					if (!isActive || rootRef.current !== group) {
						texture.dispose();
						return;
					}

					const plate = new THREE.Mesh(
						roundedPlateGeometry(stats.width, stats.height, params.radius),
						new THREE.MeshBasicMaterial({
							map: texture,
							transparent: false,
							depthWrite: false,
							polygonOffset: true,
							polygonOffsetFactor: -2,
						}),
					);
					plate.name = 'Color preview';
					plate.position.z = params.baseHeight + 0.012;
					plate.userData.previewOnly = true;
					group.add(plate);
				})
				.catch(() => undefined);
		}

		return () => {
			isActive = false;
		};
	}, [svg, params, loadedFonts, onReady, onError]);

	useEffect(() => {
		if (rootRef.current) {
			rootRef.current.userData.autoRotate = isAutoRotating;
		}

		if (controlsRef.current) {
			controlsRef.current.autoRotate = isAutoRotating;
		}
	}, [isAutoRotating]);

	useEffect(() => {
		const camera = cameraRef.current;
		const controls = controlsRef.current;
		const homeView = homeViewRef.current;
		if (!camera || !controls || !homeView) {
			return;
		}

		const currentView = {
			position: camera.position.clone(),
			target: controls.target.clone(),
			zoom: camera.zoom,
		};
		const isDampingEnabled = controls.enableDamping;
		const isAutoRotateEnabled = controls.autoRotate;
		controls.enableDamping = false;
		controls.autoRotate = false;
		controls.update();
		controls.enableDamping = isDampingEnabled;
		controls.autoRotate = isAutoRotateEnabled;
		camera.position.copy(currentView.position);
		controls.target.copy(currentView.target);
		camera.zoom = currentView.zoom;
		camera.updateProjectionMatrix();
		camera.lookAt(controls.target);

		const isReduceMotion = globalThis.matchMedia(
			'(prefers-reduced-motion: reduce)',
		).matches;
		if (isReduceMotion) {
			resetAnimationRef.current = null;
			camera.position.copy(homeView.position);
			controls.target.copy(homeView.target);
			camera.zoom = homeView.zoom;
			camera.updateProjectionMatrix();
			controls.enabled = true;
			camera.lookAt(controls.target);
			return;
		}

		const fromOrbit = new THREE.Spherical().setFromVector3(
			currentView.position.clone().sub(currentView.target),
		);
		const toOrbit = new THREE.Spherical().setFromVector3(
			homeView.position.clone().sub(homeView.target),
		);
		const thetaDelta =
			THREE.MathUtils.euclideanModulo(
				toOrbit.theta - fromOrbit.theta + Math.PI,
				Math.PI * 2,
			) - Math.PI;
		toOrbit.theta = fromOrbit.theta + thetaDelta;
		const startedAt = performance.now();

		resetAnimationRef.current = {
			startedAt,
			duration: 850,
			progress: 0,
			fromTarget: currentView.target.clone(),
			toTarget: homeView.target.clone(),
			fromOrbit: fromOrbit.clone(),
			currentOrbit: fromOrbit,
			toOrbit,
			fromZoom: currentView.zoom,
			toZoom: homeView.zoom,
		};
		controls.enabled = false;
	}, [resetToken]);

	return (
		<div
			ref={hostRef}
			className="preview-canvas"
			aria-label="Interactive 3D badge preview"
		/>
	);
}
