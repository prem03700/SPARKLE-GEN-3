import test from "node:test";
import assert from "node:assert/strict";
import {createAgentManagement} from "../src/core/agent-management.js";

test("agent management reads centralized configurations",()=>{
 const manager=createAgentManagement();
 assert.ok(manager.get("research"));
 assert.ok(manager.list().length>=5);
 assert.equal(manager.get("research").modelProvider,"nvidia");
 assert.equal(manager.get("research").modelId,"nvidia/nemotron-3.5-lightning-30b-a3b");
});

test("agent changes are proposals unless explicitly approved",()=>{
 const manager=createAgentManagement();
 const proposal=manager.proposeUpdate("research",{name:"Research Specialist"});
 assert.equal(proposal.ok,true);
 assert.equal(proposal.proposal.status,"proposed");
 assert.equal(manager.get("research").name,"Research Assistant");
 const applied=manager.proposeUpdate("research",{name:"Research Specialist"},{approved:true});
 assert.equal(applied.status,"updated_in_memory_only");
 assert.equal(manager.get("research").name,"Research Specialist");
});

test("agent manager rejects invalid or unowned configuration fields",()=>{
 const manager=createAgentManagement();
 assert.equal(manager.proposeUpdate("missing",{name:"x"}).reason,"unknown_agent");
 assert.equal(manager.proposeUpdate("research",{providerUrl:"https://example.invalid"}).reason,"unsupported_field");
 assert.equal(manager.proposeUpdate("research",{tools:"shell"}).reason,"invalid_tools");
 assert.equal(manager.proposeUpdate("research",{handoffPolicy:"always_auto"}).reason,"invalid_handoff_policy");
});
