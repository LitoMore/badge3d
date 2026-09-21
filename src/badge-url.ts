// Linear scans preserve matching order without regex backtracking.

export type BadgeUrlParameters = {
	pathname: string;
	queryParams: Record<string, string | string[]>;
	label?: string;
	message?: string;
	color?: string;
	format?: string;
};

type StaticBadge = {
	label: string;
	message: string;
	color: string;
	format: string;
};

function parseStaticBadgeContent(content: string): StaticBadge | undefined {
	const format = content.endsWith('.json') ? 'json' : 'svg';
	const body = content.endsWith('.json')
		? content.slice(0, -5)
		: content.endsWith('.svg')
			? content.slice(0, -4)
			: content;
	const {length} = body;
	const colorSuffix = new Uint8Array(length + 1);
	const messageDelimiter = new Int32Array(length + 1).fill(-1);
	colorSuffix[length] = 1;

	// Each token is one non-hyphen character or an escaped pair of hyphens.
	// Cache valid color suffixes and the greedy message split in one reverse scan.
	for (let index = length - 1; index >= 0; index -= 1) {
		const character = body[index];
		const next =
			character === '-'
				? body[index + 1] === '-'
					? index + 2
					: -1
				: index + 1;
		if (character !== '.' && next !== -1) {
			colorSuffix[index] = colorSuffix[next];
		}

		const delimiter =
			character === '-' && index + 1 < length && colorSuffix[index + 1] === 1
				? index
				: -1;
		messageDelimiter[index] =
			next !== -1 && messageDelimiter[next] !== -1
				? messageDelimiter[next]
				: delimiter;
	}

	// Match the original lazy label, greedy optional separator and greedy message.
	for (let labelEnd = 0; labelEnd <= length;) {
		const separatedStart = body[labelEnd] === '-' ? labelEnd + 1 : labelEnd;
		const messageStart =
			messageDelimiter[separatedStart] === -1 ? labelEnd : separatedStart;
		const delimiter = messageDelimiter[messageStart];
		if (delimiter !== -1) {
			return {
				label: body.slice(0, labelEnd),
				message: body.slice(messageStart, delimiter),
				color: body.slice(delimiter + 1),
				format,
			};
		}

		if (body[labelEnd] === '-') {
			if (body[labelEnd + 1] !== '-') {
				return undefined;
			}

			labelEnd += 2;
		} else {
			labelEnd += 1;
		}
	}

	return undefined;
}

function parseStaticBadgePath(pathname: string): StaticBadge | undefined {
	const prefixLength = pathname.startsWith('/badge/')
		? 7
		: pathname.startsWith('/:')
			? 2
			: 0;
	return prefixLength === 0
		? undefined
		: parseStaticBadgeContent(pathname.slice(prefixLength));
}

function trimFilenamePunctuation(value: string) {
	let start = 0;
	let end = value.length;
	while (start < end && (value[start] === '-' || value[start] === '.')) {
		start += 1;
	}

	while (end > start && (value[end - 1] === '-' || value[end - 1] === '.')) {
		end -= 1;
	}

	return value.slice(start, end);
}

function decodeBadgeText(text: string) {
	return text
		.replaceAll(
			// eslint-disable-next-line regexp/prefer-lookaround -- Keep underscore decoding compatible with browsers without lookbehind.
			/(?<prefix>^|[^_])(?<pairs>(?:__)*)_(?!_)/gu,
			'$<prefix>$<pairs> ',
		)
		.replaceAll('__', '_')
		.replaceAll('--', '-');
}

/**
Extract URL parameters; dynamic badge content requires fetching the badge.
*/
export function parseBadgeParameters(
	value: string,
): BadgeUrlParameters | undefined {
	let url: URL;
	let pathname: string;
	try {
		url = new URL(value);
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return undefined;
	}

	const queryParameters = Object.create(
		null,
	) as BadgeUrlParameters['queryParams'];
	for (const name of new Set(url.searchParams.keys())) {
		const values = url.searchParams.getAll(name);
		queryParameters[name] = values.length === 1 ? values[0] : values;
	}

	const last = (name: string) => url.searchParams.getAll(name).at(-1);
	const result: BadgeUrlParameters = {pathname, queryParams: queryParameters};
	if (!['shields.io', 'img.shields.io'].includes(url.hostname)) {
		return result;
	}

	const match = parseStaticBadgePath(pathname);
	if (match) {
		const {label, message, color, format} = match;
		Object.assign(result, {
			label: last('label') ?? decodeBadgeText(label),
			message: decodeBadgeText(message),
			color: last('color') ?? last('colorB') ?? color,
			format,
		});
	} else if (/^\/static\/v1(?:\.(?:svg|json))?$/u.test(pathname)) {
		Object.assign(result, {
			label: last('label') ?? '',
			message: last('message'),
			color: last('color') ?? last('colorB') ?? 'lightgrey',
			format: pathname.endsWith('.json') ? 'json' : 'svg',
		});
	}

	return result;
}

export function badgeFilenameStem(value: string): string {
	const badge = parseBadgeParameters(value);
	const description =
		badge?.message === undefined
			? (badge?.pathname.replace(/\.(?:svg|json)$/u, '') ?? '')
			: [badge.label, badge.message, badge.color].filter(Boolean).join('-');
	// Keep Unicode text, but remove separators, controls, and filesystem punctuation.
	const safe = trimFilenamePunctuation(
		Array.from(description.normalize('NFC'), (char) =>
			/[\p{Letter}\p{Mark}\p{Number}#%\-._]/u.test(char) ? char : '-',
		)
			.join('')
			.replaceAll(/-+/gu, '-'),
	);
	// Bound UTF-8 bytes so suffixes and extensions fit common filesystem limits.
	let bounded = '';
	for (const char of safe) {
		if (new TextEncoder().encode(bounded + char).length > 160) {
			break;
		}

		bounded += char;
	}

	bounded = trimFilenamePunctuation(bounded);
	return bounded.length > 0 ? `badge3d-${bounded}` : 'badge3d';
}
