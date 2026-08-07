export type VisionMode = "general" | "ocr" | "ui_geometry" | "ui_reverse_engineering" | "chart" | "document" | "error_screenshot";
export type Certainty = "observed" | "inferred" | "unclear";

export interface VisionObservationItem {
	fact: string;
	kind: string;
	certainty: Certainty;
	bbox?: [number, number, number, number];
	text?: string;
}

export interface VisionTextBlock {
	text: string;
	bbox?: [number, number, number, number];
	certainty: Certainty;
}

export interface VisionObservation {
	version: 1;
	artifactIds: string[];
	mode: VisionMode;
	summary: string;
	observations: VisionObservationItem[];
	textBlocks: VisionTextBlock[];
	uncertainties: string[];
	designSpec?: Record<string, unknown>;
	comparison?: Record<string, unknown>;
	model: string;
	createdAt: string;
}

const MODES: VisionMode[] = ["general", "ocr", "ui_geometry", "ui_reverse_engineering", "chart", "document", "error_screenshot"];
const CERTAINTIES: Certainty[] = ["observed", "inferred", "unclear"];

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function bboxValue(value: unknown): [number, number, number, number] | undefined {
	if (!Array.isArray(value) || value.length !== 4 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
	const numbers = value as number[];
	if (numbers.some((entry) => entry < 0 || entry > 1000)) return undefined;
	if (numbers[2] <= numbers[0] || numbers[3] <= numbers[1]) return undefined;
	return [numbers[0], numbers[1], numbers[2], numbers[3]];
}

export function parseVisionObservation(raw: unknown, input: { artifactIds: string[]; mode: VisionMode; model: string }): VisionObservation {
	const root = objectValue(raw);
	const mode = MODES.includes(root.mode as VisionMode) ? (root.mode as VisionMode) : input.mode;
	const observations = Array.isArray(root.observations)
		? root.observations.map((entry) => {
				const item = objectValue(entry);
				const certainty = CERTAINTIES.includes(item.certainty as Certainty) ? (item.certainty as Certainty) : "unclear";
				return {
					fact: stringValue(item.fact, stringValue(item.text, "Unspecified observation")),
					kind: stringValue(item.kind, "general"),
					certainty,
					...(bboxValue(item.bbox) ? { bbox: bboxValue(item.bbox) } : {}),
					...(typeof item.text === "string" ? { text: item.text } : {}),
				};
			})
		: [];
	const textBlocks = Array.isArray(root.text_blocks) ? root.text_blocks : Array.isArray(root.textBlocks) ? root.textBlocks : [];
	return {
		version: 1,
		artifactIds: input.artifactIds,
		mode,
		summary: stringValue(root.summary, "The vision model returned no summary."),
		observations,
		textBlocks: textBlocks.map((entry) => {
			const item = objectValue(entry);
			const certainty = CERTAINTIES.includes(item.certainty as Certainty) ? (item.certainty as Certainty) : "unclear";
			return {
				text: stringValue(item.text, ""),
				certainty,
				...(bboxValue(item.bbox) ? { bbox: bboxValue(item.bbox) } : {}),
			};
		}),
		uncertainties: Array.isArray(root.uncertainties) ? root.uncertainties.filter((entry): entry is string => typeof entry === "string") : [],
		...(root.design_spec && typeof root.design_spec === "object" ? { designSpec: root.design_spec as Record<string, unknown> } : {}),
		...(root.designSpec && typeof root.designSpec === "object" ? { designSpec: root.designSpec as Record<string, unknown> } : {}),
		...(root.comparison && typeof root.comparison === "object" ? { comparison: root.comparison as Record<string, unknown> } : {}),
		model: input.model,
		createdAt: new Date().toISOString(),
	};
}

export function observationForModel(value: VisionObservation): string {
	return JSON.stringify(value, null, 2);
}
