/** Runtime validators for frontend domain contracts; no API calls are made here. */
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
