/** Personal landing page: a calm overview of existing user-owned work. */
export function homeView({state}) {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const learning = Array.isArray(state.learningPlans) ? state.learningPlans : [];
  const research = Array.isArray(state.researchDrafts) ? state.researchDrafts : [];
  const openTasks = tasks.filter(item => !item.done);
  const openGoals = goals.filter(item => !item.done);
  const recent = (items, titleKey, view, empty) => items.length
    ? items.slice(-4).reverse().map(item => '<button class="home-recent-row" data-view="' + view + '"><span>' + esc(item[titleKey] || "Untitled") + '</span><span class="home-row-arrow">↗</span></button>').join("")
    : '<p class="muted home-empty">' + empty + '</p>';
  return '<section class="home-welcome"><div class="eyebrow">YOUR PERSONAL SPACE</div><h1>What matters now?</h1><p>A clear starting point for your conversations, goals, projects, learning, and research.</p><div class="home-actions"><button class="primary-button" data-view="chat" data-assistant="main">＋ Start a conversation</button><button class="soft-button" data-action="new-task">＋ Add a task</button><button class="soft-button" data-action="new-goal">＋ Add a goal</button></div></section>' +
    '<section class="home-metrics" aria-label="Workspace overview">' +
    '<button class="home-metric" data-view="tasks"><span>OPEN TASKS</span><strong>' + openTasks.length + '</strong><small>of ' + tasks.length + ' tasks</small></button>' +
    '<button class="home-metric" data-view="tasks"><span>ACTIVE GOALS</span><strong>' + openGoals.length + '</strong><small>of ' + goals.length + ' goals</small></button>' +
    '<button class="home-metric" data-view="projects"><span>PROJECTS</span><strong>' + projects.length + '</strong><small>saved project briefs</small></button>' +
    '<button class="home-metric" data-view="learning"><span>LEARNING PLANS</span><strong>' + learning.length + '</strong><small>saved plans</small></button>' +
    '</section>' +
    '<section class="home-sections"><article class="panel-card"><div class="home-section-heading"><h3>Tasks to focus on</h3><button class="text-action" data-view="tasks">View all →</button></div>' + (openTasks.length ? openTasks.slice(0,4).map(item => '<button class="home-recent-row" data-view="tasks"><span>' + esc(item.title || "Untitled task") + '</span><span class="home-row-arrow">↗</span></button>').join("") : '<p class="muted home-empty">No open tasks. Add one when you are ready.</p>') + '</article>' +
    '<article class="panel-card"><div class="home-section-heading"><h3>Recent work</h3></div>' +
    '<div class="home-work-group"><span class="home-work-label">Projects</span>' + recent(projects, "name", "projects", "Your project briefs will appear here.") + '</div>' +
    '<div class="home-work-group"><span class="home-work-label">Learning</span>' + recent(learning, "topic", "learning", "Your learning plans will appear here.") + '</div>' +
    '<div class="home-work-group"><span class="home-work-label">Research</span>' + recent(research, "question", "research", "Your research questions will appear here.") + '</div></article></section>' +
    '<p class="home-footnote">Your workspace stays under your control. Home summarizes existing records only; SPARKLE will not create tasks or goals for you automatically.</p>';
}
