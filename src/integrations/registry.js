/** Explicitly invoked capabilities and still-disabled privileged integrations. */
export const INTEGRATION_REGISTRY = Object.freeze([
  Object.freeze({id:"web-research",category:"research",status:"limited",requiresApproval:true}),
  Object.freeze({id:"persistent-storage",category:"storage",status:"implemented",requiresApproval:true}),
  Object.freeze({id:"nvidia-image-generation",category:"media",status:"implemented",requiresApproval:true,serverSideCredentials:true,privateArtifactStorage:true}),
  Object.freeze({id:"private-webrtc-voice",category:"voice",status:"optional",requiresApproval:true,serverSideCredentials:true,privateHostOnly:true}),
  Object.freeze({id:"nvidia-nemotron-realtime-voice",category:"voice",status:"implemented",requiresApproval:true,serverSideCredentials:true,privateHostOnly:true,fullDuplex:true,transport:"websocket"}),
  Object.freeze({id:"code-runner",category:"execution",status:"disabled",requiresApproval:true,isolationRequired:true}),
  Object.freeze({id:"robotics-simulator",category:"simulation",status:"disabled",requiresApproval:true}),
  Object.freeze({id:"experiment-compute",category:"compute",status:"implemented",requiresApproval:true})
]);
export function getIntegration(id){return INTEGRATION_REGISTRY.find(item=>item.id===id)??null;}
