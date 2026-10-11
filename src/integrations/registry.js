/** Intended integrations. All remain disconnected until separately approved. */
export const INTEGRATION_REGISTRY = Object.freeze([
  Object.freeze({id:"web-research",category:"research",status:"disabled",requiresApproval:true}),
  Object.freeze({id:"persistent-storage",category:"storage",status:"disabled",requiresApproval:true}),
  Object.freeze({id:"code-runner",category:"execution",status:"disabled",requiresApproval:true,isolationRequired:true}),
  Object.freeze({id:"robotics-simulator",category:"simulation",status:"disabled",requiresApproval:true}),
  Object.freeze({id:"experiment-compute",category:"compute",status:"disabled",requiresApproval:true})
]);
export function getIntegration(id){return INTEGRATION_REGISTRY.find(item=>item.id===id)??null;}
