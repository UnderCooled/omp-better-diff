/**
 * omp-better-diff — OpenCode-style diff cards for omp's `edit` / `apply_patch`
 * tool rows.
 *
 * The extension replaces the built-in renderer's `renderResult` slot only. The
 * call row, streaming preview, expansion state, diagnostics, and multi-file
 * fan-out stay owned by the host renderer; we only re-lay the settled diff and
 * rebuild the card's top bar (operation, path, `[+n/-n]`, add/remove meter).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { framedToolCard } from "@oh-my-pi/pi-tui/render";
import { toolRenderers, type ToolRenderer } from "@oh-my-pi/pi-tui/tools";
import { getLanguageFromPath, type Theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth, type Component } from "@oh-my-pi/pi-tui";
import {
	DEFAULT_DIFF_CONFIG,
	type DiffConfig,
	type DiffMode,
	type DiffTheme,
	parseDiff,
	renderDiffBody,
	renderStatMeter,
	renderStatsBracket,
	type RowMarker,
} from "./src/diff-view.js";

/** Border columns kept after the meter before the bar's right cap. */
const METER_TAIL_WIDTH = 4;
/** Below this card width the styled layout degrades to the native renderer. */
const MIN_STYLED_WIDTH = 100;
/** Blend strength for the line-number gutter fill. */
const GUTTER_TINT_RATIO = 0.6;
const PATCHED_TOOLS = ["edit", "apply_patch"] as const;
const VALID_MODES: DiffMode[] = ["auto", "split", "unified", "compact", "summary"];
const VALID_MARKERS: RowMarker[] = ["hatch", "none"];
/** Frame corners the top bar spends: `╭───` left, `╮` right, plus its label padding. */
const BAR_CHROME_WIDTH = 6;

const state: DiffConfig = { ...DEFAULT_DIFF_CONFIG };

/** Pull the diff payload out of a renderer result without assuming its shape. */
function readDiff(details: unknown): string {
	if (typeof details !== "object" || details === null) return "";
	const record = details as { diff?: unknown; perFileResults?: unknown };
	if (typeof record.diff === "string" && record.diff.trim() !== "") return record.diff;
	const { perFileResults } = record;
	if (!Array.isArray(perFileResults) || perFileResults.length !== 1) return "";
	const only: unknown = perFileResults[0];
	if (typeof only !== "object" || only === null) return "";
	const { diff } = only as { diff?: unknown };
	return typeof diff === "string" ? diff : "";
}

/** Operation, path, and rename for the top bar, derived like the host derives them. */
interface EditHeadFacts {
	title: string;
	path: string;
	rename?: string;
}

const OP_TITLES: Record<string, string> = { create: "Create", delete: "Delete", update: "Edit" };

function readHeadFacts(details: unknown, args: unknown): EditHeadFacts {
	const detail = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
	const arg = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const firstString = (...values: unknown[]): string | undefined => {
		for (const value of values) {
			if (typeof value === "string" && value !== "") return value;
		}
		return undefined;
	};
	const op = firstString(detail.op, arg.op);
	const path = firstString(detail.path, arg.file_path, arg.path) ?? "";
	const sourcePath = firstString(detail.sourcePath);
	const moveTarget = firstString(detail.move, arg.rename, arg.move);
	// A moved file reports both ends: render it as `source → destination`.
	if (sourcePath && path && sourcePath !== path) {
		return { title: (op && OP_TITLES[op]) || "Edit", path: sourcePath, rename: path };
	}
	return {
		title: (op && OP_TITLES[op]) || "Edit",
		path: firstString(sourcePath, path) ?? "",
		rename: moveTarget,
	};
}

/** `Edit: <icon> path [+7/-1]` — change count inside the bracket pair. */
function renderHeaderLabel(facts: EditHeadFacts, added: number, removed: number, theme: Theme): string {
	const title = theme.fg("accent", facts.title);
	const target = facts.rename ? `${facts.path} → ${facts.rename}` : facts.path;
	// A pathless edit (a failed call that still carries a diff) must not print
	// a dangling colon before the bracket pair.
	const line = target
		? `${title}: ${theme.getLangIconStyled(getLanguageFromPath(facts.path))} ${theme.fg("muted", target)}`
		: title;
	return added + removed === 0 ? line : `${line} ${renderStatsBracket(added, removed, theme)}`;
}

/** Parse `#rgb`/`#rrggbb` into channels; `undefined` for anything else. */
function parseHex(hex: string): [number, number, number] | undefined {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return undefined;
	const body = match[1] as string;
	const full = body.length === 3 ? body.split("").map(c => c + c).join("") : body;
	return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)];
}

/** sRGB channel → linear light. */
function toLinear(channel: number): number {
	const srgb = channel / 255;
	return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Linear light → sRGB channel. */
function toSrgb(linear: number): number {
	const channel = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
	return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

/**
 * Blend `tint` over `base` and emit a truecolor background escape. Returns
 * `undefined` on a 256-color terminal or an unparsable color, so the caller
 * silently falls back to untinted rows rather than emitting a broken escape.
 *
 * The mix runs in linear light, not on sRGB channel values. Card backgrounds
 * sit at the dark end of the curve, where sRGB interpolation is steeply
 * compressed: at a 16% ratio the remove row lands on `rgb(59,31,38)` against a
 * `rgb(22,26,31)` card — a contrast ratio of 1.17, which is invisible in
 * practice. Mixing in linear light gives `rgb(112,33,42)` for the same ratio.
 */
function blendBg(theme: Theme, base: string, tint: string, ratio: number): string | undefined {
	if (theme.getColorMode() !== "truecolor") return undefined;
	const from = parseHex(base);
	const to = parseHex(tint);
	if (!from || !to) return undefined;
	const mix = from.map((channel, index) =>
		toSrgb(toLinear(channel) + ((toLinear(to[index] as number) - toLinear(channel)) * ratio)),
	);
	return `\x1b[48;2;${mix[0]};${mix[1]};${mix[2]}m`;
}

function describeConfig(): string {
	return [
		`mode=${state.mode}`,
		`splitMinWidth=${state.splitMinWidth}`,
		`collapsedLines=${state.collapsedLines}`,
		`rowMarker=${state.rowMarker}`,
	].join(" ");
}

export default function ompBetterDiff(pi: ExtensionAPI) {
	pi.setLabel("Better Diff");

	pi.registerCommand("better-diff", {
		description:
			"Configure the diff card (mode auto|split|unified|compact|summary, marker hatch|none, lines <n>, reset)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify(`better-diff: ${describeConfig()}`, "info");
				return;
			}

			const rejected: string[] = [];
			for (const part of parts) {
				const lowered = part.toLowerCase();
				if (VALID_MODES.includes(lowered as DiffMode)) {
					state.mode = lowered as DiffMode;
					continue;
				}
				if (VALID_MARKERS.includes(lowered as RowMarker)) {
					state.rowMarker = lowered as RowMarker;
					continue;
				}
				if (/^\d+$/.test(part)) {
					state.collapsedLines = Math.max(1, Number.parseInt(part, 10));
					continue;
				}
				if (lowered === "reset") {
					Object.assign(state, DEFAULT_DIFF_CONFIG);
					continue;
				}
				rejected.push(part);
			}

			if (rejected.length > 0) {
				ctx.ui.notify(`better-diff: ignored ${rejected.join(", ")}`, "warning");
			}
			ctx.ui.notify(`better-diff: ${describeConfig()}`, "info");
		},
	});

	for (const toolName of PATCHED_TOOLS) {
		const renderer = toolRenderers[toolName] as ToolRenderer | undefined;
		if (!renderer?.renderResult) {
			pi.logger.warn(`better-diff: no built-in renderer for ${toolName}; skipped`);
			continue;
		}

		toolRenderers[toolName] = {
			...renderer,
			renderResult(result, options, theme, args) {
				const diffText = readDiff(result.details);
				// A delete/move or a failed edit carries no diff; defer to the host.
				if (diffText.trim() === "") return renderer.renderResult?.(result, options, theme, args);

				const parsed = parseDiff(diffText);
				const cardBg = theme.getBgHex(result.isError ? "toolErrorBg" : options.isPartial ? "toolPendingBg" : "toolSuccessBg");
				const diffTheme: DiffTheme = {
					fg: (color, text) => theme.fg(color as Parameters<typeof theme.fg>[0], text),
					bold: text => theme.bold(text),
					inverse: text => theme.inverse(text),
					gutterBg: () => blendBg(theme, cardBg, theme.getColorHex("borderMuted"), GUTTER_TINT_RATIO),
				};
				const facts = readHeadFacts(result.details, args);

				// The host's card shell owns the frame, background, and padding;
				// we contribute the top bar and the rows inside it. The meter is
				// padded out with border glyphs so it lands near the bar's right
				// edge; the shell fills whatever width is left over.
				const card = framedToolCard(theme, ({ width, contentWidth }) => {
					const label = renderHeaderLabel(facts, parsed.added, parsed.removed, theme);
					const barBudget = width - BAR_CHROME_WIDTH;
					const meter = renderStatMeter(
						parsed.added,
						parsed.removed,
						barBudget - visibleWidth(label) - 4,
						diffTheme,
					);
					// Reserve a short tail so the meter is flanked by border runs on
					// both sides rather than sitting flush against the right cap.
					const gap = meter ? Math.max(1, barBudget - visibleWidth(label) - visibleWidth(meter) - METER_TAIL_WIDTH) : 0;
					return {
						header: meter
							? `${label} ${theme.fg("borderMuted", theme.boxRound.horizontal.repeat(gap))} ${meter}`
							: label,
						sections: [{ content: renderDiffBody(parsed, contentWidth, diffTheme, state, options.expanded) }],
						phase: result.isError ? "error" : options.isPartial ? "partial" : "success",
						borderColor: result.isError ? "error" : "borderMuted",
						contentPaddingLeft: 0,
					};
				});

				const native = (): Component | undefined => renderer.renderResult?.(result, options, theme, args);
				// Below the threshold a split pane has no room for two columns and
				// a rescaled header only adds clutter, so the host card takes over.
				return {
					render: width => (width < MIN_STYLED_WIDTH ? (native()?.render(width) ?? []) : card.render(width)),
					invalidate: () => {
						card.invalidate?.();
						native()?.invalidate?.();
					},
				};
			},
		};
	}
}