/**
 * omp-better-diff — OpenCode-style diff cards for omp's `edit` / `apply_patch`
 * tool rows.
 *
 * The extension shadows the host `edit` tool only to supply `renderResult`.
 * The call row, streaming preview, expansion state, diagnostics and multi-file
 * fan-out stay owned by the host renderer; the header row is rebuilt here.
 */
import { applyPatchSchema, type ExtensionAPI, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";

import {
	DEFAULT_DIFF_CONFIG,
	type ContextHighlighter,
	type DiffConfig,
	type DiffMode,
	type DiffTheme,
	parseDiff,
	renderDiffBody,
	renderStatMeter,
	renderStatsBracket,
	type RowMarker,
} from "./src/diff-view.js";

/** Blend strength for the line-number gutter fill. */
const GUTTER_TINT_RATIO = 0.6;
const VALID_MODES: DiffMode[] = ["auto", "split", "unified", "compact", "summary"];
const VALID_MARKERS: RowMarker[] = ["hatch", "none"];

const state: DiffConfig = { ...DEFAULT_DIFF_CONFIG };
type EditToolDefinition = ToolDefinition & { customWireName?: string };

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

/** The edited path, for language detection. */
function readPath(details: unknown, args: unknown): string {
	const detail = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
	const arg = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	for (const value of [detail.path, arg.file_path, arg.path, detail.sourcePath]) {
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}

/** `Edit: <icon> path [+7/-1] ━━━━[━━━━━]` — label plus right-aligned meter. */
function renderHeaderRow(
	path: string,
	added: number,
	removed: number,
	width: number,
	theme: HeaderTheme,
): string {
	const title = theme.fg("accent", "Edit");
	const target = path
		? `${theme.fg("muted", theme.symbols.langIcon(languageFromPath(path)))} ${theme.fg("muted", path)}`
		: "";
	const label = `${target ? `${title}: ${target}` : title}${added + removed === 0 ? "" : ` ${renderStatsBracket(added, removed, theme)}`}`;
	const meter = renderStatMeter(added, removed, Math.max(0, width - visibleWidth(label) - 8), theme);
	if (!meter) return truncate(label, width, "");
	const gap = Math.max(1, width - visibleWidth(label) - visibleWidth(meter) - 4);
	return truncate(`${label} ${theme.fg("borderMuted", theme.symbols.box.horizontal.repeat(gap))} ${meter}`, width, "");
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

/** The theme fields {@link blendBg} needs; `ExtensionTheme` satisfies this. */
interface BlendTheme {
	readonly depth: string;
	hex(color: string): string;
}

/** The theme fields {@link renderHeaderRow} needs; `ExtensionTheme` satisfies this. */
interface HeaderTheme extends DiffTheme {
	symbols: {
		langIcon(lang: string | undefined): string;
		box: { horizontal: string };
	};
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
function blendBg(theme: BlendTheme, base: string, tint: string, ratio: number): string | undefined {
	if (theme.depth !== "truecolor") return undefined;
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

	pi.on("session_start", () => {
		try {
			const edit = pi.getAllTools().find(tool => tool.name === "edit");
			if (!edit) {
				pi.logger.warn("better-diff: no edit tool registered; skipped");
				return;
			}
			const definition: EditToolDefinition = {
				name: "edit",
				label: "Edit",
				description: edit.description,
				parameters: edit.parameters,
				strict: true,
				loadMode: "essential",
				// shortcut: approval tier approximated (write; exec for URL targets), always-ask-cached grants not replicated; upgrade by delegating to the native tool's approval decision.
				approval: args => (readPath(args, {}).includes("://") ? "exec" : "write"),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					if (!ctx.invokeTool) throw new Error("better-diff: native edit tool unavailable");
					return ctx.invokeTool(params as unknown as Record<string, unknown>);
				},
				renderResult(result, options, theme, args) {
					const diffText = readDiff(result.details);
					// A delete/move or a failed edit carries no diff: draw the host's
					// result text so the terminal body is not left blank.
					if (diffText.trim() === "") {
						const text = result.content
							.flatMap(part => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
							.filter(part => part.length > 0);
						return text.length > 0 ? { render: () => text } : undefined;
					}
					const parsed = parseDiff(diffText);
					const cardBg = theme.hex(result.isError ? "toolErrorBg" : options.isPartial ? "toolPendingBg" : "toolSuccessBg");
					const diffTheme: DiffTheme = {
						fg: (color, text) => theme.fg(color, text),
						bold: text => theme.bold(text),
						inverse: text => theme.inverse(text),
						gutterBg: () => blendBg(theme, cardBg, theme.hex("borderMuted"), GUTTER_TINT_RATIO),
					};
					const path = readPath(result.details, args);
					// Unedited lines are syntax-colored when the path names a language
					// the host's highlighter knows; changed rows keep the flat
					// add/remove foreground and their inverse emphasis.
					const language = path === "" ? undefined : languageFromPath(path);
					const highlight: ContextHighlighter | undefined = language
						? lines => highlightCode(lines.join("\n"), language, theme)
						: undefined;
					return {
						render: (width: number) => [
							renderHeaderRow(path, parsed.added, parsed.removed, width, theme),
							...renderDiffBody(parsed, width, diffTheme, state, options.expanded, highlight),
						],
					};
				},
			};
			if (edit.parameters === applyPatchSchema) definition.customWireName = "apply_patch";
			pi.registerTool(definition);
		} catch (error) {
			pi.logger.warn(`better-diff: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}