// Static path parsing adapted from shields.io/core/badge-urls/static-badge-path.js
// at 3fe73533a04cbd4bf14a44bb449dc6a97947e5e5. See shields-LICENSE-MIT.txt.
// Kept local until the upstream parser is available as a dependency.

export type BadgeUrlParameters = {
  pathname: string;
  queryParams: Record<string, string | string[]>;
  label?: string;
  message?: string;
  color?: string;
  format?: string;
};

const labelPattern = "(?:[^-]|--)*?";
const messagePattern = "(?:[^-]|--)*";
const colorPattern = "(?:[^-.]|--)+";
const staticBadgePathRegex = new RegExp(
  `^/(?::|badge/)(${labelPattern})-?(${messagePattern})-(${colorPattern})(?:\\.(svg|json))?$`,
);

function decodeBadgeText(text: string) {
  return text
    .replace(/(^|[^_])((?:__)*)_(?!_)/g, "$1$2 ")
    .replace(/__/g, "_")
    .replace(/--/g, "-");
}

/** Extract URL parameters; dynamic badge content requires fetching the badge. */
export function parseBadgeParameters(value: string): BadgeUrlParameters | undefined {
  let url: URL;
  let pathname: string;
  try {
    url = new URL(value);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const queryParams: BadgeUrlParameters["queryParams"] = Object.create(null);
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    queryParams[name] = values.length === 1 ? values[0] : values;
  }
  const last = (name: string) => url.searchParams.getAll(name).at(-1);
  const result: BadgeUrlParameters = { pathname, queryParams };
  if (!["shields.io", "img.shields.io"].includes(url.hostname)) return result;

  const match = staticBadgePathRegex.exec(pathname);
  if (match) {
    const [, label, message, color, format = "svg"] = match;
    Object.assign(result, {
      label: last("label") ?? decodeBadgeText(label),
      message: decodeBadgeText(message),
      color: last("color") ?? last("colorB") ?? color,
      format,
    });
  } else if (/^\/static\/v1(?:\.(svg|json))?$/.test(pathname)) {
    Object.assign(result, {
      label: last("label") ?? "",
      message: last("message"),
      color: last("color") ?? last("colorB") ?? "lightgrey",
      format: pathname.endsWith(".json") ? "json" : "svg",
    });
  }
  return result;
}

export function badgeFilenameStem(value: string): string {
  const badge = parseBadgeParameters(value);
  const description = badge?.message !== undefined
    ? [badge.label, badge.message, badge.color].filter(Boolean).join("-")
    : badge?.pathname.replace(/\.(svg|json)$/, "") ?? "";
  // Keep Unicode text, but remove separators, controls, and filesystem punctuation.
  const safe = Array.from(description.normalize("NFC"), (char) =>
    /[\p{L}\p{N}\p{M}_%#.-]/u.test(char) ? char : "-",
  ).join("").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  // Bound UTF-8 bytes so suffixes and extensions fit common filesystem limits.
  let bounded = "";
  for (const char of safe) {
    if (new TextEncoder().encode(bounded + char).length > 160) break;
    bounded += char;
  }
  bounded = bounded.replace(/[.-]+$/g, "");
  return bounded ? `badge3d-${bounded}` : "badge3d";
}
