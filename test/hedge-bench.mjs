// Live hedge benchmark: two identical parallel requests, first valid wins,
// loser aborted — vs single-request baseline, alternating in the same window.
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
const OBJECTIVE = "请描述这张截图的内容：是什么界面/应用/页面？上面有哪些主要文字、元素、图标或窗口？整体布局是怎样的？";

const prompt = buildVisionPrompt({ objective: OBJECTIVE, mode: "general", detail: "balanced", imageCount: 1 });
const image = await encodeImageForUpload(
  { type: "image", data: (await readFile(ARTIFACT)).toString("base64"), mimeType: "image/png" },
  { maxEdgePx: 1792, maxBytes: 1024 * 1024 },
);
const messages = [
  { role: "system", content: VISION_SYSTEM_PROMPT },
  { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }] },
];

async function single() {
  const t = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, max_tokens: 4096, temperature: 0.1 }),
  });
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  return {
    ms: Date.now() - t,
    reasoning: (msg.reasoning_content ?? "").length,
    content: (msg.content ?? "").trim().length,
  };
}

async function oneRequest(signal, resultBox) {
  const t = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({ model: config.model, messages, max_tokens: 4096, temperature: 0.1 }),
    });
    const json = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    resultBox.latency = Date.now() - t;
    resultBox.reasoning = (msg.reasoning_content ?? "").length;
    resultBox.content = (msg.content ?? "").trim().length;
    return true;
  } catch {
    return false;
  }
}

async function hedged() {
  const t = Date.now();
  const controllers = [new AbortController(), new AbortController()];
  const boxes = [{}, {}];
  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (box) => {
      if (done) return;
      done = true;
      resolve(box);
    };
    void oneRequest(controllers[0].signal, boxes[0]).then((ok) => {
      if (ok) {
        controllers[1].abort();
        finish(boxes[0]);
      }
    });
    void oneRequest(controllers[1].signal, boxes[1]).then((ok) => {
      if (ok) {
        controllers[0].abort();
        finish(boxes[1]);
      }
    });
  });
  return { wallMs: Date.now() - t, winner: result, otherLatency: boxes[0].latency ?? boxes[1].latency };
}

console.log(`prompt=${prompt.length}c  objective=${OBJECTIVE.length}c\n`);
for (let i = 1; i <= 4; i++) {
  const s = await single();
  console.log(`SINGLE ${i}: ${s.ms}ms  reasoning=${s.reasoning}c  content=${s.content}c`);
  const h = await hedged();
  console.log(`HEDGED ${i}: ${h.wallMs}ms  winner reasoning=${h.winner.reasoning ?? "?"}c  winner content=${h.winner.content ?? "?"}c  (loser latency=${h.otherLatency}ms)`);
  const s2 = await single();
  console.log(`SINGLE ${i}b: ${s2.ms}ms  reasoning=${s2.reasoning}c  content=${s2.content}c`);
}
