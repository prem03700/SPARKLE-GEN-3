import {createMemoryStore} from "./memory-store.js";
import {createAuditService} from "./audit-service.js";
import {evaluateAction} from "./permission-service.js";

/**
 * Personal Core application-service prototype.
 * Uses only in-process memory. Not an HTTP server, database, auth system, or production security boundary.
 */
export function createPersonalCore({store=createMemoryStore(),audit=createAuditService()}={}) {
  function proposeRecord({collection,id,value,actor="user",approved=false,scopes=[]}) {
    const actionType=`write:${collection}`;
    const decision=evaluateAction({actionType,actor,approved,scopes});
    audit.record({type:"record.write.proposed",actor,subject:{collection,id},decision:decision.allowed?"allowed":"denied",details:{reason:decision.reason}});
    if(!decision.allowed) return {ok:false,status:"approval_required",reason:decision.reason};
    const saved=store.put(collection,id,value);
    audit.record({type:"record.write.completed",actor,subject:{collection,id},details:{}});
    return {ok:true,status:"in_memory_only",record:saved};
  }
  function readRecord({collection,id,actor="user"}) {
    const record=store.get(collection,id);
    audit.record({type:"record.read",actor,subject:{collection,id},details:{found:Boolean(record)}});
    return record;
  }
  function proposeHandoff({id,fromAgent,toAgent,purpose,contextRefs=[]}) {
    if(!id||!fromAgent||!toAgent||!purpose||fromAgent===toAgent) return {ok:false,reason:"invalid_handoff"};
    const handoff={id,fromAgent,toAgent,purpose,contextRefs:[...contextRefs],status:"proposed",approval:"required"};
    audit.record({type:"handoff.proposed",actor:fromAgent,subject:{handoffId:id},details:{toAgent,purpose}});
    return {ok:true,handoff};
  }
  return Object.freeze({
    status(){return {mode:"in_process_prototype",backendConnected:false,persistent:false,modelCallsEnabled:false,executionEnabled:false};},
    proposeRecord,readRecord,proposeHandoff,
    listAudit(options){return audit.list(options);},
    listCollections(){return store.collections();}
  });
}
