import test from "node:test";
import assert from "node:assert/strict";
import { createInitialUIState } from "../src/core/ui-state.js";
import { progressView } from "../src/domains/progress/view.js";

const names={main:"Main assistant",research:"Research",progress:"Progress"};
const escapeHTML=value=>String(value).replace(/[&<>\"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[char]));
const pageHeading=(eyebrow,title,description)=>`<header><small>${eyebrow}</small><h1>${title}</h1><p>${description}</p></header>`;

test("progress overview derives completion and workspace totals without mutating records",()=>{
  const state=createInitialUIState("light");
  state.tasks=[{id:"t1",title:"Finished task",done:true,createdAt:"2026-10-10T10:00:00Z"},{id:"t2",title:"Open task",done:false,createdAt:"2026-10-11T10:00:00Z"}];
  state.goals=[{id:"g1",title:"<script>goal</script>",done:true,createdAt:"2026-10-11T11:00:00Z"}];
  state.projects=[{id:"p1",name:"Robot project",updatedAt:"2026-10-11T12:00:00Z"}];
  const before=JSON.stringify({tasks:state.tasks,goals:state.goals,projects:state.projects});
  const html=progressView({state,names,pageHeading,escapeHTML});
  assert.match(html,/1\/2/);
  assert.match(html,/aria-valuenow="50"/);
  assert.match(html,/Robot project/);
  assert.match(html,/R&amp;D drafts/);
  assert.match(html,/Conversations/);
  assert.match(html,/&lt;script&gt;goal&lt;\/script&gt;/);
  assert.equal(JSON.stringify({tasks:state.tasks,goals:state.goals,projects:state.projects}),before);
});

test("progress overview renders a helpful empty state",()=>{
  const html=progressView({state:createInitialUIState("light"),names,pageHeading,escapeHTML});
  assert.match(html,/Nothing here yet/);
  assert.match(html,/Tasks completed/);
});

test("progress derives learning mastery, time and assessment totals from saved evidence",()=>{
  const state=createInitialUIState("light");
  state.learningPlans=[{id:"lp",topic:"Kinematics",topics:[{id:"t",title:"Frames",masteryStatus:"mastered",secondsStudied:900,assessments:[{total:5,correct:4,evidence:"Explained and solved a transform composition problem."}]}]}];
  const html=progressView({state,names,pageHeading,escapeHTML});
  assert.match(html,/Mastered topics/);
  assert.match(html,/Study time/);
  assert.match(html,/15 min/);
  assert.match(html,/1 ordered topics · evidence required/);
});
