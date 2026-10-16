/** Read-only progress overview derived from existing persisted workspace records. */
export function progressView({state,names,pageHeading,escapeHTML}) {
  const list=value=>Array.isArray(value)?value:[];
  const tasks=list(state.tasks), goals=list(state.goals), projects=list(state.projects), learning=list(state.learningPlans);
  const research=list(state.researchDrafts), lab=list(state.labDrafts), knowledge=list(state.knowledge), conversations=list(state.conversations);
  const history=list(state.workspaceHistory);
  const topics=learning.flatMap(plan=>list(plan?.topics));
  const validAssessment=a=>a&&Number.isInteger(a.total)&&a.total>0&&Number.isInteger(a.correct)&&a.correct>=0&&a.correct<=a.total;
  const mastered=topics.filter(topic=>topic?.masteryStatus==="mastered"&&list(topic.assessments).some(a=>validAssessment(a)&&Math.round(a.correct/a.total*100)>=80&&typeof a.evidence==="string"&&a.evidence.trim().length>=30));
  const studySeconds=topics.reduce((sum,topic)=>sum+Math.max(0,Number(topic?.secondsStudied)||0),0);
  const assessmentCount=topics.reduce((sum,topic)=>sum+list(topic.assessments).filter(validAssessment).length,0);
  const completedTask=item=>Boolean(item&&(item.done===true||item.status==="completed"));
  const completedGoal=item=>Boolean(item&&(item.done===true||item.status==="completed"));
  const doneTasks=tasks.filter(completedTask).length, doneGoals=goals.filter(completedGoal).length;
  const pct=(done,total)=>total?Math.round(done/total*100):0;
  const metric=(label,value,detail,view)=>'<button type="button" class="panel-card progress-metric progress-metric-link" data-view="'+view+'" aria-label="Open '+escapeHTML(label)+' records"><span class="card-kicker">'+escapeHTML(label)+'</span><span class="metric">'+value+'</span><span class="progress-metric-detail">'+escapeHTML(detail)+'</span><span class="progress-open-link">View records ↗</span></button>';
  const meter=(label,done,total,view)=>'<div class="progress-track-row"><div class="progress-track-label"><span>'+escapeHTML(label)+'</span><strong>'+done+' / '+total+' ('+pct(done,total)+'%)</strong><button type="button" class="text-action" data-view="'+view+'">Open</button></div><div class="progress-track" role="progressbar" aria-label="'+escapeHTML(label)+' completion rate" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct(done,total)+'"><span style="width:'+pct(done,total)+'%"></span></div></div>';
  const range=state.progressRange||"all";
  const now=Date.now();
  const cutoff=range==="7d"?now-7*86400000:range==="30d"?now-30*86400000:range==="90d"?now-90*86400000:0;
  const inRange=date=>{const time=Date.parse(date||"");return Number.isFinite(time)&&time<=now&&(cutoff===0||time>=cutoff);};
  const events=[
    ...history.filter(item=>item&&inRange(item.createdAt)).map(item=>({kind:item.workspace||"Workspace",title:item.title||"Workspace activity",date:item.createdAt,detail:item.details||"Saved activity",view:({research:"research",knowledge:"knowledge",tasks:"tasks",goals:"tasks",learning:"learning",projects:"projects",lab:"lab",coding:"coding",chat:"chat",settings:"settings"})[item.workspace]||"home",id:item.id})),
    ...goals.flatMap(goal=>list(goal?.milestones).filter(m=>m?.done&&inRange(m.completedAt)).map(m=>({kind:"Milestone",title:m.title||"Completed milestone",date:m.completedAt,detail:"Completed · "+(goal.title||"Goal"),view:"tasks",id:goal.id}))),
    ...topics.flatMap(topic=>list(topic.assessments).filter(a=>a&&inRange(a.createdAt)).map(a=>({kind:"Learning assessment",title:topic.title||"Learning topic",date:a.createdAt,detail:validAssessment(a)?a.correct+" / "+a.total+" · learner-reported":"Assessment saved",view:"learning",id:topic.id})))
  ].sort((a,b)=>Date.parse(b.date||"")-Date.parse(a.date||"")).slice(0,12);
  const fmtDate=date=>{const parsed=Date.parse(date||"");return Number.isFinite(parsed)?new Date(parsed).toLocaleString():"Date unavailable";};
  return pageHeading("Overview","Progress","Read-only summaries of saved workspace records. Counts update from persisted data; activity history includes only events explicitly recorded by a workspace.")+
    '<section class="progress-filter panel-card"><label for="progressRange">Activity time range</label><select id="progressRange" aria-label="Filter progress activity by time range">'+[["all","All recorded history"],["7d","Last 7 days"],["30d","Last 30 days"],["90d","Last 90 days"]].map(([v,label])=>'<option value="'+v+'" '+(range===v?'selected':'')+'>'+label+'</option>').join("")+'</select><p class="muted">Time range filters dated activity events, completed milestones, and learning assessments. Summary totals cover all currently saved records.</p></section>'+
    '<section class="card-grid progress-cards" aria-label="Saved workspace metrics">'+
      metric("Tasks completed",doneTasks+'/'+tasks.length,tasks.length?pct(doneTasks,tasks.length)+'% of all saved tasks':'No tasks created yet','tasks')+
      metric("Goals completed",doneGoals+'/'+goals.length,goals.length?pct(doneGoals,goals.length)+'% of all saved goals':'No goals created yet','tasks')+
      metric("Projects",projects.length,"Saved project records","projects")+
      metric("Learning plans",learning.length,"Saved learning plans","learning")+
      metric("Mastered topics",mastered.length,topics.length+" total topics · evidence-based","learning")+
      metric("Study time",Math.floor(studySeconds/60)+" min",assessmentCount+" valid learner-reported assessments","learning")+
      metric("Research drafts",research.length,"Saved research questions","research")+
      metric("Knowledge notes",knowledge.length,"Saved notes","knowledge")+
      metric("R&D records",lab.length,"Saved lab and simulation records","lab")+
      metric("Conversations",conversations.length,"Saved conversations","chat")+
    '</section>'+
    '<section class="progress-section"><h2 class="section-title">Completion</h2><article class="panel-card progress-completion">'+meter("Tasks",doneTasks,tasks.length,"tasks")+meter("Goals",doneGoals,goals.length,"tasks")+'</article><p class="muted">Definition: completed means <code>done = true</code> or <code>status = completed</code>. The denominator includes every saved record in that category, including paused or archived records. Empty categories display 0% and 0 / 0; no completion rate is inferred.</p></section>'+
    '<section class="progress-section"><h2 class="section-title">Recent workspace activity</h2><article class="panel-card progress-activity">'+(events.length?events.map(item=>'<div class="list-row progress-event"><div class="row-main"><strong>'+escapeHTML(item.title)+'</strong><small>'+escapeHTML(item.kind)+' · '+escapeHTML(item.detail)+'</small></div><div class="progress-event-actions"><small>'+escapeHTML(fmtDate(item.date))+'</small><button type="button" class="text-action" data-view="'+escapeHTML(item.view)+'" aria-label="Open '+escapeHTML(item.kind)+' workspace">Open ↗</button></div></div>').join(""):'<p class="progress-empty">No recorded activity in this time range. New events appear here when a workspace records them; saved-record totals above remain available.</p>')+'</article></section>'+
    '<section class="progress-section"><h2 class="section-title">Metric definitions</h2><article class="panel-card progress-definitions"><p><strong>Completion rate:</strong> completed records divided by all saved records, rounded to the nearest whole percent.</p><p><strong>Mastery:</strong> a topic marked mastered with at least one valid assessment scoring 80% or higher and written evidence of at least 30 characters. Scores are learner-reported.</p><p><strong>Study time:</strong> sum of saved topic study seconds, shown in whole minutes. Assessment count includes only structurally valid assessments.</p><p><strong>Activity:</strong> persisted workspace-history events, completed milestone timestamps, and saved learning assessments. Entity creation/update timestamps are not presented as activity unless a corresponding event exists.</p></article></section>';
}
