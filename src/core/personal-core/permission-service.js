/** In-process permission policy prototype. Not an authorization boundary. */
const HIGH_RISK = new Set(["external_write","code_execution","shell_execution","simulation","experiment_execution","delete_data","cross_assistant_handoff"]);
export function evaluateAction({actionType,actor="user",approved=false,scopes=[]}={}) {
  if (!actionType || typeof actionType !== "string") return {allowed:false,reason:"invalid_action"};
  if (actor !== "user" && !approved) return {allowed:false,reason:"approval_required"};
  if (HIGH_RISK.has(actionType) && !approved) return {allowed:false,reason:"explicit_approval_required"};
  if (actionType.startsWith("memory:") && !scopes.includes("memory:write")) return {allowed:false,reason:"scope_missing"};
  return {allowed:true,reason:"policy_prototype_allow"};
}
