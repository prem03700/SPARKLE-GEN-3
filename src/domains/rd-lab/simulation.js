/** Safe deterministic browser-side models for R&D Lab. No arbitrary code execution. */
export const SIMULATION_MODELS = [
  {id:"pendulum",name:"Pendulum dynamics",domain:"Physics / control",description:"Nonlinear damped pendulum with gravity and adjustable release angle."},
  {id:"robot-arm",name:"2-link robot arm",domain:"Robotics",description:"Planar two-joint arm with live joint motion and end-effector trace."},
  {id:"pid",name:"PID motor response",domain:"Control systems",description:"First-order motor plant with a bounded PID controller and setpoint tracking."},
  {id:"particles",name:"Swarm / particle field",domain:"AI / autonomous systems",description:"Deterministic agents steer around a target and simple obstacles."}
];
export function createSimulation(model="pendulum",params={}) {
  const p={gravity:Number(params.gravity??9.81),damping:Number(params.damping??0.12),length:Number(params.length??1.6),gain:Number(params.gain??2.2),speed:Number(params.speed??1),angle:Number(params.angle??55)};
  return {model,params:p,time:0,steps:0,energy:0,angle:p.angle*Math.PI/180,omega:0,theta1:-0.75,theta2:1.0,theta1v:0,theta2v:0,position:0,velocity:0,integral:0,previousError:1,agents:Array.from({length:14},(_,i)=>({x:35+(i*47)%470,y:45+(i*31)%245,vx:((i%3)-1)*.45,vy:((i%4)-1.5)*.3})),trace:[],running:false};
}
export function stepSimulation(s,dt=1/60) {
  dt=Math.min(.025,Math.max(0,dt)); const p=s.params;
  if(s.model==="pendulum"){
    const a=-(p.gravity/Math.max(.2,p.length))*Math.sin(s.angle)-p.damping*s.omega;
    s.omega+=a*dt;s.angle+=s.omega*dt;
    s.energy=.5*s.omega*s.omega*p.length*p.length+p.gravity*p.length*(1-Math.cos(s.angle));
  } else if(s.model==="robot-arm"){
    const target1=-.8+.48*Math.sin(s.time*.7*p.speed),target2=1.0+.58*Math.sin(s.time*1.1*p.speed);
    s.theta1v+=(14*(target1-s.theta1)-4*s.theta1v)*dt;s.theta2v+=(12*(target2-s.theta2)-3.4*s.theta2v)*dt;
    s.theta1+=s.theta1v*dt;s.theta2+=s.theta2v*dt;s.energy=.5*(s.theta1v*s.theta1v+s.theta2v*s.theta2v);
  } else if(s.model==="pid"){
    const error=1-s.position;s.integral=Math.max(-3,Math.min(3,s.integral+error*dt));
    const derivative=(error-s.previousError)/Math.max(dt,.0001);s.previousError=error;
    const control=Math.max(-4,Math.min(4,p.gain*error+.22*s.integral+.035*derivative));
    const accel=(control-1.3*s.velocity-.8*s.position)*2.4;s.velocity+=accel*dt;s.position+=s.velocity*dt;
    s.energy=.5*s.velocity*s.velocity+.4*(1-s.position)*(1-s.position);
  } else {
    const target={x:250+75*Math.cos(s.time*.18*p.speed),y:150+55*Math.sin(s.time*.18*p.speed)};
    for(let i=0;i<s.agents.length;i++){const a=s.agents[i],dx=target.x-a.x,dy=target.y-a.y,d=Math.hypot(dx,dy)||1;
      a.vx+=dx/d*.12*dt;a.vy+=dy/d*.12*dt;
      a.vx*=.997;a.vy*=.997;const v=Math.hypot(a.vx,a.vy)||1;if(v>1.6){a.vx=a.vx/v*1.6;a.vy=a.vy/v*1.6;}
      a.x=Math.max(8,Math.min(492,a.x+a.vx*60*dt));a.y=Math.max(8,Math.min(292,a.y+a.vy*60*dt));}
    s.energy=s.agents.reduce((n,a)=>n+a.vx*a.vx+a.vy*a.vy,0)/s.agents.length;
  }
  s.time+=dt;s.steps++;if(s.model!=="particles"){const v=s.model==="pendulum"?s.angle:s.model==="robot-arm"?s.theta1+s.theta2:s.position;s.trace.push({t:s.time,v});if(s.trace.length>180)s.trace.shift();}
  return s;
}
export function drawSimulation(canvas,s) {
  if(!canvas||!s)return;const ctx=canvas.getContext("2d");if(!ctx)return;const w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue("--surface").trim()||"#fff";ctx.fillRect(0,0,w,h);
  ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue("--line").trim()||"#ddd";ctx.lineWidth=1;
  for(let x=20;x<w;x+=30){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=20;y<h;y+=30){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  const accent=getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#53684d";
  const ink=getComputedStyle(document.documentElement).getPropertyValue("--text").trim()||"#222";
  const line=(x1,y1,x2,y2,color=accent,width=3)=>{ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();};
  const dot=(x,y,r,color=accent)=>{ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();};
  if(s.model==="pendulum"){const ox=w*.5,oy=35,L=Math.min(h*.67,s.params.length*100),x=ox+Math.sin(s.angle)*L,y=oy+Math.cos(s.angle)*L;dot(ox,oy,5,ink);line(ox,oy,x,y,accent,4);dot(x,y,13,accent);ctx.fillStyle=ink;ctx.font="12px sans-serif";ctx.fillText("θ "+(s.angle*180/Math.PI).toFixed(1)+"°",12,20);}
  else if(s.model==="robot-arm"){const ox=w*.5,oy=h*.57,L1=100,L2=83,x1=ox+L1*Math.cos(s.theta1),y1=oy+L1*Math.sin(s.theta1),x2=x1+L2*Math.cos(s.theta1+s.theta2),y2=y1+L2*Math.sin(s.theta1+s.theta2);line(ox,oy,x1,y1,accent,10);line(x1,y1,x2,y2,ink,8);dot(ox,oy,8,ink);dot(x1,y1,8,accent);dot(x2,y2,7,accent);ctx.fillStyle=ink;ctx.font="12px sans-serif";ctx.fillText("Joint 1 "+(s.theta1*180/Math.PI).toFixed(0)+"°",12,20);ctx.fillText("Joint 2 "+(s.theta2*180/Math.PI).toFixed(0)+"°",12,38);}
  else if(s.model==="pid"){const y0=h*.76;line(18,y0,w-15,y0,"#8b8b8b",1);const y=Math.max(18,Math.min(h-18,y0-s.position*h*.55));line(20,y,w-20,y,accent,2);dot(w*.62,y,8,accent);ctx.fillStyle=ink;ctx.font="12px sans-serif";ctx.fillText("Setpoint 1.00 · Output "+s.position.toFixed(3),12,20);ctx.fillText("Error "+(1-s.position).toFixed(3),12,38);}
  else {const tx=w*.5+75*Math.cos(s.time*.18),ty=h*.5+55*Math.sin(s.time*.18);dot(tx,ty,8,ink);for(const a of s.agents){line(a.x,a.y,a.x-a.vx*9,a.y-a.vy*9,accent,1);dot(a.x,a.y,4,accent);}ctx.fillStyle=ink;ctx.font="12px sans-serif";ctx.fillText("Agents "+s.agents.length+" · moving target",12,20);}
  if(s.trace.length>2){const min=Math.min(...s.trace.map(p=>p.v)),max=Math.max(...s.trace.map(p=>p.v)),range=max-min||1;const x0=12,y0=h-24,ww=w-24,hh=18;ctx.beginPath();s.trace.forEach((p,i)=>{const x=x0+i/(s.trace.length-1)*ww,y=y0-(p.v-min)/range*hh;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.strokeStyle=ink;ctx.lineWidth=1.5;ctx.stroke();}
}
export function runExperimentSweep(model,parameter,values,base={}) {
  return values.map(value=>{const s=createSimulation(model,{...base,[parameter]:value});let peak=0,sum=0,n=0;for(let i=0;i<1800;i++){stepSimulation(s,1/120);const metric=model==="pendulum"?Math.abs(s.angle):model==="robot-arm"?Math.abs(s.theta1+s.theta2):model==="pid"?Math.abs(1-s.position):s.energy;peak=Math.max(peak,metric);sum+=metric*metric;n++;}
    return {parameter,value,model,duration:s.time,steps:s.steps,finalMetric:Number((model==="pid"?Math.abs(1-s.position):model==="pendulum"?Math.abs(s.angle):model==="robot-arm"?Math.abs(s.theta1+s.theta2):s.energy).toFixed(5)),peakMetric:Number(peak.toFixed(5)),rms:Number(Math.sqrt(sum/n).toFixed(5)),seed:1};
  });
}
