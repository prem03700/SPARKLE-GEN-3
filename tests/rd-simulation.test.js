import test from "node:test";
import assert from "node:assert/strict";
import { SIMULATION_MODELS, createSimulation, stepSimulation, runExperimentSweep } from "../src/domains/rd-lab/simulation.js";

test("registered R&D models advance deterministically with finite state", () => {
  assert.equal(SIMULATION_MODELS.length, 4);
  for (const model of SIMULATION_MODELS) {
    const a=createSimulation(model.id), b=createSimulation(model.id);
    for(let i=0;i<240;i++){stepSimulation(a,1/120);stepSimulation(b,1/120);}
    assert.equal(a.steps,240,model.id+" should count steps");
    assert.equal(a.time,b.time,model.id+" should be deterministic");
    assert.equal(a.energy,b.energy,model.id+" should reproduce the same output");
    assert.ok(Number.isFinite(a.energy),model.id+" energy/activity must stay finite");
    assert.ok(a.time>0);
  }
});

test("parameter sweeps are bounded, repeatable, and return metrics", () => {
  const rows=runExperimentSweep("pendulum","damping",[0,.1,.5,1,1.2],{angle:30,gravity:9.81,length:1.4});
  assert.equal(rows.length,5);
  assert.ok(rows.every(row=>row.steps===1800&&row.seed===1&&Number.isFinite(row.rms)&&Number.isFinite(row.finalMetric)));
  assert.deepEqual(rows,runExperimentSweep("pendulum","damping",[0,.1,.5,1,1.2],{angle:30,gravity:9.81,length:1.4}));
});

test("PID model responds to setpoint and robot-arm model produces motion", () => {
  const pid=createSimulation("pid");
  for(let i=0;i<1200;i++)stepSimulation(pid,1/120);
  assert.ok(Math.abs(1-pid.position)<1,"PID model should respond toward setpoint");
  const arm=createSimulation("robot-arm"),start=arm.theta1;
  for(let i=0;i<240;i++)stepSimulation(arm,1/60);
  assert.notEqual(arm.theta1,start,"robot arm joints should move");
});
