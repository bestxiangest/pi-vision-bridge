// FINAL end-to-end validation: exact new bridge pipeline.
// VISION_SYSTEM_PROMPT + buildVisionPrompt (terse) + 1792px + temp 0.1 + max_tokens 4096.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { encodeImageForUpload } from "../src/image-encode.js";
import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from "../src/vision-prompts.js";

const HOME = homedir();
const ARTIFACT = join(HOME, ".pi/agent/vision-bridge/cache/artifacts/7d52829a328054eb6b3cef3e9e4c71ab6ea26f6860d7431e118fb353ab9794ea.png");
const creds = JSON.parse(await readFile(join(HOME, ".pi/agent/vision-bridge/credentials.json"), "utf8"));
const config = JSON.parse(await readFile(join(HOME, ".pi/agent/vision-bridge/config.json"), "utf8"));
const BASE = (config.baseUrl || "https://api.stepfun.com/step_plan/v1").replace(/\/+$/, "");

const objective = "请描述这张截图的内容：是什么界面/应用/页面？上面有哪些主要文字、元素、图标或窗口？整体布局是怎样的？";
const prompt = buildVisionPrompt({ objective, mode: "general", detail: "balanced", imageCount: 1 });
const image = await encodeImageForUpload(
  { type: "image", data: (await readFile(ARTIFACT)).toString("base64"), mimeType: "image/png" },
  { maxEdgePx: 1792, maxBytes: 1024 * 1024 },
);

console.log(`system: ${VISION_SYSTEM_PROMPT.length} chars | user prompt: ${prompt.length} chars`);
console.log("== new pipeline: temp 0.1, max_tokens 4096, 1792px ==");

const results = [];
for (let i = 1; i <= 4; i++) {
  const t = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }] },
      ],
      stream: false,
      max_tokens: 4096,
      temperature: 0.1,
    }),
  });
  const json = await res.json();
  const u = json.usage ?? {};
  const m = json.choices?.[0]?.message ?? {};
  const content = (m.content ?? "").trim();
  let valid = false;
  try { JSON.parse(content); valid = true; } catch {}
  const elapsed = Date.now() - t;
  results.push(elapsed);
  console.log(`run ${i}: ${elapsed}ms  input=${u.prompt_tokens} output=${u.completion_tokens}  content=${content.length}c validJSON=${valid}  reasoning=${(m.reasoning_content ?? "").length}c`);
}
console.log(`avg: ${Math.round(results.reduce((a, b) => a + b, 0) / results.length)}ms  min: ${Math.min(...results)}ms  max: ${Math.max(...results)}ms`);
