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
    assert.equal(agent.modelProvider, null);
    assert.deepEqual(agent.tools, []);
  }
  assert.equal(getAgent("unknown").id, "main");
  assert.ok(AGENT_REGISTRY.research);
});

test("backend and privileged actions remain disabled", () => {
  assert.equal(ACTION_POLICY.backendConnected, false);
  assert.equal(ACTION_POLICY.modelCallsEnabled, false);
  assert.equal(ACTION_POLICY.codeExecutionEnabled, false);
  assert.equal(ACTION_POLICY.simulatorExecutionEnabled, false);
  assert.equal(ACTION_POLICY.externalWritesEnabled, false);
  for (const item of INTEGRATION_REGISTRY) assert.equal(item.status, "disabled");
  assert.equal(isActionEnabled("code_execution"), false);
  assert.equal(isActionEnabled("model_call"), false);
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
