/** Runtime validators for frontend domain contracts; no API calls are made here. */
import { validateAnswerBlock } from "./answer-renderer.js";
export function validateHandoffRequest(value){
  if(!value||typeof value!=="object")return {ok:false,error:"Expected an object."};
  for(const key of ["id","fromAgent","toAgent","purpose"])if(typeof value[key]!=="string"||!value[key].trim())return {ok:false,error:`Missing required field: ${key}`};
  if(value.fromAgent===value.toAgent)return {ok:false,error:"Source and target agents must differ."};
  return {ok:true,value:Object.freeze({id:value.id,fromAgent:value.fromAgent,toAgent:value.toAgent,purpose:value.purpose,contextRefs:Array.isArray(value.contextRefs)?value.contextRefs:[],approval:"required",status:"proposed"})};
}
export function validateActionProposal(value){
  if(!value||typeof value!=="object")return {ok:false,error:"Expected an object."};
  if(typeof value.actionType!=="string"||!value.actionType.trim())return {ok:false,error:"Missing actionType."};
  if(typeof value.summary!=="string"||!value.summary.trim())return {ok:false,error:"Missing summary."};
  return {ok:true,value:Object.freeze({...value,status:"proposed",approvalRequired:true})};
}

const STREAM_EVENTS = new Set(["meta", "status", "delta", "answer_block", "image_status", "image_result", "voice_event", "done", "error"]);

/** Validates the envelope crossing the model/provider-to-UI boundary. Unknown event types fail closed. */
export function validateStreamEvent(event, payload) {
  if (!STREAM_EVENTS.has(event)) return { ok: false, error: "Unsupported stream event." };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "Stream payload must be an object." };
  const text = (value, limit) => typeof value === "string" && value.length <= limit;
  if (event === "delta" && !text(payload.text, 12000)) return { ok: false, error: "Invalid text delta." };
  if (event === "status" && (!text(payload.stage, 80) || !text(payload.message, 240))) return { ok: false, error: "Invalid status event." };
  if (event === "answer_block") {
    const block = payload.block;
    if (!block || typeof block !== "object" || Array.isArray(block) || !["card", "table", "chart", "diagram", "prompt", "graph", "steps", "robot_arm"].includes(block.type) || !validateAnswerBlock(block, block.type).ok) return { ok: false, error: "Invalid answer block." };
  }
  if (event === "image_status" && (!text(payload.status, 40) || !["queued", "generating", "succeeded", "failed"].includes(payload.status))) return { ok: false, error: "Invalid image status." };
  if (event === "image_result" && (!text(payload.artifact_id, 64) || !/^[0-9a-f]{32}$/.test(payload.artifact_id))) return { ok: false, error: "Invalid image artifact reference." };
  if (event === "voice_event" && !text(payload.type, 100)) return { ok: false, error: "Invalid voice event." };
  if (event === "done" && (!text(payload.answer, 50000) || (payload.elapsed_ms !== undefined && (!Number.isFinite(payload.elapsed_ms) || payload.elapsed_ms < 0)))) return { ok: false, error: "Invalid completion event." };
  if (event === "error" && !text(payload.error, 500)) return { ok: false, error: "Invalid error event." };
  return { ok: true, value: Object.freeze({ event, payload }) };
}
