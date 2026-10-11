/** Central source of truth for assistant identity and configuration.
 * Keep per-agent configuration here; no provider or tool is connected.
 */
export const AGENT_REGISTRY = Object.freeze({
  main: Object.freeze({id:"main",name:"Main Assistant",workspace:"chat",purpose:"General conversation, intent clarification, and coordination.",instructionProfile:"main-v1",modelProvider:null,modelId:null,tools:[],memoryScopes:["profile","approved_knowledge","conversation"],handoffPolicy:"require_confirmation",enabled:true}),
  research: Object.freeze({id:"research",name:"Research Assistant",workspace:"research",purpose:"Literature review, evidence synthesis, hypotheses, methodology, and papers.",instructionProfile:"research-v1",modelProvider:null,modelId:null,tools:[],memoryScopes:["approved_knowledge","research_workspace"],handoffPolicy:"require_confirmation",enabled:true}),
  learning: Object.freeze({id:"learning",name:"Learning & Skills Assistant",workspace:"learning",purpose:"Lessons, deliberate practice, assessments, revision, and mastery checks.",instructionProfile:"learning-v1",modelProvider:null,modelId:null,tools:[],memoryScopes:["approved_knowledge","learning_workspace"],handoffPolicy:"require_confirmation",enabled:true}),
  coding: Object.freeze({id:"coding",name:"Coding Assistant",workspace:"coding",purpose:"Code explanation, debugging, test design, review, and refactoring.",instructionProfile:"coding-v1",modelProvider:null,modelId:null,tools:[],memoryScopes:["approved_knowledge","coding_workspace"],handoffPolicy:"require_confirmation",enabled:true}),
  projects: Object.freeze({id:"projects",name:"Project Assistant",workspace:"projects",purpose:"Requirements, scope, milestones, risks, and deliverables.",instructionProfile:"projects-v1",modelProvider:null,modelId:null,tools:[],memoryScopes:["approved_knowledge","project_workspace"],handoffPolicy:"require_confirmation",enabled:true}),
  rd: Object.freeze({id:"rd",name:"R&D Assistant",workspace:"lab",purpose:"Research workflow coordination, simulation design, experiments, and reproducibility.",instructionProfile:"rd-v1",modelProvider:null,modelId:null,tools:[],memoryScopes:["approved_knowledge","rd_workspace"],handoffPolicy:"require_confirmation",enabled:true})
});
export function getAgent(id){return AGENT_REGISTRY[id]??AGENT_REGISTRY.main;}
export function listAgents(){return Object.values(AGENT_REGISTRY);}
