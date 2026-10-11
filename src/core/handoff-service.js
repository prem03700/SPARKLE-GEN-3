import { getAgent } from "./agent-registry.js";
import { validateHandoffRequest } from "./contracts.js";

/** Creates a reviewable handoff proposal. It never invokes an agent. */
export function proposeHandoff({id,fromAgent,toAgent,purpose,contextRefs=[]}) {
  if (!getAgent(fromAgent).enabled || !getAgent(toAgent).enabled) {
    return {ok:false,error:"Both source and target agents must be enabled."};
  }
  const result = validateHandoffRequest({id,fromAgent,toAgent,purpose,contextRefs});
  if (!result.ok) return result;
  return {ok:true,proposal:result.value};
}
