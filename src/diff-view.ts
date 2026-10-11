/**
 * OpenCode-style diff presentation for omp tool cards.
 *
 * The host's built-in `edit` renderer paints one flat stream of tinted code
 * lines. This module re-lays the same `details.diff` payload into split,
 * unified, compact, or summary layouts and emits the header fragments (change
 * bracket, add/remove meter) that ride the host card's top bar.
 *
 * Pure functions only: no theme lookups beyond the injected `DiffTheme`, so
 * the layout logic is unit-testable without a terminal.
 */
import { diffWords } from "@oh-my-pi/pi-natives";
import { replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

export type DiffLineKind = "add" | "remove" | "context";

export interface DiffLine {
	kind: DiffLineKind;
	/** Line number as emitted by the producer; empty when unknown. */
	number: string;
	content: string;
}

export interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
	context: number;
	/** Contiguous change regions; a diff without gaps counts as one hunk. */
	hunks: number;
}

export type DiffMode = "auto" | "split" | "unified" | "compact" | "summary";
export type ResolvedDiffMode = Exclude<DiffMode, "auto">;

export interface DiffConfig {
	mode: DiffMode;
	/** Minimum width before `auto` may pick the split layout. */
	splitMinWidth: number;
	/** Rows shown while the card is collapsed. */
	collapsedLines: number;
	/** How changed rows are marked. */
	rowMarker: RowMarker;
}

/**
 * `hatch` swaps the row divider for a diagonal on changed rows; `none` leaves
 * the plain rule. Changed rows are told apart by foreground color either way —
 * a row background was tried and dropped, because a wash over the card reads as
 * noise at any strength that survives a dark theme.
 */
export type RowMarker = "hatch" | "none";

export const DEFAULT_DIFF_CONFIG: DiffConfig = {
	mode: "auto",
	splitMinWidth: 110,
	collapsedLines: 24,
	rowMarker: "hatch",
};

export interface DiffTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
	/**
	 * ANSI background prefix for the line-number gutter. Painted on every row,
	 * not just changed ones, so the numbers stay visually detached from the
	 * code body that butts up against them.
	 */
	gutterBg?(): string | undefined;
}

const CANONICAL_LINE = /^([+\- ])\s*(\d*)\|(.*)$/;
const LEGACY_LINE = /^([+\- ])(?:\s*(\d+)\s?)?(.*)$/;
const MIN_SUMMARY_WIDTH = 12;
const MIN_UNIFIED_WIDTH = 34;
const MIN_SPLIT_COLUMN_WIDTH = 28;
const SPLIT_SEPARATOR = " │ ";
const GUTTER_MIN_WIDTH = 3;
/** Shade glyph marking a changed row where the layout has no gutter column. */
const HATCH_MARK = "░";
const GUTTER_COLOR: Record<DiffLineKind, string> = {
	add: "toolDiffAdded",
	remove: "toolDiffRemoved",
	context: "dim",
};
const LINE_COLOR: Record<DiffLineKind, string> = {
	add: "toolDiffAdded",
	remove: "toolDiffRemoved",
	// Context sits back so the add/remove foregrounds carry the contrast.
	context: "toolDiffContext",
};

/**
 * Parse omp's compact diff text. Canonical rows are `+12|code`; legacy rows
 * are `+12 code`. Blank rows and `…` mark non-contiguous regions and also
 * separate hunks.
 */
export function parseDiff(diffText: string): ParsedDiff {
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let context = 0;
	let hunks = 0;
	let inHunk = false;

	for (const raw of diffText.replace(/\r/g, "").split("\n")) {
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed === "…" || trimmed === "...") {
			if (inHunk) {
				inHunk = false;
				hunks++;
			}
			continue;
		}

		const match = raw.match(CANONICAL_LINE) ?? raw.match(LEGACY_LINE);
		if (!match) continue;

		const marker = match[1] ?? " ";
		const kind: DiffLineKind = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
		if (kind !== "context" && !inHunk) {
			inHunk = true;
			hunks++;
		}
		if (kind === "add") added++;
		else if (kind === "remove") removed++;
		else context++;

		lines.push({ kind, number: (match[2] ?? "").trim(), content: match[3] ?? "" });
	}

	return { lines, added, removed, context, hunks: Math.max(hunks, added + removed > 0 ? 1 : 0) };
}

/** Layout is chosen from width thresholds, then narrowed by an explicit mode. */
export function resolveDiffMode(config: DiffConfig, width: number): ResolvedDiffMode {
	if (width < MIN_SUMMARY_WIDTH) return "summary";
	if (width < MIN_UNIFIED_WIDTH) return "compact";
	if (config.mode === "split" || config.mode === "unified" || config.mode === "compact" || config.mode === "summary") {
		const fits = MIN_SPLIT_COLUMN_WIDTH * 2 + visibleWidth(SPLIT_SEPARATOR);
		return config.mode === "split" && width >= fits ? "split" : config.mode === "split" ? "unified" : config.mode;
	}
	return width >= config.splitMinWidth ? "split" : "unified";
}


/**
 * Word-level emphasis for a `-`/`+` pair, matching the host's own inline
 * treatment (inverse on the changed tokens only) so the two renderers agree.
 *
 * The styled output is assembled by slicing the original strings at diff
 * offsets rather than by concatenating the diff parts: part concatenation
 * does not preserve per-side width exactly, and a rebuilt row that is a couple
 * of columns too wide breaks the card's column alignment.
 */
function emphasisPair(removed: string, added: string, theme: DiffTheme): { removed: string; added: string } {
	const removedSpans: Array<[number, number]> = [];
	const addedSpans: Array<[number, number]> = [];
	let removedCursor = 0;
	let addedCursor = 0;
	for (const part of diffWords(removed, added)) {
		if (part.removed) {
			removedSpans.push([removedCursor, removedCursor + part.value.length]);
			removedCursor += part.value.length;
		} else if (part.added) {
			addedSpans.push([addedCursor, addedCursor + part.value.length]);
			addedCursor += part.value.length;
		} else {
			removedCursor += part.value.length;
			addedCursor += part.value.length;
		}
	}
	return { removed: applySpans(removed, removedSpans, theme), added: applySpans(added, addedSpans, theme) };
}

/** Emit `text` with `spans` wrapped in inverse; indentation stays unstyled. */
function applySpans(text: string, spans: Array<[number, number]>, theme: DiffTheme): string {
	let out = "";
	let cursor = 0;
	for (const [start, end] of spans) {
		const from = Math.max(cursor, Math.min(start, text.length));
		const to = Math.max(from, Math.min(end, text.length));
		const lead = /^\s*/.exec(text.slice(from, to))?.[0] ?? "";
		out += text.slice(cursor, from) + lead + theme.inverse(text.slice(from + lead.length, to));
		cursor = to;
	}
	return out + text.slice(cursor);
}

/**
 * Trim plain text to at most `width` columns, without padding. Kept separate
 * from `fit` so a caller can emphasize the clipped text and pad afterwards:
 * diffing padded text lets the trailing spaces join the last changed token,
 * which would paint the whole right side of the row as changed.
 */
function clip(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text), width);
}

/**
 * Fit both sides of a `-`/`+` pair to `width` and return their emphasized
 * cores, without the outer row tint. Callers wrap the result in the row's own
 * `fg` so the tint still covers the whole code column.
 */
function fitPair(removedText: string, addedText: string, width: number, theme: DiffTheme): { removed: string; added: string } {
	const removed = clip(removedText, width);
	const added = clip(addedText, width);
	const emphasized = emphasisPair(removed, added, theme);
	const pad = (clipped: string): string => " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return { removed: emphasized.removed + pad(removed), added: emphasized.added + pad(added) };
}

/**
 * Fit plain text to exactly `width` columns before it is colored. Styling is
 * applied only after the fit, so a truncated row can never cut an escape
 * sequence and leak a background or inverse into the next cell.
 */
function fit(text: string, width: number): string {
	const clipped = clip(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Fill `text` with the gutter background, if the theme provides one. */
function paintGutter(theme: DiffTheme, text: string): string {
	const bg = theme.gutterBg?.();
	return bg ? `${bg}${text}\x1b[49m` : text;
}

/** Gutter cell: always the line number, filled so the column reads apart. */
function gutterCell(kind: DiffLineKind, number: string, numWidth: number, theme: DiffTheme): string {
	// The number column butts directly against the code body, so it carries its
	// own fill on every row — otherwise the two read as one run of text.
	return paintGutter(theme, theme.fg(GUTTER_COLOR[kind], number.padStart(numWidth, " ")));
}

/** Unified rows: number gutter, change marker, tinted code. Every row is `width` wide. */
export function renderUnified(parsed: ParsedDiff, width: number, theme: DiffTheme, rowMarker: RowMarker): string[] {
	const numWidth = Math.max(GUTTER_MIN_WIDTH, ...parsed.lines.map(line => line.number.length));
	const codeWidth = Math.max(1, width - numWidth - 1);
	const row = (kind: DiffLineKind, number: string, code: string): string => {
		// The divider doubles as the change marker: a shaded cell on changed rows
		// in hatch mode, the plain rule otherwise.
		const changed = kind !== "context";
		const divider = rowMarker === "hatch" && changed ? HATCH_MARK : "│";
		return `${gutterCell(kind, number, numWidth, theme)}${theme.fg(changed ? LINE_COLOR[kind] : "dim", divider)}${code}`;
	};

	const rows: string[] = [];
	let index = 0;

	while (index < parsed.lines.length) {
		const head = parsed.lines[index];
		if (!head) break;
		if (head.kind === "context") {
			rows.push(row("context", head.number, fit(head.content, codeWidth)));
			index++;
			continue;
		}

		// A change block is every consecutive removal followed by every
		// consecutive addition; index-aligned pairs get inline emphasis.
		const removed: DiffLine[] = [];
		while (parsed.lines[index]?.kind === "remove") {
			removed.push(parsed.lines[index] as DiffLine);
			index++;
		}
		const added: DiffLine[] = [];
		while (parsed.lines[index]?.kind === "add") {
			added.push(parsed.lines[index] as DiffLine);
			index++;
		}
		const paired = Math.min(removed.length, added.length);

		for (let i = 0; i < paired; i++) {
			const removeLine = removed[i] as DiffLine;
			const addLine = added[i] as DiffLine;
			// Fit both sides first: emphasis is computed on already-fitted text,
			// so the emphasized rows keep the same width as every other row.
			const emphasis = fitPair(removeLine.content, addLine.content, codeWidth, theme);
			rows.push(row("remove", removeLine.number, theme.fg("toolDiffRemoved", emphasis.removed)));
			rows.push(row("add", addLine.number, theme.fg("toolDiffAdded", emphasis.added)));
		}
		for (let i = paired; i < removed.length; i++) {
			const line = removed[i] as DiffLine;
			rows.push(row("remove", line.number, theme.fg("toolDiffRemoved", fit(line.content, codeWidth))));
		}
		for (let i = paired; i < added.length; i++) {
			const line = added[i] as DiffLine;
			rows.push(row("add", line.number, theme.fg("toolDiffAdded", fit(line.content, codeWidth))));
		}
	}

	return rows;
}

/** Two columns; a side with no counterpart renders as blanks so rows stay aligned. */
export function renderSplit(parsed: ParsedDiff, width: number, theme: DiffTheme, rowMarker: RowMarker): string[] {
	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const leftWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, Math.floor((width - separatorWidth) / 2));
	const rightWidth = width - separatorWidth - leftWidth;
	const numWidth = Math.max(GUTTER_MIN_WIDTH, ...parsed.lines.map(line => line.number.length));
	const separator = theme.fg("dim", SPLIT_SEPARATOR);

	const cell = (line: DiffLine | undefined, side: "left" | "right", columnWidth: number): string => {
		if (!line) return " ".repeat(columnWidth);
		// Additions only exist on the right, removals only on the left; a
		// context line repeats on both sides.
		const blank = side === "left" ? line.kind === "add" : line.kind === "remove";
		const kind: DiffLineKind = blank ? "context" : line.kind;
		const number = blank ? "" : line.number;
		const code = fit(line.content, columnWidth - numWidth);
		const gutter = blank ? paintGutter(theme, " ".repeat(numWidth)) : gutterCell(kind, number, numWidth, theme);
		return `${gutter}${theme.fg(LINE_COLOR[kind], code)}`;
	};

	// The middle column doubles as the change marker: a shaded cell in hatch
	// mode, tinted with the row's own color so add and remove stay distinct.
	const rule = (left: DiffLine | undefined, right: DiffLine | undefined): string => {
		if (rowMarker !== "hatch") return separator;
		const kind = left?.kind !== "context" && left ? "remove" : right && right.kind !== "context" ? "add" : null;
		return kind ? ` ${theme.fg(LINE_COLOR[kind], HATCH_MARK)} ` : separator;
	};

	// Both code columns are padded to their own width; the emphasis is
	// computed on the narrower of the two so the styled core is identical on
	// either side, and the wider side pads the rest inside its row tint.
	const leftCode = Math.max(0, leftWidth - numWidth);
	const rightCode = Math.max(0, rightWidth - numWidth);
	const pairWidth = Math.min(leftCode, rightCode);

	const rows: string[] = [];
	let index = 0;
	while (index < parsed.lines.length) {
		const head = parsed.lines[index];
		if (!head) break;
		if (head.kind === "context") {
			rows.push(`${cell(head, "left", leftWidth)}${separator}${cell(head, "right", rightWidth)}`);
			index++;
			continue;
		}
		const removed: DiffLine[] = [];
		while (parsed.lines[index]?.kind === "remove") {
			removed.push(parsed.lines[index] as DiffLine);
			index++;
		}
		const added: DiffLine[] = [];
		while (parsed.lines[index]?.kind === "add") {
			added.push(parsed.lines[index] as DiffLine);
			index++;
		}
		const paired = Math.min(removed.length, added.length);
		for (let i = 0; i < Math.max(removed.length, added.length); i++) {
			// A pair needs room in both columns to share one clipped core; when
			// either column is too narrow the pair falls through to the same
			// untinted cells as a surplus row.
			if (i < paired && pairWidth > 0) {
				// Index-aligned rows get word-level emphasis; surplus rows fall
				// back to `cell` and stay untinted, as in the unified layout.
				const removeLine = removed[i] as DiffLine;
				const addLine = added[i] as DiffLine;
				const core = fitPair(removeLine.content, addLine.content, pairWidth, theme);
				const left = `${gutterCell("remove", removeLine.number, numWidth, theme)}${theme.fg(LINE_COLOR.remove, core.removed + " ".repeat(leftCode - pairWidth))}`;
				const right = `${gutterCell("add", addLine.number, numWidth, theme)}${theme.fg(LINE_COLOR.add, core.added + " ".repeat(rightCode - pairWidth))}`;
				rows.push(`${left}${rule(removeLine, addLine)}${right}`);
				continue;
			}
			rows.push(`${cell(removed[i], "left", leftWidth)}${rule(removed[i], added[i])}${cell(added[i], "right", rightWidth)}`);
		}
	}
	return rows;
}

/** One indicator column, no gutters — for narrow panes. */
export function renderCompact(parsed: ParsedDiff, width: number, theme: DiffTheme, rowMarker: RowMarker): string[] {
	const codeWidth = Math.max(1, width - 2);
	const row = (line: DiffLine, code: string): string => {
		const marker = rowMarker === "hatch" && line.kind !== "context" ? HATCH_MARK : line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
		return `${theme.fg(GUTTER_COLOR[line.kind], marker)} ${theme.fg(LINE_COLOR[line.kind], code)}`;
	};

	const rows: string[] = [];
	let index = 0;
	while (index < parsed.lines.length) {
		const head = parsed.lines[index];
		if (!head) break;
		if (head.kind === "context") {
			rows.push(row(head, fit(head.content, codeWidth)));
			index++;
			continue;
		}
		const removed: DiffLine[] = [];
		while (parsed.lines[index]?.kind === "remove") {
			removed.push(parsed.lines[index] as DiffLine);
			index++;
		}
		const added: DiffLine[] = [];
		while (parsed.lines[index]?.kind === "add") {
			added.push(parsed.lines[index] as DiffLine);
			index++;
		}
		// Same pairing as the unified layout: index-aligned rows get word-level
		// emphasis, surplus rows render plain.
		const paired = Math.min(removed.length, added.length);
		for (let i = 0; i < paired; i++) {
			const removeLine = removed[i] as DiffLine;
			const addLine = added[i] as DiffLine;
			const core = fitPair(removeLine.content, addLine.content, codeWidth, theme);
			rows.push(row(removeLine, core.removed), row(addLine, core.added));
		}
		for (let i = paired; i < removed.length; i++) {
			const line = removed[i] as DiffLine;
			rows.push(row(line, fit(line.content, codeWidth)));
		}
		for (let i = paired; i < added.length; i++) {
			const line = added[i] as DiffLine;
			rows.push(row(line, fit(line.content, codeWidth)));
		}
	}
	return rows;
}

/**
 * Header-line fragments for the card's top bar: the `[+n/−n]` change bracket
 * and the `[━━━━━]` meter. Both are plain strings the host bar appends after
 * the `Edit: path` label, so they carry no layout of their own.
 */
export function renderStatsBracket(added: number, removed: number, theme: DiffTheme): string {
	const parts = [
		added > 0 ? theme.fg("toolDiffAdded", `+${added}`) : undefined,
		removed > 0 ? theme.fg("toolDiffRemoved", `-${removed}`) : undefined,
].filter(value => value !== undefined);
	return `${theme.fg("dim", "[")}${parts.join(theme.fg("dim", "/"))}${theme.fg("dim", "]")}`;
}

/** Right-aligned add/remove meter for the card's top bar; `null` when it cannot fit. */
export function renderStatMeter(added: number, removed: number, budget: number, theme: DiffTheme): string | null {
	const total = added + removed;
	if (total === 0 || budget < 8) return null;
	const slots = Math.max(4, Math.min(20, budget - 2));
	let addedSlots = Math.max(0, Math.min(slots, Math.round((added / total) * slots)));
	if (added > 0 && addedSlots === 0) addedSlots = 1;
	if (removed > 0 && addedSlots >= slots) addedSlots = slots - 1;
	const removedSlots = slots - addedSlots;
	return [
		theme.fg("dim", "["),
		addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "",
		removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "",
		theme.fg("dim", "]"),
	].join("");
}

/** Progress-style summary for panes too narrow to carry a diff body. */
export function renderSummaryRow(parsed: ParsedDiff, width: number): string {
	const candidates = [
		`↳ diff +${parsed.added} -${parsed.removed} • ${parsed.hunks}h`,
		`↳ diff +${parsed.added} -${parsed.removed}`,
		`+${parsed.added} -${parsed.removed}`,
		"diff",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", width, "");
}

/**
 * Diff rows for one parsed diff at the card's inner `width`, already clamped.
 * The card's frame, background, and top bar belong to the host tool-card
 * shell, so this returns bare rows only. `expanded` lifts the collapsed row
 * clamp; the collapsed tail states what was hidden.
 *
 * Layout rows are emitted at exactly `width` columns and are never truncated
 * afterwards: cutting styled text can slice an escape sequence in half and
 * leak its background into the rest of the card.
 */
export function renderDiffBody(parsed: ParsedDiff, width: number, theme: DiffTheme, config: DiffConfig, expanded: boolean): string[] {
	const mode = resolveDiffMode(config, width);
	if (mode === "summary") return [renderSummaryRow(parsed, width)];

	const rows =
		mode === "split" && width >= MIN_SPLIT_COLUMN_WIDTH * 2 + visibleWidth(SPLIT_SEPARATOR)
			? renderSplit(parsed, width, theme, config.rowMarker)
			: mode === "compact"
				? renderCompact(parsed, width, theme, config.rowMarker)
				: renderUnified(parsed, width, theme, config.rowMarker);

	const limit = expanded ? rows.length : Math.max(1, config.collapsedLines);
	const clamped = rows.slice(0, limit);
	const hidden = rows.length - clamped.length;

	const body = [...clamped];
	if (hidden > 0) {
		body.push("");
		// Fit the plain text first, then color it: styling before the fit would
		// let a truncation cut an escape sequence in half.
		body.push(theme.fg("muted", fit(`… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, width)));
	}
	return body;
}