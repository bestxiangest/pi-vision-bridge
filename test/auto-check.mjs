// Live validation of the new auto mode on the exact image from the user's question.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { encodeImageForUpload } from "../src/image-encode.js";
import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from "../src/vision-prompts.js";
import { parseVisionObservation } from "../src/vision-schema.js";

const HOME = homedir();
const ARTIFACT = join(HOME, ".pi/agent/vision-bridge/cache/artifacts/4273fc620391b53dbd99d11647e34bd5624c774ea7f9ff2da524dc87dbbe9986.png");
const creds = JSON.parse(await readFile(join(HOME, ".pi/agent/vision-bridge/credentials.json"), "utf8"));
const config = JSON.parse(await readFile(join(HOME, ".pi/agent/vision-bridge/config.json"), "utf8"));
const BASE = (config.baseUrl || "https://api.stepfun.com/step_plan/v1").replace(/\/+$/, "");
const OBJECTIVE = "解释一下这张图：这是什么应用/界面？包含哪些主要区域、文字和元素？";

const prompt = buildVisionPrompt({ objective: OBJECTIVE, mode: "auto", detail: "balanced", imageCount: 1 });
const image = await encodeImageForUpload(
  { type: "image", data: (await readFile(ARTIFACT)).toString("base64"), mimeType: "image/png" },
  { maxEdgePx: 1792, maxBytes: 1024 * 1024 },
);
const messages = [
  { role: "system", content: VISION_SYSTEM_PROMPT },
  { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }] },
];

console.log(`auto prompt: ${prompt.length} chars\n`);
const t = Date.now();
const res = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiKey}` },
  body: JSON.stringify({ model: config.model, messages, max_tokens: 4096, temperature: 0.1 }),
});
const json = await res.json();
const msg = json.choices?.[0]?.message ?? {};
const raw = (msg.content ?? "").trim();
console.log(`latency: ${Date.now() - t}ms  reasoning=${(msg.reasoning_content ?? "").length}c  content=${raw.length}c`);
const parsed = parseVisionObservation(JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")), {
  artifactIds: ["sha256:4273fc620391b53dbd99d11647e34bd5624c774ea7f9ff2da524dc87dbbe9986"],
  mode: "auto",
  model: config.model,
});
console.log(`\n--- summary ---\n${parsed.summary}`);
console.log(`\n--- observations (${parsed.observations.length}) ---`);
for (const o of parsed.observations) console.log(`- [${o.certainty}] ${o.fact}`);
if (parsed.textBlocks.length) {
  console.log(`\n--- text_blocks (${parsed.textBlocks.length}) ---`);
  for (const b of parsed.textBlocks) console.log(`- ${b.text}`);
}
console.log(`\n--- uncertainties ---`);
for (const u of parsed.uncertainties) console.log(`- ${u}`);
