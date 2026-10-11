import test from "node:test";
import assert from "node:assert/strict";
import {createPersonalCore,createMemoryStore,createAuditService,evaluateAction} from "../src/core/personal-core/index.js";

test("Personal Core starts disconnected and non-persistent",()=>{
 const core=createPersonalCore();
 assert.deepEqual(core.status(),{mode:"in_process_prototype",backendConnected:false,persistent:false,modelCallsEnabled:false,executionEnabled:false});
});

test("in-memory repository clones values and enforces collection names",()=>{
 const store=createMemoryStore();
 const original={title:"draft",nested:{value:1}};
 store.put("projects","p1",original);
 original.nested.value=99;
 assert.equal(store.get("projects","p1").value.nested.value,1);
 const returned=store.get("projects","p1"); returned.value.nested.value=88;
 assert.equal(store.get("projects","p1").value.nested.value,1);
 assert.throws(()=>store.put("unknown","x",{}),/Unknown collection/);
});

test("agent-originated record writes require approval",()=>{
 const core=createPersonalCore();
 const denied=core.proposeRecord({collection:"tasks",id:"t1",value:{title:"Study"},actor:"learning"});
 assert.equal(denied.ok,false);
 assert.equal(denied.reason,"approval_required");
 const approved=core.proposeRecord({collection:"tasks",id:"t1",value:{title:"Study"},actor:"learning",approved:true});
 assert.equal(approved.ok,true);
 assert.equal(approved.status,"in_memory_only");
 assert.equal(core.readRecord({collection:"tasks",id:"t1"}).value.title,"Study");
});

test("handoffs are proposals and never dispatch agents",()=>{
 const core=createPersonalCore();
 const result=core.proposeHandoff({id:"h1",fromAgent:"main",toAgent:"research",purpose:"Review literature",contextRefs:["doc-1"]});
 assert.equal(result.ok,true);
 assert.equal(result.handoff.status,"proposed");
 assert.equal(result.handoff.approval,"required");
 assert.equal(core.listAudit().some(event=>event.type==="handoff.proposed"),true);
});

test("audit service records ordered events and filters by type",()=>{
 let n=0;
 const audit=createAuditService({clock:()=>String(++n)});
 audit.record({type:"test.a",actor:"user"});
 audit.record({type:"test.b",actor:"system"});
 assert.equal(audit.count(),2);
 assert.equal(audit.list({type:"test.a"}).length,1);
 assert.equal(audit.list()[1].at,"2");
});

test("privileged actions remain approval-gated",()=>{
 assert.equal(evaluateAction({actionType:"code_execution",actor:"coding"}).allowed,false);
 assert.equal(evaluateAction({actionType:"code_execution",actor:"coding",approved:true}).allowed,true);
});
