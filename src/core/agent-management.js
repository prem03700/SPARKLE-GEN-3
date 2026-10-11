import {AGENT_REGISTRY} from "./agent-registry.js";
import {createAuditService} from "./personal-core/audit-service.js";

/**
 * Central agent configuration manager.
 * Edits are in-memory proposals/configuration only; no provider is invoked.
 */
const allowedFields=new Set(["name","purpose","instructionProfile","modelProvider","modelId","tools","memoryScopes","handoffPolicy","enabled"]);
const handoffPolicies=new Set(["require_confirmation","bounded_auto"]);
export function createAgentManagement({audit=createAuditService()}={}) {
 const configs=new Map(Object.entries(AGENT_REGISTRY).map(([id,config])=>[id,structuredClone(config)]));
 function list(){return [...configs.values()].map(config=>structuredClone(config));}
 function get(id){const config=configs.get(id);return config?structuredClone(config):null;}
 function proposeUpdate(id,patch,{actor="user",approved=false}={}) {
  const current=configs.get(id);
  if(!current)return {ok:false,reason:"unknown_agent"};
  if(!patch||typeof patch!=="object"||Array.isArray(patch))return {ok:false,reason:"invalid_patch"};
  const fields=Object.keys(patch);
  if(!fields.length||fields.some(field=>!allowedFields.has(field)))return {ok:false,reason:"unsupported_field"};
  if(fields.includes("id")||("name" in patch && (typeof patch.name!=="string"||!patch.name.trim())))return {ok:false,reason:"invalid_name"};
  if("purpose" in patch&&(typeof patch.purpose!=="string"||!patch.purpose.trim()))return {ok:false,reason:"invalid_purpose"};
  if("tools" in patch&&(!Array.isArray(patch.tools)||patch.tools.some(tool=>typeof tool!=="string")))return {ok:false,reason:"invalid_tools"};
  if("memoryScopes" in patch&&(!Array.isArray(patch.memoryScopes)||patch.memoryScopes.some(scope=>typeof scope!=="string")))return {ok:false,reason:"invalid_memory_scopes"};
  if("enabled" in patch&&typeof patch.enabled!=="boolean")return {ok:false,reason:"invalid_enabled"};
  if("handoffPolicy" in patch&&!handoffPolicies.has(patch.handoffPolicy))return {ok:false,reason:"invalid_handoff_policy"};
  const proposal={agentId:id,patch:structuredClone(patch),status:"proposed",approvalRequired:true,actor};
  audit.record({type:"agent.config.proposed",actor,subject:{agentId:id},decision:"approval_required",details:{fields}});
  if(!approved)return {ok:true,proposal};
  const next={...current,...structuredClone(patch),id};
  configs.set(id,next);
  audit.record({type:"agent.config.updated",actor,subject:{agentId:id},decision:"approved",details:{fields}});
  return {ok:true,status:"updated_in_memory_only",agent:structuredClone(next)};
 }
 return Object.freeze({list,get,proposeUpdate,audit:options=>audit.list(options)});
}
