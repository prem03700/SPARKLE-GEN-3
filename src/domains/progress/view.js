/** Read-only progress overview derived from existing workspace records. */
export function progressView({state,names,pageHeading,escapeHTML}) {
  const tasks=Array.isArray(state.tasks)?state.tasks:[];
  const goals=Array.isArray(state.goals)?state.goals:[];
  const projects=Array.isArray(state.projects)?state.projects:[];
  const learning=Array.isArray(state.learningPlans)?state.learningPlans:[];
  const research=Array.isArray(state.researchDrafts)?state.researchDrafts:[];
  const lab=Array.isArray(state.labDrafts)?state.labDrafts:[];
  const knowledge=Array.isArray(state.knowledge)?state.knowledge:[];
  const learningTopics=learning.flatMap(plan=>Array.isArray(plan?.topics)?plan.topics:[]);
  const masteredTopics=learningTopics.filter(topic=>topic?.masteryStatus==="mastered"&&Array.isArray(topic.assessments)&&topic.assessments.some(a=>a&&Number.isInteger(a.total)&&a.total>0&&Number.isInteger(a.correct)&&a.correct>=0&&a.correct<=a.total&&typeof a.evidence==="string"&&a.evidence.trim().length>=30&&Math.round(a.correct/a.total*100)>=80));
  const studySeconds=learningTopics.reduce((sum,topic)=>sum+Math.max(0,Number(topic?.secondsStudied)||0),0);
  const assessmentCount=learningTopics.reduce((sum,topic)=>sum+(Array.isArray(topic?.assessments)?topic.assessments.length:0),0);
  const conversations=Array.isArray(state.conversations)?state.conversations:[];
  const doneTasks=tasks.filter(item=>item&&item.done).length;
  const doneGoals=goals.filter(item=>item&&item.done).length;
  const pct=(done,total)=>total?Math.round(done/total*100):0;
  const metric=(label,value,detail)=>'<article class="panel-card progress-metric"><div class="card-kicker">'+escapeHTML(label)+'</div><div class="metric">'+value+'</div><p>'+escapeHTML(detail)+'</p></article>';
  const meter=(label,done,total)=>'<div class="progress-track-row"><div class="progress-track-label"><span>'+escapeHTML(label)+'</span><strong>'+done+' / '+total+'</strong></div><div class="progress-track" role="progressbar" aria-label="'+escapeHTML(label)+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct(done,total)+'"><span style="width:'+pct(done,total)+'%"></span></div></div>';
  const recent=[
    ...tasks.map(item=>({kind:"Task",title:item?.title||"Untitled task",date:item?.updatedAt||item?.createdAt,detail:item?.done?"Completed":"Open"})),
    ...goals.map(item=>({kind:"Goal",title:item?.title||"Untitled goal",date:item?.updatedAt||item?.createdAt,detail:item?.done?"Completed":"In progress"})),
    ...projects.map(item=>({kind:"Project",title:item?.name||"Untitled project",date:item?.updatedAt||item?.createdAt,detail:"Brief saved"})),
    ...learning.map(item=>({kind:"Learning",title:item?.topic||"Learning plan",date:item?.updatedAt||item?.createdAt,detail:item?.level||"Plan saved"})),
    ...research.map(item=>({kind:"Research",title:item?.question||"Research draft",date:item?.updatedAt||item?.createdAt,detail:"Draft saved"})),
    ...lab.map(item=>({kind:"R&D",title:item?.question||item?.hypothesis||"Experiment draft",date:item?.updatedAt||item?.createdAt,detail:"Draft saved"})),
    ...knowledge.map(item=>({kind:"Knowledge",title:item?.title||"Untitled note",date:item?.updatedAt||item?.createdAt,detail:"Note saved"})),
    ...conversations.map(item=>({kind:names[item?.assistant]||"Conversation",title:item?.title||"Conversation",date:item?.updatedAt,detail:"Conversation"}))
  ].filter(item=>item.title).sort((a,b)=>(Date.parse(b.date||"")||0)-(Date.parse(a.date||"")||0)).slice(0,6);
  return pageHeading("Overview","Progress","A live summary of your existing workspace. These numbers are calculated from saved records; this page does not create or change tasks, goals, or plans.")+
    '<section class="card-grid progress-cards">'+
      metric("Tasks completed",doneTasks+'/'+tasks.length,tasks.length?pct(doneTasks,tasks.length)+'% complete':'No tasks created yet')+
      metric("Goals completed",doneGoals+'/'+goals.length,goals.length?pct(doneGoals,goals.length)+'% complete':'No goals created yet')+
      metric("Project briefs",projects.length,"Saved projects")+
      metric("Learning plans",learning.length,"Saved learning plans")+
      metric("Mastered topics",masteredTopics.length,learningTopics.length+" ordered topics · evidence required")+
      metric("Study time",Math.floor(studySeconds/60)+" min",assessmentCount+" learner-reported assessments")+
      metric("Research drafts",research.length,"Saved research questions")+
      metric("Knowledge notes",knowledge.length,"Saved notes")+
      metric("R&D drafts",lab.length,"Saved lab drafts")+
      metric("Conversations",conversations.length,"Saved conversations")+
    '</section>'+
    '<section class="progress-section"><h2 class="section-title">Completion</h2><article class="panel-card progress-completion">'+meter("Tasks",doneTasks,tasks.length)+meter("Goals",doneGoals,goals.length)+'</article></section>'+
    '<section class="progress-section"><h2 class="section-title">Recent workspace activity</h2><article class="panel-card progress-activity">'+(recent.length?recent.map(item=>'<div class="list-row"><div class="row-main"><strong>'+escapeHTML(item.title)+'</strong><small>'+escapeHTML(item.kind)+' · '+escapeHTML(item.detail)+'</small></div><small>'+escapeHTML(item.date?new Date(item.date).toLocaleDateString():"Saved")+'</small></div>').join(""):'<p class="progress-empty">Nothing here yet. Start with a task, goal, learning plan, project brief, or Knowledge note.</p>')+'</article></section>';
}
