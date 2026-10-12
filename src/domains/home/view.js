/** Personal command center: lightweight, data-backed overview and resumable work. */
export function homeView({state}) {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const learning = Array.isArray(state.learningPlans) ? state.learningPlans : [];
  const research = Array.isArray(state.researchDrafts) ? state.researchDrafts : [];
  const knowledge = Array.isArray(state.knowledge) ? state.knowledge : [];
  const conversations = Array.isArray(state.conversations) ? state.conversations : [];
  const openTasks = tasks.filter(item => !item.done);
  const openGoals = goals.filter(item => !item.done);
  const completedTasks = tasks.length - openTasks.length;
  const completion = tasks.length ? Math.round(completedTasks / tasks.length * 100) : 0;
  const latestConversation = conversations.slice().sort((a,b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
  const lastUserMessage = latestConversation?.chat?.slice().reverse().find(message => message.role === "user");
  const lastPreview = lastUserMessage?.html?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || "Pick up your latest conversation";
  const focusTask = openTasks[0];
  const focusGoal = openGoals[0];
  const recent = (items, titleKey, view, empty) => items.length
    ? items.slice().sort((a,b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0)).slice(0,3).map(item => '<button class="home-recent-row" data-view="' + view + '"><span>' + esc(item[titleKey] || "Untitled") + '</span><span class="home-row-arrow" aria-hidden="true">↗</span></button>').join("")
    : '<p class="muted home-empty">' + empty + '</p>';
  const focusBody = focusTask
    ? '<div class="home-focus-kicker">NEXT OPEN TASK</div><h3>' + esc(focusTask.title || "Untitled task") + '</h3><p>' + esc(focusTask.details || "Review this task and decide your next step.") + '</p><button class="soft-button" data-view="tasks">Review tasks →</button>'
    : '<div class="home-focus-kicker">NEXT STEP</div><h3>' + (tasks.length ? "Your task list is clear" : "Choose one useful next step") + '</h3><p>' + (tasks.length ? "All saved tasks are complete. Add another only when you need one." : "Start a conversation, add a task, or open a workspace.") + '</p><button class="soft-button" data-action="new-task">＋ Add a task</button>';
  return '<section class="home-welcome"><div class="eyebrow">YOUR PERSONAL SPACE</div><h1>What matters now?</h1><p>A quiet home for your conversations and ongoing work.</p></section>' +
    '<section class="panel-card home-command" aria-label="Ask SPARKLE"><div class="home-command-copy"><h2>What would you like to work on?</h2><p>Ask a question or continue with an idea. Nothing is saved as a task or goal unless you choose to do so.</p></div><form class="home-command-form" data-action="home-command-form"><label class="sr-only" for="homeCommandInput">Ask SPARKLE anything</label><input id="homeCommandInput" maxlength="12000" placeholder="Ask SPARKLE anything…" autocomplete="off"><button class="primary-button" type="submit">Continue →</button></form><div class="home-command-examples"><button type="button" data-home-prompt="Help me plan my next steps">Plan my next steps</button><button type="button" data-home-prompt="Help me understand a topic">Learn something</button><button type="button" data-home-prompt="Help me research a question and identify sources to verify">Research a question</button></div></section>' +
    '<section class="home-command-grid" aria-label="Continue and focus"><article class="panel-card home-continue"><div class="home-section-heading"><h3>Continue where you left off</h3><span class="home-subtle-label">LATEST CHAT</span></div>' +
    (latestConversation ? '<button class="home-continue-link" data-action="open-conversation" data-id="' + esc(latestConversation.id) + '"><span class="home-continue-title">' + esc(latestConversation.title || "Saved conversation") + '</span><span class="home-continue-preview">' + esc(lastPreview.slice(0,150)) + '</span><span class="home-continue-cta">Resume conversation <span aria-hidden="true">↗</span></span></button>' : '<p class="muted home-empty">Your saved conversations will appear here.</p><button class="soft-button" data-view="chat" data-assistant="main">Start your first conversation →</button>') +
    '</article><article class="panel-card home-focus">' + focusBody + (focusGoal ? '<div class="home-focus-goal"><span>ACTIVE GOAL</span><strong>' + esc(focusGoal.title || "Untitled goal") + '</strong></div>' : '') + '</article></section>' +
    '<div class="section-title">Workspace overview</div><section class="home-metrics" aria-label="Workspace overview">' +
    '<button class="home-metric" data-view="tasks"><span>OPEN TASKS</span><strong>' + openTasks.length + '</strong><small>of ' + tasks.length + ' tasks</small></button>' +
    '<button class="home-metric" data-view="tasks"><span>ACTIVE GOALS</span><strong>' + openGoals.length + '</strong><small>of ' + goals.length + ' goals</small></button>' +
    '<button class="home-metric" data-view="projects"><span>PROJECTS</span><strong>' + projects.length + '</strong><small>saved project briefs</small></button>' +
    '<button class="home-metric" data-view="learning"><span>LEARNING PLANS</span><strong>' + learning.length + '</strong><small>saved plans</small></button></section>' +
    '<section class="home-sections"><article class="panel-card"><div class="home-section-heading"><h3>Workspace progress</h3><button class="text-action" data-view="progress">View progress →</button></div>' +
    '<div class="home-progress-head"><span>Tasks completed</span><strong>' + completion + '%</strong></div><div class="home-progress-track" role="progressbar" aria-label="Tasks completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + completion + '"><span style="width:' + completion + '%"></span></div>' +
    '<div class="home-pulse-stats"><div><strong>' + completedTasks + '</strong><span>completed tasks</span></div><div><strong>' + research.length + '</strong><span>research drafts</span></div><div><strong>' + knowledge.length + '</strong><span>knowledge notes</span></div></div>' +
    '<div class="home-section-heading home-quick-heading"><h3>Workspaces</h3></div><div class="home-quick-links"><button data-view="tasks">Tasks & goals <span>↗</span></button><button data-view="projects">Projects <span>↗</span></button><button data-view="learning">Learning <span>↗</span></button><button data-view="research">Research <span>↗</span></button><button data-view="knowledge">Knowledge <span>↗</span></button><button data-view="lab">R&D Lab <span>↗</span></button></div></article>' +
    '<article class="panel-card"><div class="home-section-heading"><h3>Recent work</h3></div>' +
    '<div class="home-work-group"><span class="home-work-label">Projects</span>' + recent(projects, "name", "projects", "Your project briefs will appear here.") + '</div>' +
    '<div class="home-work-group"><span class="home-work-label">Learning</span>' + recent(learning, "topic", "learning", "Your learning plans will appear here.") + '</div>' +
    '<div class="home-work-group"><span class="home-work-label">Research</span>' + recent(research, "question", "research", "Your research questions will appear here.") + '</div></article></section>' +
    '<p class="home-footnote">Home reflects saved workspace records only. Suggestions do not create tasks, goals, or external actions automatically.</p>';
}
