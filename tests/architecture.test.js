import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_REGISTRY, getAgent, listAgents } from "../src/core/agent-registry.js";
import { ACTION_POLICY, isActionEnabled } from "../src/core/action-policy.js";
import { INTEGRATION_REGISTRY } from "../src/integrations/registry.js";
import { validateActionProposal, validateHandoffRequest } from "../src/core/contracts.js";
import { proposeHandoff } from "../src/core/handoff-service.js";

test("agent configuration is centralized and has stable unique IDs", () => {
  const agents = listAgents();
  assert.ok(agents.length >= 5);
  assert.equal(new Set(agents.map(agent => agent.id)).size, agents.length);
  for (const agent of agents) {
    assert.ok(agent.workspace);
    assert.ok(agent.purpose);
    assert.equal(agent.handoffPolicy, "require_confirmation");
    assert.equal(agent.modelProvider, "nvidia");
    assert.equal(agent.modelId, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.deepEqual(agent.tools, []);
  }
  assert.equal(getAgent("unknown").id, "main");
  assert.ok(AGENT_REGISTRY.research);
});

test("local backend and model are enabled while privileged execution remains disabled", () => {
  assert.equal(ACTION_POLICY.backendConnected, true);
  assert.equal(ACTION_POLICY.modelCallsEnabled, true);
  assert.equal(ACTION_POLICY.codeExecutionEnabled, false);
  assert.equal(ACTION_POLICY.simulatorExecutionEnabled, false);
  assert.equal(ACTION_POLICY.externalWritesEnabled, false);
  for (const item of INTEGRATION_REGISTRY) assert.equal(item.status, "disabled");
  assert.equal(isActionEnabled("code_execution"), false);
  assert.equal(isActionEnabled("model_call"), true);
});

test("handoff contracts require distinct agents and explicit approval", () => {
  const invalid = validateHandoffRequest({id:"1",fromAgent:"research",toAgent:"research",purpose:"review"});
  assert.equal(invalid.ok, false);
  const valid = validateHandoffRequest({id:"2",fromAgent:"main",toAgent:"research",purpose:"Review this hypothesis"});
  assert.equal(valid.ok, true);
  assert.equal(valid.value.approval, "required");
  assert.equal(valid.value.status, "proposed");
});

test("handoff service only creates proposals; it does not execute them", () => {
  const result = proposeHandoff({id:"handoff-test",fromAgent:"main",toAgent:"coding",purpose:"Review a code snippet"});
  assert.equal(result.ok, true);
  assert.equal(result.proposal.status, "proposed");
  assert.equal(result.proposal.approval, "required");
});

test("action proposals are reviewable and approval-gated", () => {
  const result = validateActionProposal({actionType:"create_task",summary:"Draft a study plan"});
  assert.equal(result.ok, true);
  assert.equal(result.value.status, "proposed");
  assert.equal(result.value.approvalRequired, true);
});


test("every integration remains disabled and approval-gated", () => {
  assert.ok(INTEGRATION_REGISTRY.length > 0);
  for (const integration of INTEGRATION_REGISTRY) {
    assert.equal(integration.status, "disabled", `${integration.id} must stay disabled`);
    assert.equal(integration.requiresApproval, true, `${integration.id} must require approval`);
  }
});

test("frontend uses only its same-origin API and avoids arbitrary network and dynamic-code APIs", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "..");
  const files = ["index.html", "src/app.js", "src/core/action-policy.js", "src/core/agent-registry.js", "src/core/agent-management.js", "src/core/contracts.js", "src/core/handoff-service.js", "src/core/ui-state.js", "src/integrations/registry.js", "src/domains/chat/view.js", "src/domains/research/view.js", "src/domains/learning/view.js", "src/domains/coding/view.js", "src/domains/projects/view.js", "src/domains/rd-lab/view.js", "src/domains/knowledge/view.js", "src/domains/tasks/view.js", "src/domains/settings/view.js"];
  const forbidden = /\b(?:XMLHttpRequest|WebSocket|EventSource|eval|Function)\s*\(/;
  for (const file of files) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.equal(forbidden.test(source), false, `${file} must not use arbitrary network transports or evaluate dynamic code`);
    assert.doesNotMatch(source, /fetch\(\s*["'`]https?:/i, `${file} must not call external URLs directly`);
    if (file === "src/app.js") {
      assert.match(source, /const fmt=s=>escapeHTML\(s\)/, "model-generated text must be HTML-escaped before formatting");
      assert.match(source, /markdownHTML\(result\.answer\)/, "model output must pass through the safe Markdown renderer");
    }
  }
});
