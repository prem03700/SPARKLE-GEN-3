import test from "node:test";
import assert from "node:assert/strict";
import { createInitialUIState } from "../src/core/ui-state.js";
import { progressView } from "../src/domains/progress/view.js";

const names={main:"Main assistant",research:"Research",progress:"Progress"};
const escapeHTML=value=>String(value).replace(/[&<>\"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[char]));
const pageHeading=(eyebrow,title,description)=>`<header><small>${eyebrow}</small><h1>${title}</h1><p>${description}</p></header>`;

test("progress derives consistent completion totals and navigable metrics without mutating records",()=>{
  const state=createInitialUIState("light");
  state.tasks=[{id:"t1",title:"Finished task",done:true,createdAt:"2026-10-10T10:00:00Z"},{id:"t2",title:"Status-completed task",status:"completed",done:false},{id:"t3",title:"Open task",done:false}];
  state.goals=[{id:"g1",title:"<script>goal</script>",status:"completed",done:false}];
  state.workspaceHistory=[{id:"h1",workspace:"tasks",title:"<script>goal</script>",createdAt:new Date().toISOString()}];
  state.projects=[{id:"p1",name:"Robot project",updatedAt:"2026-10-11T12:00:00Z"}];
  const before=JSON.stringify({tasks:state.tasks,goals:state.goals,projects:state.projects});
  const html=progressView({state,names,pageHeading,escapeHTML});
  assert.match(html,/2\/3/);
  assert.match(html,/aria-valuenow="67"/);
  assert.match(html,/1\/1/);
  assert.match(html,/data-view="projects"/);
  assert.match(html,/R&amp;D records/);
  assert.match(html,/Conversations/);
  assert.match(html,/&lt;script&gt;goal&lt;\/script&gt;/);
  assert.match(html,/completion rate/);
  assert.equal(JSON.stringify({tasks:state.tasks,goals:state.goals,projects:state.projects}),before);
});

test("progress overview renders a helpful empty state and does not invent activity",()=>{
  const html=progressView({state:createInitialUIState("light"),names,pageHeading,escapeHTML});
  assert.match(html,/No recorded activity in this time range/);
  assert.match(html,/Tasks completed/);
  assert.match(html,/0 \/ 0 \(0%\)/);
  assert.doesNotMatch(html,/Sample data|Demo data|Robot project/);
});

test("progress derives mastery, study time, and valid assessment totals from saved evidence",()=>{
  const state=createInitialUIState("light");
  state.learningPlans=[{id:"lp",topic:"Kinematics",topics:[{id:"t",title:"Frames",masteryStatus:"mastered",secondsStudied:900,assessments:[{total:5,correct:4,evidence:"Explained and solved a transform composition problem."},{total:0,correct:0,evidence:"invalid"}]}]}];
  const html=progressView({state,names,pageHeading,escapeHTML});
  assert.match(html,/Mastered topics/);
  assert.match(html,/15 min/);
  assert.match(html,/1 valid learner-reported assessments/);
  assert.match(html,/1 total topics · evidence-based/);
});

test("activity time filter applies inclusive lower boundary and excludes future/undated records",()=>{
  const now=Date.now();
  const iso=offset=>new Date(now+offset).toISOString();
  const state=createInitialUIState("light");state.progressRange="7d";
  state.workspaceHistory=[
    {id:"recent",workspace:"research",title:"Recent event",createdAt:iso(-86400000)},
    {id:"old",workspace:"research",title:"Old event",createdAt:iso(-8*86400000)},
    {id:"future",workspace:"research",title:"Future event",createdAt:iso(86400000)},
    {id:"undated",workspace:"research",title:"Undated event"}
  ];
  const html=progressView({state,names,pageHeading,escapeHTML});
  assert.match(html,/Recent event/);
  assert.doesNotMatch(html,/Old event|Future event|Undated event/);
  assert.match(html,/option value="7d" selected/);
});

test("completed milestones and assessments show only real dated events with workspace navigation",()=>{
  const now=new Date().toISOString(),state=createInitialUIState("light");
  state.goals=[{id:"g1",title:"Robotics",milestones:[{id:"m1",title:"Forward kinematics",done:true,completedAt:now},{id:"m2",title:"Pending milestone",done:false,completedAt:null}]}];
  state.learningPlans=[{id:"lp",topic:"Math",topics:[{id:"t1",title:"Matrices",assessments:[{id:"a1",total:10,correct:9,evidence:"Solved matrix operations and explained each step clearly.",createdAt:now}]}]}];
  const html=progressView({state,names,pageHeading,escapeHTML});
  assert.match(html,/Forward kinematics/);
  assert.match(html,/Matrices/);
  assert.match(html,/data-view="tasks"/);
  assert.match(html,/data-view="learning"/);
  assert.doesNotMatch(html,/Pending milestone/);
});
