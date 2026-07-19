import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Monitor,
  Moon,
  RotateCcw,
  Sun,
} from "lucide-react";
import * as THREE from "three";
import * as opentype from "opentype.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { strToU8, zipSync } from "fflate";
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";

const DEFAULT_BADGE = "https://img.shields.io/badge/build-passing-34d058";
const EXAMPLES = [
  ["BUILD", DEFAULT_BADGE],
  ["COVERAGE", "https://img.shields.io/badge/coverage-96%25-7c3aed"],
  ["VERSION", "https://img.shields.io/badge/version-v2.4.1-2563eb"],
] as const;
const DEFAULT_MODEL_HEIGHT = 15;
const DEFAULT_BASE_HEIGHT = 1.5;
const DEFAULT_RELIEF = 1;
const DEFAULT_BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="20" role="img" aria-label="build: passing"><title>build: passing</title><filter id="blur"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="88" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="37" height="20" fill="#555"/><rect x="37" width="51" height="20" fill="#34d058"/><rect width="88" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="195" y="150" fill-opacity=".8" filter="url(#blur)" textLength="270">build</text><text x="195" y="150" fill-opacity=".3" textLength="270">build</text></g><text x="195" y="140" textLength="270">build</text></g><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="615" y="150" fill-opacity=".8" filter="url(#blur)" textLength="410">passing</text><text x="615" y="150" fill-opacity=".3" textLength="410">passing</text></g><text x="615" y="140" textLength="410">passing</text></g></g></svg>`;

type ModelParams = {
  height: number;
  baseHeight: number;
  relief: number;
  radius: number;
};

type AdjustableModelParam = Exclude<keyof ModelParams, "radius">;

type ColorTheme = "system" | "light" | "dark";

type ModelStats = {
  width: number;
  height: number;
  depth: number;
  triangles: number;
};

type PreviewProps = {
  svg: string;
  params: ModelParams;
  autoRotate: boolean;
  resetToken: number;
  onReady: (group: THREE.Group, stats: ModelStats) => void;
};

type PreviewView = {
  position: THREE.Vector3;
  target: THREE.Vector3;
  zoom: number;
};

type PreviewResetAnimation = {
  startedAt: number;
  duration: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromOrbit: THREE.Spherical;
  toOrbit: THREE.Spherical;
  thetaDelta: number;
  fromZoom: number;
  toZoom: number;
};

type PrintablePart = {
  color: string;
  meshes: THREE.Mesh[];
};

let badgeFontPromise: Promise<opentype.Font> | undefined;

function loadBadgeFont() {
  badgeFontPromise ??= fetch(fontUrl)
    .then((response) => {
      if (!response.ok) throw new Error("Unable to load the outline font.");
      return response.arrayBuffer();
    })
    .then((buffer) => opentype.parse(buffer));
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

function roundedPlateGeometry(width: number, height: number, radius: number) {
  const geometry = new THREE.ShapeGeometry(
    roundedRect(width, height, radius),
    12,
  );
  const positions = geometry.getAttribute("position");
  const uv = new Float32Array(positions.count * 2);
  for (let index = 0; index < positions.count; index += 1) {
    uv[index * 2] = (positions.getX(index) + width / 2) / width;
    uv[index * 2 + 1] = (positions.getY(index) + height / 2) / height;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

function segmentShape(
  xMin: number,
  xMax: number,
  height: number,
  radius: number,
  roundLeft: boolean,
  roundRight: boolean,
) {
  const bottom = -height / 2;
  const top = height / 2;
  const r = Math.min(radius, height / 2, (xMax - xMin) / 2);
  const leftRadius = roundLeft ? r : 0;
  const rightRadius = roundRight ? r : 0;
  const shape = new THREE.Shape();
  shape.moveTo(xMin + leftRadius, bottom);
  shape.lineTo(xMax - rightRadius, bottom);
  if (rightRadius)
    shape.quadraticCurveTo(xMax, bottom, xMax, bottom + rightRadius);
  else shape.lineTo(xMax, bottom);
  shape.lineTo(xMax, top - rightRadius);
  if (rightRadius) shape.quadraticCurveTo(xMax, top, xMax - rightRadius, top);
  else shape.lineTo(xMax, top);
  shape.lineTo(xMin + leftRadius, top);
  if (leftRadius) shape.quadraticCurveTo(xMin, top, xMin, top - leftRadius);
  else shape.lineTo(xMin, top);
  shape.lineTo(xMin, bottom + leftRadius);
  if (leftRadius)
    shape.quadraticCurveTo(xMin, bottom, xMin + leftRadius, bottom);
  else shape.lineTo(xMin, bottom);
  return shape;
}

function svgMetrics(svg: string) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const viewBox = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const width =
    viewBox?.[2] || Number.parseFloat(root.getAttribute("width") || "100");
  const height =
    viewBox?.[3] || Number.parseFloat(root.getAttribute("height") || "20");
  return { doc, width, height };
}

function imageHref(node: Element) {
  return (
    node.getAttribute("href") ||
    node.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
    ""
  );
}

function decodeSvgDataUri(source: string) {
  const comma = source.indexOf(",");
  if (comma < 0) return null;
  const metadata = source.slice(5, comma).toLowerCase();
  if (
    !source.toLowerCase().startsWith("data:") ||
    !metadata.startsWith("image/svg+xml")
  )
    return null;

  try {
    const payload = source.slice(comma + 1);
    if (metadata.split(";").includes("base64")) {
      const binary = window.atob(payload);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function embeddedSvgImage(node: Element) {
  const source = decodeSvgDataUri(imageHref(node));
  if (!source) return null;

  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "svg"
  )
    return null;
  const root = doc.documentElement;
  const viewBox = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const minX = viewBox?.[0] || 0;
  const minY = viewBox?.[1] || 0;
  const viewWidth =
    viewBox?.[2] || Number.parseFloat(root.getAttribute("width") || "0");
  const viewHeight =
    viewBox?.[3] || Number.parseFloat(root.getAttribute("height") || "0");
  const x = Number.parseFloat(node.getAttribute("x") || "0");
  const y = Number.parseFloat(node.getAttribute("y") || "0");
  const width = Number.parseFloat(node.getAttribute("width") || "0");
  const height = Number.parseFloat(node.getAttribute("height") || "0");
  if (
    ![viewWidth, viewHeight, width, height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;

  const preserveAspectRatio =
    node.getAttribute("preserveAspectRatio") || "xMidYMid meet";
  let scaleX = width / viewWidth;
  let scaleY = height / viewHeight;
  let offsetX = 0;
  let offsetY = 0;
  if (!preserveAspectRatio.startsWith("none")) {
    const scale = preserveAspectRatio.includes("slice")
      ? Math.max(scaleX, scaleY)
      : Math.min(scaleX, scaleY);
    const renderedWidth = viewWidth * scale;
    const renderedHeight = viewHeight * scale;
    offsetX = preserveAspectRatio.includes("xMin")
      ? 0
      : preserveAspectRatio.includes("xMax")
        ? width - renderedWidth
        : (width - renderedWidth) / 2;
    offsetY = preserveAspectRatio.includes("YMin")
      ? 0
      : preserveAspectRatio.includes("YMax")
        ? height - renderedHeight
        : (height - renderedHeight) / 2;
    scaleX = scale;
    scaleY = scale;
  }

  return {
    doc,
    minX,
    minY,
    viewWidth,
    viewHeight,
    x,
    y,
    scaleX,
    scaleY,
    offsetX,
    offsetY,
    renderedHeight: viewHeight * scaleY,
  };
}

function cumulativeScale(node: Element) {
  let scale = 1;
  let current: Element | null = node;
  while (current) {
    const transform = current.getAttribute("transform") || "";
    const match = transform.match(/scale\(\s*([\d.]+)/);
    if (match) scale *= Number.parseFloat(match[1]);
    current = current.parentElement;
  }
  return scale;
}

function inheritedTextFill(node: Element) {
  let current: Element | null = node;
  while (current) {
    const directFill = current.getAttribute("fill");
    const styleFill = current
      .getAttribute("style")
      ?.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1];
    const fill = directFill || styleFill;
    if (fill && fill !== "none" && !fill.startsWith("url(")) return fill.trim();
    current = current.parentElement;
  }
  return "#fff";
}

function svgColor(fill: string, fallback = 0x34363a) {
  const color = new THREE.Color(fallback);
  if (
    /^(?:#[\da-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|[a-z]+)$/i.test(fill) &&
    fill !== "currentColor"
  ) {
    color.setStyle(fill);
  }
  return color;
}

function badgeSegments(doc: Document, svgWidth: number, svgHeight: number) {
  return Array.from(doc.querySelectorAll("svg > g > rect[fill]"))
    .map((node) => ({
      x: Number.parseFloat(node.getAttribute("x") || "0"),
      y: Number.parseFloat(node.getAttribute("y") || "0"),
      width: Number.parseFloat(node.getAttribute("width") || "0"),
      height: Number.parseFloat(
        node.getAttribute("height") || String(svgHeight),
      ),
      fill: node.getAttribute("fill") || "",
    }))
    .filter(
      (segment) =>
        segment.width > 0 &&
        segment.height >= svgHeight * 0.95 &&
        segment.y <= svgHeight * 0.05 &&
        !segment.fill.startsWith("url(") &&
        segment.fill !== "none",
    )
    .map((segment) => ({
      ...segment,
      x: Math.max(0, segment.x),
      width: Math.min(segment.width, svgWidth - Math.max(0, segment.x)),
    }))
    .filter((segment) => segment.width > 0)
    .sort((left, right) => left.x - right.x);
}

function getTextOutline(font: opentype.Font, text: string, fontSize: number) {
  const outline = new opentype.Path();
  const characters = Array.from(text);
  const unitScale = fontSize / font.unitsPerEm;
  let cursor = 0;

  characters.forEach((character, index) => {
    const glyph = font.charToGlyph(character);
    glyph.path.commands.forEach((command) => {
      if (command.type === "M")
        outline.moveTo(cursor + command.x * unitScale, command.y * unitScale);
      if (command.type === "L")
        outline.lineTo(cursor + command.x * unitScale, command.y * unitScale);
      if (command.type === "Q") {
        outline.quadraticCurveTo(
          cursor + command.x1 * unitScale,
          command.y1 * unitScale,
          cursor + command.x * unitScale,
          command.y * unitScale,
        );
      }
      if (command.type === "C") {
        outline.bezierCurveTo(
          cursor + command.x1 * unitScale,
          command.y1 * unitScale,
          cursor + command.x2 * unitScale,
          command.y2 * unitScale,
          cursor + command.x * unitScale,
          command.y * unitScale,
        );
      }
      if (command.type === "Z") outline.closePath();
    });

    const nextGlyph = characters[index + 1]
      ? font.charToGlyph(characters[index + 1])
      : null;
    cursor += (glyph.advanceWidth || font.unitsPerEm) * unitScale;
    if (nextGlyph) cursor += font.getKerningValue(glyph, nextGlyph) * unitScale;
  });

  return outline;
}

function buildModel(svg: string, params: ModelParams, font: opentype.Font) {
  const { doc, width: svgWidth, height: svgHeight } = svgMetrics(svg);
  const mmPerUnit = params.height / svgHeight;
  const width = svgWidth * mmPerUnit;
  const height = params.height;
  const group = new THREE.Group();
  group.name = "Printable badge";

  const segments = badgeSegments(doc, svgWidth, svgHeight);
  if (segments.length) {
    segments.forEach((segment, index) => {
      const xMin = segment.x * mmPerUnit - width / 2;
      const xMax = (segment.x + segment.width) * mmPerUnit - width / 2;
      const color = svgColor(segment.fill);
      const geometry = new THREE.ExtrudeGeometry(
        segmentShape(
          xMin,
          xMax,
          height,
          params.radius,
          segment.x <= 0.001,
          segment.x + segment.width >= svgWidth - 0.001,
        ),
        { depth: params.baseHeight, bevelEnabled: false, curveSegments: 10 },
      );
      const mesh = new THREE.Mesh(geometry, [
        new THREE.MeshBasicMaterial({ color }),
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.58,
          metalness: 0.02,
        }),
      ]);
      mesh.name = `Badge color segment ${index + 1}: ${segment.fill}`;
      group.add(mesh);
    });
  } else {
    const baseGeometry = new THREE.ExtrudeGeometry(
      roundedRect(width, height, params.radius),
      { depth: params.baseHeight, bevelEnabled: false, curveSegments: 10 },
    );
    const base = new THREE.Mesh(
      baseGeometry,
      new THREE.MeshStandardMaterial({
        color: 0x34363a,
        roughness: 0.62,
        metalness: 0.05,
      }),
    );
    base.name = "Badge base";
    group.add(base);
  }

  const logoImages = Array.from(doc.querySelectorAll("image"))
    .map(embeddedSvgImage)
    .filter((image) => image !== null);
  logoImages.forEach((image, imageIndex) => {
    const embeddedRoot = new XMLSerializer().serializeToString(
      image.doc.documentElement,
    );
    const flipY = image.minY * 2 + image.viewHeight;
    const parsed = new SVGLoader().parse(
      `<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(0 ${flipY}) scale(1 -1)">${embeddedRoot}</g></svg>`,
    );
    const logoName =
      image.doc.querySelector("title")?.textContent?.trim() ||
      `Logo ${imageIndex + 1}`;

    parsed.paths.forEach((path, pathIndex) => {
      const shapes = path.toShapes();
      if (!shapes.length) return;
      const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth: params.relief,
        bevelEnabled: false,
        curveSegments: 9,
      });
      geometry.scale(image.scaleX * mmPerUnit, image.scaleY * mmPerUnit, 1);
      const color = path.color.clone();
      const mesh = new THREE.Mesh(geometry, [
        new THREE.MeshBasicMaterial({ color }),
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.46,
          metalness: 0,
        }),
      ]);
      mesh.name = `Raised logo: ${logoName}${parsed.paths.length > 1 ? ` (${pathIndex + 1})` : ""}`;
      mesh.position.set(
        (image.x + image.offsetX - image.minX * image.scaleX) * mmPerUnit -
          width / 2,
        height / 2 -
          (image.y +
            image.offsetY +
            image.renderedHeight +
            image.minY * image.scaleY) *
            mmPerUnit,
        params.baseHeight,
      );
      group.add(mesh);
    });
  });

  const visibleText = Array.from(doc.querySelectorAll("text")).filter(
    (node) => !node.closest('[aria-hidden="true"]'),
  );

  for (const node of visibleText) {
    const content = node.textContent?.trim();
    if (!content) continue;
    const scale = cumulativeScale(node);
    const x = Number.parseFloat(node.getAttribute("x") || "0") * scale;
    const y = Number.parseFloat(node.getAttribute("y") || "0") * scale;
    const textLength =
      Number.parseFloat(node.getAttribute("textLength") || "0") * scale;
    const fontSize =
      Number.parseFloat(
        node.getAttribute("font-size") ||
          node.closest("[font-size]")?.getAttribute("font-size") ||
          "11",
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
    if (!shapes.length) continue;
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: params.relief,
      bevelEnabled: false,
      curveSegments: 7,
    });
    geometry.scale(horizontalScale * mmPerUnit, mmPerUnit, 1);
    geometry.computeBoundingBox();
    const geometryBounds = geometry.boundingBox;
    if (!geometryBounds) continue;
    const geometryWidth = geometryBounds.max.x - geometryBounds.min.x;
    const textColor = svgColor(inheritedTextFill(node), 0xffffff);
    const capMaterial = new THREE.MeshBasicMaterial({ color: textColor });
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: textColor,
      roughness: 0.46,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geometry, [capMaterial, sideMaterial]);
    mesh.name = `Raised text: ${content}`;
    mesh.position.set(
      x * mmPerUnit - width / 2 - geometryWidth / 2 - geometryBounds.min.x,
      height / 2 - y * mmPerUnit,
      params.baseHeight,
    );
    group.add(mesh);
  }

  let triangles = 0;
  group.traverse((item) => {
    if (item instanceof THREE.Mesh) {
      const geometry = item.geometry;
      triangles += geometry.index
        ? geometry.index.count / 3
        : geometry.attributes.position.count / 3;
    }
  });

  return {
    group,
    stats: {
      width,
      height,
      depth: params.baseHeight + params.relief,
      triangles: Math.round(triangles),
    },
  };
}

function createSvgTexture(svg: string) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    doc.querySelectorAll("image").forEach((node) => {
      if (decodeSvgDataUri(imageHref(node))) node.remove();
    });
    doc
      .querySelectorAll('text, [aria-hidden="true"], [fill^="url("]')
      .forEach((node) => node.remove());
    doc
      .querySelectorAll("[clip-path]")
      .forEach((node) => node.removeAttribute("clip-path"));
    doc
      .querySelectorAll("filter, linearGradient, clipPath")
      .forEach((node) => node.remove());
    const flatSvg = new XMLSerializer().serializeToString(doc.documentElement);
    const blob = new Blob([flatSvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.src = "";
      URL.revokeObjectURL(url);
      reject(new Error("Badge artwork took too long to decode"));
    }, 5000);
    image.onload = () => {
      window.clearTimeout(timeout);
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
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      reject(new Error("Unable to render badge texture"));
    };
    image.src = url;
  });
}

function printableModel(model: THREE.Group) {
  const printable = model.clone(true);
  const previewNodes: THREE.Object3D[] = [];
  printable.traverse((node) => {
    if (node.userData.previewOnly) previewNodes.push(node);
  });
  previewNodes.forEach((node) => node.parent?.remove(node));
  printable.rotation.set(0, 0, 0);
  printable.updateMatrixWorld(true);
  return printable;
}

function meshColor(mesh: THREE.Mesh) {
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  const material = materials.find((candidate) => "color" in candidate) as
    | (THREE.Material & {
        color?: THREE.Color;
      })
    | undefined;
  return `#${material?.color?.getHexString(THREE.SRGBColorSpace) || "808080"}`.toUpperCase();
}

function printableParts(printable: THREE.Group) {
  const byColor = new Map<string, THREE.Mesh[]>();
  printable.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const color = meshColor(node);
    const meshes = byColor.get(color) || [];
    meshes.push(node);
    byColor.set(color, meshes);
  });
  return Array.from(
    byColor,
    ([color, meshes]): PrintablePart => ({ color, meshes }),
  );
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
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function xmlEscape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] || character,
  );
}

function coordinate(value: number) {
  if (Math.abs(value) < 0.000005) return "0";
  return Number(value.toFixed(5)).toString();
}

function partMeshXml(part: PrintablePart) {
  const vertices: string[] = [];
  const triangles: string[] = [];
  let vertexOffset = 0;

  for (const source of part.meshes) {
    const geometry = source.geometry.clone();
    geometry.applyMatrix4(source.matrixWorld);
    const position = geometry.getAttribute("position");
    for (let index = 0; index < position.count; index += 1) {
      vertices.push(
        `<vertex x="${coordinate(position.getX(index))}" y="${coordinate(position.getY(index))}" z="${coordinate(position.getZ(index))}"/>`,
      );
    }

    const indices = geometry.index;
    if (indices) {
      for (let index = 0; index < indices.count; index += 3) {
        triangles.push(
          `<triangle v1="${vertexOffset + indices.getX(index)}" v2="${vertexOffset + indices.getX(index + 1)}" v3="${vertexOffset + indices.getX(index + 2)}"/>`,
        );
      }
    } else {
      for (let index = 0; index < position.count; index += 3) {
        triangles.push(
          `<triangle v1="${vertexOffset + index}" v2="${vertexOffset + index + 1}" v3="${vertexOffset + index + 2}"/>`,
        );
      }
    }
    vertexOffset += position.count;
    geometry.dispose();
  }

  return `<mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh>`;
}

function create3mf(parts: PrintablePart[]) {
  const materialXml = parts
    .map(
      (part, index) =>
        `<base name="Color ${index + 1} ${xmlEscape(part.color)}" displaycolor="${part.color}FF"/>`,
    )
    .join("");
  const objectXml = parts
    .map(
      (part, index) =>
        `<object id="${index + 2}" type="model" name="Color ${index + 1} ${xmlEscape(part.color)}" pid="1" pindex="${index}">${partMeshXml(part)}</object>`,
    )
    .join("");
  const assemblyId = parts.length + 2;
  const components = parts
    .map((_, index) => `<component objectid="${index + 2}"/>`)
    .join("");
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Badge3D multicolor badge</metadata>
  <metadata name="Application">Badge3D</metadata>
  <metadata name="Description">Aligned color parts generated from a Shields.io badge</metadata>
  <resources>
    <basematerials id="1">${materialXml}</basematerials>
    ${objectXml}
    <object id="${assemblyId}" type="model" name="Badge3D multicolor assembly"><components>${components}</components></object>
  </resources>
  <build><item objectid="${assemblyId}"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "3D/3dmodel.model": strToU8(modelXml),
    },
    { level: 6 },
  );
}

function fitPreviewCamera(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  model: THREE.Object3D,
) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  if (bounds.isEmpty()) return;

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

function BadgePreview({
  svg,
  params,
  autoRotate,
  resetToken,
  onReady,
}: PreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const homeViewRef = useRef<PreviewView | null>(null);
  const resetAnimationRef = useRef<PreviewResetAnimation | null>(null);
  const [font, setFont] = useState<opentype.Font | null>(null);

  useEffect(() => {
    let active = true;
    loadBadgeFont().then((loadedFont) => {
      if (active) setFont(loadedFont);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
    camera.position.set(0, -56, 54);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 28;
    controls.maxDistance = 150;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    const canvas = renderer.domElement;
    const defaultLeftMouseButton = controls.mouseButtons.LEFT;
    let pointerInside = false;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "Interactive 3D model. Drag to rotate, hold Space and drag to pan, and scroll to zoom.",
    );

    const setSpacePanning = (active: boolean) => {
      controls.enablePan = active;
      controls.mouseButtons.LEFT = active
        ? THREE.MOUSE.PAN
        : defaultLeftMouseButton;
      canvas.classList.toggle("space-panning", active);
    };
    const handlePointerEnter = () => {
      pointerInside = true;
    };
    const handlePointerLeave = () => {
      pointerInside = false;
    };
    const cancelViewReset = () => {
      if (!resetAnimationRef.current) return;
      resetAnimationRef.current = null;
      controls.enabled = true;
    };
    const handlePointerDown = () => canvas.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isTyping =
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select, button") ||
          target.isContentEditable);
      if (
        event.code !== "Space" ||
        isTyping ||
        (!pointerInside && document.activeElement !== canvas)
      )
        return;
      event.preventDefault();
      setSpacePanning(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePanning(false);
    };
    const handleWindowBlur = () => setSpacePanning(false);

    canvas.addEventListener("pointerenter", handlePointerEnter);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointerdown", cancelViewReset, { capture: true });
    canvas.addEventListener("wheel", cancelViewReset, { capture: true });
    canvas.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);

    scene.add(new THREE.HemisphereLight(0xfff4dd, 0x141618, 2.15));
    const key = new THREE.DirectionalLight(0xffffff, 3.8);
    key.position.set(-25, -20, 52);
    key.castShadow = true;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xff9f43, 2.4);
    rim.position.set(35, 15, 25);
    scene.add(rim);

    const grid = new THREE.GridHelper(120, 24, 0x5f5541, 0x353430);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.15;
    scene.add(grid);

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (rootRef.current) {
        cancelViewReset();
        homeViewRef.current =
          fitPreviewCamera(camera, controls, rootRef.current) ?? null;
      }
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
        const progress = Math.min(
          (time - resetAnimation.startedAt) / resetAnimation.duration,
          1,
        );
        const eased = (1 - Math.cos(Math.PI * progress)) / 2;
        const radius = Math.exp(
          THREE.MathUtils.lerp(
            Math.log(resetAnimation.fromOrbit.radius),
            Math.log(resetAnimation.toOrbit.radius),
            eased,
          ),
        );
        resetOrbit.set(
          radius,
          THREE.MathUtils.lerp(
            resetAnimation.fromOrbit.phi,
            resetAnimation.toOrbit.phi,
            eased,
          ),
          resetAnimation.fromOrbit.theta + resetAnimation.thetaDelta * eased,
        );
        controls.target.lerpVectors(
          resetAnimation.fromTarget,
          resetAnimation.toTarget,
          eased,
        );
        camera.position
          .copy(resetOffset.setFromSpherical(resetOrbit))
          .add(controls.target);
        camera.zoom = THREE.MathUtils.lerp(
          resetAnimation.fromZoom,
          resetAnimation.toZoom,
          eased,
        );
        camera.updateProjectionMatrix();
        camera.lookAt(controls.target);

        if (progress === 1) {
          resetAnimationRef.current = null;
          controls.enabled = true;
        }
      } else {
        controls.update();
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(animate);

    (host as HTMLDivElement & { scene?: THREE.Scene }).scene = scene;

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerenter", handlePointerEnter);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("pointerdown", cancelViewReset, {
        capture: true,
      });
      canvas.removeEventListener("wheel", cancelViewReset, { capture: true });
      canvas.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      resetAnimationRef.current = null;
      homeViewRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current as
      | (HTMLDivElement & { scene?: THREE.Scene })
      | null;
    const scene = host?.scene;
    if (!scene || !font) return;

    if (rootRef.current) {
      scene.remove(rootRef.current);
      rootRef.current.traverse((item) => {
        if (item instanceof THREE.Mesh) {
          item.geometry.dispose();
          const materials = Array.isArray(item.material)
            ? item.material
            : [item.material];
          materials.forEach((material) => material.dispose());
        }
      });
    }

    const { group, stats } = buildModel(svg, params, font);
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

    let active = true;
    createSvgTexture(svg)
      .then((texture) => {
        if (!active || rootRef.current !== group) {
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
        plate.name = "Color preview";
        plate.position.z = params.baseHeight + 0.012;
        plate.userData.previewOnly = true;
        group.add(plate);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [svg, params, font, onReady]);

  useEffect(() => {
    if (rootRef.current) rootRef.current.userData.autoRotate = autoRotate;
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const homeView = homeViewRef.current;
    if (!camera || !controls || !homeView) return;

    const currentView = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      zoom: camera.zoom,
    };
    const dampingEnabled = controls.enableDamping;
    const autoRotateEnabled = controls.autoRotate;
    controls.enableDamping = false;
    controls.autoRotate = false;
    controls.update();
    controls.enableDamping = dampingEnabled;
    controls.autoRotate = autoRotateEnabled;
    camera.position.copy(currentView.position);
    controls.target.copy(currentView.target);
    camera.zoom = currentView.zoom;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) {
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

    resetAnimationRef.current = {
      startedAt: performance.now(),
      duration: 850,
      fromTarget: currentView.target,
      toTarget: homeView.target.clone(),
      fromOrbit,
      toOrbit,
      thetaDelta,
      fromZoom: currentView.zoom,
      toZoom: homeView.zoom,
    };
    controls.enabled = false;
  }, [resetToken]);

  return (
    <div
      className="preview-canvas"
      ref={hostRef}
      aria-label="Interactive 3D badge preview"
    />
  );
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
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
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
        style={{ "--range": `${percentage}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function BadgeWorkshop() {
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
    try {
      const storedTheme = window.localStorage.getItem("badge3d-color-theme");
      return storedTheme === "light" || storedTheme === "dark"
        ? storedTheme
        : "system";
    } catch {
      return "system";
    }
  });
  const [url, setUrl] = useState(DEFAULT_BADGE);
  const [svg, setSvg] = useState(DEFAULT_BADGE_SVG);
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [params, setParams] = useState<ModelParams>({
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
  const [autoRotate, setAutoRotate] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const modelRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );

    const applyTheme = () => {
      if (colorTheme === "system") {
        root.removeAttribute("data-theme");
        themeColor?.setAttribute(
          "content",
          systemTheme.matches ? "#171816" : "#f2eee5",
        );
      } else {
        root.dataset.theme = colorTheme;
        themeColor?.setAttribute(
          "content",
          colorTheme === "dark" ? "#171816" : "#f2eee5",
        );
      }
    };

    try {
      if (colorTheme === "system")
        window.localStorage.removeItem("badge3d-color-theme");
      else window.localStorage.setItem("badge3d-color-theme", colorTheme);
    } catch {
      // The theme still applies for this visit when storage is unavailable.
    }

    applyTheme();
    if (colorTheme === "system")
      systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [colorTheme]);

  const loadBadge = useCallback(async (nextUrl: string) => {
    setLoading(true);
    setLoadError("");
    setStatus("Building model…");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const target = new URL(nextUrl);
      if (
        target.protocol !== "https:" ||
        !["shields.io", "img.shields.io"].includes(target.hostname)
      ) {
        throw new Error("Paste a secure Shields.io URL.");
      }
      const response = await fetch(target, {
        headers: { Accept: "image/svg+xml" },
        signal: controller.signal,
      });
      const source = await response.text();
      if (!response.ok || !source.trimStart().startsWith("<svg")) {
        throw new Error("That URL did not return a valid SVG badge.");
      }
      if (source.length > 250_000)
        throw new Error("That SVG is too large to process.");
      setSvg(source);
      const { doc, height: sourceHeight } = svgMetrics(source);
      const nativeRadius = Number.parseFloat(
        doc
          .querySelector("clipPath rect[rx], svg > rect[rx]")
          ?.getAttribute("rx") || "0",
      );
      setParams((current) => ({
        ...current,
        radius: nativeRadius * (current.height / sourceHeight),
      }));
      setStatus("Ready");
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "The badge request timed out. Try again."
          : error instanceof Error
            ? error.message
            : "Conversion failed. Check the URL.";
      setLoadError(message);
      setStatus(message);
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  const convert = (event: FormEvent) => {
    event.preventDefault();
    loadBadge(url);
  };

  const updateParam = (key: AdjustableModelParam, value: number) => {
    setParams((current) =>
      key === "height"
        ? {
            ...current,
            height: value,
            radius: current.radius * (value / current.height),
          }
        : { ...current, [key]: value },
    );
  };

  const resetParams = () => {
    setParams((current) => ({
      height: DEFAULT_MODEL_HEIGHT,
      baseHeight: DEFAULT_BASE_HEIGHT,
      relief: DEFAULT_RELIEF,
      radius: current.radius * (DEFAULT_MODEL_HEIGHT / current.height),
    }));
  };

  const onModelReady = useCallback(
    (group: THREE.Group, nextStats: ModelStats) => {
      modelRef.current = group;
      setStats(nextStats);
    },
    [],
  );

  const getExportParts = () => {
    const model = modelRef.current;
    if (!model) return null;
    const printable = printableModel(model);
    return { printable, parts: printableParts(printable) };
  };

  const downloadStl = () => {
    const exported = getExportParts();
    if (!exported) return;
    const { printable } = exported;
    const data = new STLExporter().parse(printable, { binary: true });
    downloadBlob(new Blob([data], { type: "model/stl" }), "badge3d.stl");
  };

  const download3mf = () => {
    const exported = getExportParts();
    if (!exported) return;
    const data = create3mf(exported.parts);
    downloadBlob(
      new Blob([data], { type: "model/3mf" }),
      "badge3d-multicolor.3mf",
    );
  };

  const downloadColorStls = () => {
    const exported = getExportParts();
    if (!exported) return;
    const files: Record<string, Uint8Array> = {};
    exported.parts.forEach((part, index) => {
      const group = partAsGroup(part);
      const data = new STLExporter().parse(group, { binary: true });
      files[
        `color-${String(index + 1).padStart(2, "0")}-${part.color.slice(1).toLowerCase()}.stl`
      ] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      group.traverse((node) => {
        if (node instanceof THREE.Mesh) node.geometry.dispose();
      });
    });
    files["README.txt"] = strToU8(
      "Badge3D multicolor STL package\n\nImport every STL at the same time and keep their original coordinates.\nCombine them as parts of one object, then assign each part to the matching filament or extruder.\nThe hexadecimal color in each filename records the source badge color.\n",
    );
    const data = zipSync(files, { level: 6 });
    downloadBlob(
      new Blob([data], { type: "application/zip" }),
      "badge3d-color-stls.zip",
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
              className={colorTheme === "system" ? "selected" : ""}
              aria-pressed={colorTheme === "system"}
              title="Follow system theme"
              onClick={() => setColorTheme("system")}
            >
              <Monitor aria-hidden="true" size={13} strokeWidth={1.75} />
              <span>System</span>
            </button>
            <button
              type="button"
              className={colorTheme === "light" ? "selected" : ""}
              aria-pressed={colorTheme === "light"}
              title="Use light theme"
              onClick={() => setColorTheme("light")}
            >
              <Sun aria-hidden="true" size={13} strokeWidth={1.75} />
              <span>Light</span>
            </button>
            <button
              type="button"
              className={colorTheme === "dark" ? "selected" : ""}
              aria-pressed={colorTheme === "dark"}
              title="Use dark theme"
              onClick={() => setColorTheme("dark")}
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
          <span className="header-meta">
            <i /> SVG → SOLID
          </span>
        </div>
      </header>

      <section className="workbench" aria-label="Badge model editor">
        <div className="input-panel panel">
          <div className="source-intro">
            <div className="panel-heading">
              <span className="panel-number">01</span>
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
                  id="badge-url"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://img.shields.io/badge/..."
                  required
                />
                <button
                  className="primary-button"
                  type="submit"
                  disabled={loading}
                >
                  <span>{loading ? "BUILDING…" : "BUILD MODEL"}</span>
                  <ArrowRight aria-hidden="true" size={14} strokeWidth={1.75} />
                </button>
              </div>
            </form>
            <div className="examples">
              <span>EXAMPLES</span>
              {EXAMPLES.map(([label, exampleUrl]) => (
                <button
                  key={label}
                  type="button"
                  className={url === exampleUrl ? "selected" : ""}
                  onClick={() => {
                    setUrl(exampleUrl);
                    loadBadge(exampleUrl);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="preview-panel panel">
          <div className="panel-heading preview-heading">
            <span className="panel-number">02</span>
            <div>
              <small>Interactive viewport</small>
              <h2>Inspect the model</h2>
            </div>
            <span
              className={
                loadError ? "model-status error" : "model-status ready-dot"
              }
            >
              {status}
            </span>
          </div>
          <div className="preview-stage">
            {svg ? (
              <BadgePreview
                svg={svg}
                params={params}
                autoRotate={autoRotate}
                resetToken={resetToken}
                onReady={onModelReady}
              />
            ) : loading ? (
              <div className="preview-loading">PREPARING MODEL…</div>
            ) : (
              <div className="preview-loading preview-error">
                <b>MODEL COULD NOT BE BUILT</b>
                <span>{loadError || "Try another Shields.io URL."}</span>
              </div>
            )}
            <div className="view-tools">
              <button
                type="button"
                className={autoRotate ? "selected" : ""}
                onClick={() => setAutoRotate((value) => !value)}
              >
                ⟳ <span>Auto rotate</span>
              </button>
              <button
                type="button"
                onClick={() => setResetToken((value) => value + 1)}
              >
                ⌖ <span>Reset view</span>
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
                {stats.width.toFixed(0)} × {stats.height.toFixed(1)} ×{" "}
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
            <span className="panel-number">03</span>
            <div>
              <small>Print dimensions</small>
              <h2>Tune the model</h2>
            </div>
            <button
              className="settings-reset"
              type="button"
              onClick={resetParams}
            >
              <RotateCcw aria-hidden="true" size={12} strokeWidth={1.75} />
              <span>RESET</span>
            </button>
          </div>
          <div className="settings-controls">
            <RangeControl
              label="Model height"
              value={params.height}
              min={8}
              max={30}
              step={0.1}
              unit="mm"
              onChange={(v) => updateParam("height", v)}
            />
            <RangeControl
              label="Base thickness"
              value={params.baseHeight}
              min={1.2}
              max={5}
              step={0.1}
              unit="mm"
              onChange={(v) => updateParam("baseHeight", v)}
            />
            <RangeControl
              label="Letter relief"
              value={params.relief}
              min={0.3}
              max={2}
              step={0.1}
              unit="mm"
              onChange={(v) => updateParam("relief", v)}
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
            <span className="panel-number">04</span>
            <div>
              <small>Ready for your slicer</small>
              <h2>Export the model</h2>
            </div>
          </div>
          <div className="export-actions">
            <button
              className="download-button"
              type="button"
              onClick={download3mf}
            >
              <span>↓</span>
              <b>DOWNLOAD 3MF</b>
              <small>MULTICOLOR PARTS + MATERIAL DATA</small>
            </button>
            <div className="export-secondary">
              <button type="button" onClick={downloadStl}>
                <b>SINGLE-COLOR STL</b>
                <small>UNIVERSAL COMPATIBILITY</small>
              </button>
              <button type="button" onClick={downloadColorStls}>
                <b>COLOR STL ZIP</b>
                <small>SEPARATE ALIGNED PARTS</small>
              </button>
            </div>
          </div>
          <p className="export-note">
            3MF keeps source colors. STL works with every slicer.
          </p>
        </div>
      </section>

      <footer className="author-footer">
        Crafted with{" "}
        <span className="footer-heart" aria-label="love">
          ♥
        </span>{" "}
        by{" "}
        <a href="https://github.com/LitoMore" target="_blank" rel="noreferrer">
          LitoMore
        </a>
        , a member of the{" "}
        <a href="https://shields.io" target="_blank" rel="noreferrer">
          Shields.io
        </a>{" "}
        team.
      </footer>
    </main>
  );
}
