import { it } from "node:test";
import assert from "node:assert/strict";

// Load smoke test: importing the extension must register the vision tools and
// wire the interception handlers without throwing. Guards against load-time
// regressions (a thrown import/registration would silently remove the tools
// from the main model's list and break the whole image flow).
it("extension loads and registers all vision tools, commands, and handlers", async () => {
	const registeredTools = new Map();
	const registeredCommands = new Set();
	const handlers = new Map();
	const mockPi = {
		registerTool(tool: { name: string }) {
			registeredTools.set(tool.name, tool);
		},
		registerCommand(name: string) {
			registeredCommands.add(name);
		},
		on(event: string, handler: unknown) {
			handlers.set(event, handler);
		},
		unregisterProvider() {},
		registerProvider() {},
	};
	const { default: visionBridge } = await import("../extensions/vision-bridge.ts");
	await visionBridge(mockPi as never);

	assert.deepEqual([...registeredTools.keys()].sort(), ["vision_compare", "vision_inspect", "vision_query"]);
	for (const command of ["vision-settings", "vision-status", "vision-test", "vision-cache-clear", "vision-audit", "vision-last"]) {
		assert.ok(registeredCommands.has(command), `command ${command} registered`);
	}
	for (const event of ["session_start", "turn_start", "model_select", "before_agent_start", "session_shutdown", "input", "tool_call"]) {
		assert.ok(handlers.has(event), `handler ${event} wired`);
	}
});
