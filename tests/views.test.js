import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_REGISTRY, getAgent } from "../src/core/agent-registry.js";
import { createInitialUIState } from "../src/core/ui-state.js";
import { chatView } from "../src/domains/chat/view.js";
import { researchView } from "../src/domains/research/view.js";
import { learningView } from "../src/domains/learning/view.js";
import { codingView } from "../src/domains/coding/view.js";
import { projectsView } from "../src/domains/projects/view.js";
import { labView } from "../src/domains/rd-lab/view.js";
import { knowledgeView } from "../src/domains/knowledge/view.js";
import { tasksView } from "../src/domains/tasks/view.js";
import { progressView } from "../src/domains/progress/view.js";
import { settingsView } from "../src/domains/settings/view.js";

const names = Object.fromEntries(Object.values(AGENT_REGISTRY).map(agent => [agent.id, agent.name]));
Object.assign(names, {lab:"R&D Lab",knowledge:"Knowledge",tasks:"Tasks & goals",progress:"Progress",settings:"Settings"});
const escapeHTML = value => String(value).replace(/[&<>"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));
const pageHeading = (eyebrow,title,description) => `<header><small>${eyebrow}</small><h1>${title}</h1><p>${description}</p></header>`;
const card = (kicker,title,description) => `<article><small>${kicker}</small><h3>${title}</h3><p>${description}</p></article>`;
const messageHTML = message => `<article class="${message.role}">${message.html}</article>`;
const initialMessages = [{role:"assistant",html:"<p>Welcome</p>"}];

test("every workspace view renders independently from the app shell", () => {
  const state = createInitialUIState("light");
  const common = {state,names,pageHeading,card};
  const views = [
    chatView({...common,escapeHTML,initialMessages,messageHTML,getAgent}),
    researchView(common),
    learningView(common),
    codingView(common),
    projectsView(common),
    labView(common),
    knowledgeView(common),
    tasksView(common),
    progressView({...common,escapeHTML}),
    settingsView(common)
  ];
  assert.equal(views.length, 10);
  for (const html of views) {
    assert.equal(typeof html, "string");
    assert.ok(html.length > 100);
  }
  assert.match(views[0], /Main Assistant/);
  const chatState = createInitialUIState("light");
  chatState.chat = [{role:"user",html:"<p>Question</p>"},{role:"assistant",html:"<p>Answer</p>"}];
  const chatWithTools = chatView({...common,state:chatState,escapeHTML,initialMessages,messageHTML,getAgent});
  assert.match(chatWithTools, /Question/);
  const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(appSource, /edit-message/);
  assert.match(appSource, /retry-message/);
  assert.match(appSource, /delete-conversation/);
  assert.match(appSource, /Delete this conversation from SPARKLE history/);
  assert.match(appSource, /clear-history/);
  assert.match(appSource, /Tasks, goals, Knowledge, projects, and settings will remain/);
  assert.match(appSource, /attachChatFile/);
  assert.match(appSource, /toggle-voice/);
  assert.match(appSource, /Browser speech services may process microphone audio/);
  assert.match(views[0], /data-action="toggle-voice"/);
  assert.match(views[0], /aria-pressed="false"/);
  assert.match(appSource, /attachmentContent/);
  const attachmentState = createInitialUIState("light");
  attachmentState.pendingAttachment = {name:"example.py",content:"print(1)"};
  const attachmentView = chatView({...common,state:attachmentState,escapeHTML,initialMessages,messageHTML,getAgent});
  assert.match(attachmentView, /chatAttachment/);
  assert.match(attachmentView, /example.py/);
  assert.match(attachmentView, /remove-chat-attachment/);
  assert.match(views[5], /R&D Lab/);
  assert.match(views[8], /Progress/);
  assert.match(views[8], /Recent workspace activity/);
  assert.match(views[9], /backupImport/);
  assert.match(views[9], /clear-data/);
  assert.match(views[9], /export-data/);
  assert.match(views[9], /memoryEnabled/);
  assert.match(views[9], /show-pairing-code/);
  assert.match(views[6], /knowledgeImport/);
  assert.match(views[6], /knowledgeSearchInput/);
  const knowledgeState = createInitialUIState("light");
  knowledgeState.knowledgeQuery = "inertia";
  knowledgeState.knowledge = [
    {id:"robot-note",title:"Robot dynamics",content:"Joint inertia affects torque.",createdAt:"2026-10-10"},
    {id:"other-note",title:"Shopping",content:"Milk and bread.",createdAt:"2026-10-11"}
  ];
  const knowledgeSearch = knowledgeView({state:knowledgeState,pageHeading});
  assert.match(knowledgeSearch, /Joint inertia affects torque/);
  assert.doesNotMatch(knowledgeSearch, /Milk and bread/);
  assert.match(knowledgeSearch, /1 matches/);
  const auditState = createInitialUIState("light");
  Object.assign(auditState, {hasToken:true,apiStatus:"connected",auditEvents:[{event_type:"workspace.updated",summary:"revision=1",created_at:"2026-10-11"}]});
  const auditSettings = settingsView({state:auditState,pageHeading});
  assert.match(auditSettings, /refresh-audit/);
  assert.match(auditSettings, /workspace.updated/);
});

test("R&D tabs have a valid initial view", () => {
  const html = labView({state:createInitialUIState("light"),names,pageHeading,card});
  assert.match(html,/Simulation/);
  assert.match(html,/Experiments/);
  assert.match(html,/Reproducibility/);
});
