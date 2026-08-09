/**
 * pi-vision-bridge 端到端识图测试脚本
 *
 * 模拟主模型调用 vision_inspect 的完整链路：
 *   本地截图 → buildVisionPrompt(任务化目标) → StepFun 视觉端点 → parseVisionObservation(结构化证据)
 *
 * 用法:
 *   npm run e2e -- <image-path> <mode> [objective]
 *   例如:
 *   npm run e2e -- /tmp/pvb-e2e/github-pi-repo.png ui_reverse_engineering
 *   npm run e2e -- /tmp/pvb-e2e/github-pi-repo.png ocr
 */
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
	buildVisionPrompt,
	VISION_SYSTEM_PROMPT,
} from "../src/vision-prompts.js";
import {
	parseVisionObservation,
	type VisionMode,
} from "../src/vision-schema.js";
import type { ResponseDetail } from "../src/config.js";

const MODES: VisionMode[] = [
	"general",
	"ocr",
	"ui_geometry",
	"ui_reverse_engineering",
	"chart",
	"document",
	"error_screenshot",
];

const DEFAULT_OBJECTIVES: Partial<Record<VisionMode, string>> = {
	ui_reverse_engineering:
		"我要复刻这个页面。请提取整体布局层级、主要区域边界、配色、字体层级、组件结构（含导航、内容区、侧栏）以及可观察的间距关系。",
	ocr: "按阅读顺序提取页面中所有可见文字，包括标题、导航项、正文段落和侧栏信息。",
	general: "概括这个页面的主题、主要内容和视觉结构。",
	ui_geometry:
		"测量页面主要区块（顶部导航、内容区、侧栏）的边界与相对宽度，并计算它们占视口宽度的比例。",
	document: "提取页面作为文档的结构：标题层级、章节、列表和关键字段。",
	error_screenshot: "提取页面中可见的错误提示或异常状态文本。",
	chart: "识别页面中的图表类型、坐标轴、图例和可见数值。",
};

async function loadImage(
	path: string,
): Promise<{ data: Buffer; mime: string; width: number; height: number }> {
	const buffer = await readFile(path);
	const metadata = await sharp(buffer, {
		limitInputPixels: 20_000_000,
	}).metadata();
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	if (!width || !height || width * height > 20_000_000) {
		throw new Error(
			`Image ${path} exceeds the configured pixel limit (20M px)`,
		);
	}
	const ext = path.toLowerCase().split(".").pop();
	const mime =
		ext === "jpg" || ext === "jpeg"
			? "image/jpeg"
			: ext === "webp"
				? "image/webp"
				: "image/png";
	return { data: buffer, mime, width, height };
}

async function main(): Promise<void> {
	const [, , imageArg, modeArg, objectiveArg] = process.argv;
	if (!imageArg) {
		console.error("用法: npm run e2e -- <image-path> <mode> [objective]");
		process.exit(1);
	}
	const imagePath = resolve(imageArg);
	const mode = (modeArg as VisionMode) ?? "ui_reverse_engineering";
	if (!MODES.includes(mode)) {
		console.error(`未知模式: ${mode}。可选: ${MODES.join(", ")}`);
		process.exit(1);
	}
	const objective = objectiveArg ?? DEFAULT_OBJECTIVES[mode] ?? "";

	// 读取配置与凭据（同插件真实路径）
	const configPath = join(
		homedir(),
		".pi",
		"agent",
		"vision-bridge",
		"config.json",
	);
	const credentialsPath = join(
		homedir(),
		".pi",
		"agent",
		"vision-bridge",
		"credentials.json",
	);
	const config = await readJsonFile<VisionConfigFile>(configPath, "视觉配置");
	const credentials = await readJsonFile<CredentialsFile>(
		credentialsPath,
		"视觉凭据",
	);
	const baseUrl = config.baseUrl?.replace(/\/+$/, "");
	const model = config.model;
	if (!baseUrl || !model) {
		console.error("✗ 视觉配置缺少 baseUrl 或 model，请先运行 /vision-settings");
		process.exit(1);
	}
	if (!credentials.apiKey) {
		console.error("✗ 视觉凭据缺少 apiKey");
		process.exit(1);
	}
	const detail: ResponseDetail =
		config.responseDetail === "concise" || config.responseDetail === "detailed"
			? config.responseDetail
			: "balanced";

	const { data, mime, width, height } = await loadImage(imagePath);
	console.log(
		`[1/4] 图片加载: ${imagePath} (${width}x${height}, ${(data.byteLength / 1024).toFixed(1)} KiB)`,
	);

	const prompt = buildVisionPrompt({
		objective: objective.slice(0, 12_000),
		mode,
		detail,
		imageCount: 1,
	});
	console.log(`[2/4] 视觉目标(mode=${mode}): ${objective}`);

	const started = Date.now();
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${credentials.apiKey}`,
		},
		signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: VISION_SYSTEM_PROMPT },
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{
							type: "image_url",
							image_url: {
								url: `data:${mime};base64,${data.toString("base64")}`,
							},
						},
					],
				},
			],
			max_tokens: 4096,
			...(config.enableThinking ? { enable_thinking: true } : {}),
		}),
	});
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	if (!response.ok) {
		const body = await response.text();
		console.error(
			`[3/4] ✗ 视觉端点请求失败 (HTTP ${response.status}, ${elapsed}s): ${body.slice(0, 500)}`,
		);
		process.exit(1);
	}
	const json = (await response.json()) as {
		choices: { message: { content?: string } }[];
		usage?: Record<string, number>;
	};
	const rawText = json.choices?.[0]?.message?.content ?? "";
	if (!rawText) {
		console.error(
			"⚠ 视觉端点返回空 content，完整响应结构:",
			JSON.stringify(json).slice(0, 2000),
		);
	}
	console.log(
		`[3/4] ✓ 视觉端点已响应 (HTTP ${response.status}, ${elapsed}s, raw ${rawText.length} 字符)`,
	);

	let parsed: unknown;
	try {
		parsed = parseJsonObject(rawText);
	} catch (error) {
		await writeFile("/tmp/pvb-e2e/raw-last.txt", rawText);
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[4/4] ✗ 视觉模型 JSON 解析失败: ${message}`);
		console.error(
			"原始输出已保存: /tmp/pvb-e2e/raw-last.txt\n",
			rawText.slice(0, 1500),
		);
		process.exit(1);
	}
	const observation = parseVisionObservation(parsed, {
		artifactIds: ["sha256:e2e-test"],
		mode,
		model,
	});
	const outputPath = join("/tmp/pvb-e2e", `result-${mode}.json`);
	await writeFileSafe(outputPath, `${JSON.stringify(observation, null, 2)}\n`);
	console.log(`[4/4] ✓ 证据校验通过，结果已保存: ${outputPath}`);

	console.log("\n==================== 结构化证据 ====================");
	console.log(`mode:    ${observation.mode}`);
	console.log(`summary: ${observation.summary}`);
	console.log(`observations: ${observation.observations.length} 条`);
	for (const item of observation.observations.slice(0, 25)) {
		console.log(`  - [${item.certainty}/${item.kind}] ${item.fact}`);
	}
	if (observation.textBlocks.length > 0) {
		console.log(`\ntext_blocks: ${observation.textBlocks.length} 块`);
		for (const block of observation.textBlocks.slice(0, 30)) {
			console.log(`  - [${block.certainty}] ${block.text}`);
		}
	}
	if (observation.uncertainties.length > 0) {
		console.log(`\nuncertainties: ${observation.uncertainties.length} 条`);
		for (const u of observation.uncertainties.slice(0, 10))
			console.log(`  - ${u}`);
	}
	if (
		observation.designSpec &&
		Object.keys(observation.designSpec).length > 0
	) {
		console.log(
			"\ndesign_spec keys:",
			Object.keys(observation.designSpec).join(", "),
		);
		const spec = observation.designSpec as Record<string, unknown>;
		if (Array.isArray(spec.palette))
			console.log("palette:", JSON.stringify(spec.palette.slice(0, 6)));
		if (Array.isArray(spec.components))
			console.log("components:", JSON.stringify(spec.components.slice(0, 8)));
	}
	console.log("====================================================");
	console.log(`usage: ${JSON.stringify(json.usage ?? {})}`);
}

interface VisionConfigFile {
	baseUrl?: string;
	model?: string;
	responseDetail?: string;
	timeoutMs?: number;
	enableThinking?: boolean;
}

interface CredentialsFile {
	apiKey?: string;
}

/**
 * 与插件 src/provider.ts 中 parseJsonObject 保持一致的容错解析：
 * 去除 markdown 代码围栏后尝试 JSON.parse，失败则截取首个 JSON 对象。
 */
function parseJsonObject(text: string): unknown {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start)
			return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error("Vision response did not contain a JSON object");
	}
}

async function readJsonFile<T>(path: string, label: string): Promise<T> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object")
			throw new Error("不是 JSON 对象");
		return parsed as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${label}读取失败 (${path}): ${message}`);
	}
}

async function writeFileSafe(path: string, content: string): Promise<void> {
	await writeFile(path, content);
}

main().catch((error) => {
	console.error("✗ 端到端测试失败:", error);
	process.exit(1);
});
