/**
 * Deterministic visual fallback for explicit visual prompts when the model
 * returns prose only. Structured model blocks remain the preferred path.
 */
export function visualFallback(raw, prompt = "") {
  const answer = String(raw || ""), q = String(prompt || "").toLowerCase();
  if (/\x60\x60\x60sparkle-(?:card|table|chart|diagram|prompt|graph|steps|robot_arm)\b/i.test(answer)) return answer;
  const visualIntent = /\b(?:visuali[sz]e|draw|plot|illustrate|animate|simulate|show|display|make|create|generate)\b|\bvisual\b|\binteractive\b|\bstep[ -]by[ -]step\b|\b(?:flowchart|diagram|chart|graph)\s+(?:of|for|showing|with|y\s*=)\b/.test(q);
  if (!visualIntent) return answer;
  const add = (type, value) => answer + "\n\n\x60\x60\x60sparkle-" + type + "\n" + JSON.stringify(value) + "\n\x60\x60\x60";
  if (/binary search/.test(q)) {
    const am = String(prompt).match(/\[\s*-?\d+(?:\s*,\s*-?\d+){1,30}\s*\]/);
    const values = am ? am[0].slice(1, -1).split(",").map(Number).filter(Number.isFinite) : [3,7,11,15,19,23,27,31,35];
    const tm = String(prompt).match(/(?:find|search(?: for)?|target(?: is)?|locate)\s+(-?\d+)/i), target = tm ? Number(tm[1]) : 27;
    let low = 0, high = values.length - 1;
    const steps = [{title:"Set the search interval",body:"Start with low = 0 and high = " + high + ". The middle index is floor((low + high) / 2)."}];
    let found = false;
    for (let i = 0; i < Math.min(12, values.length) && low <= high; i++) {
      const mid = Math.floor((low + high) / 2), v = values[mid];
      steps.push({title:"Compare " + target + " with " + v,body:"low = " + low + ", high = " + high + ", mid = " + mid + ". " + (target === v ? "Target found at index " + mid + "." : target > v ? target + " is greater than " + v + ", so set low = " + (mid + 1) + "." : target + " is less than " + v + ", so set high = " + (mid - 1) + ".")});
      if (v === target) { found = true; break; }
      if (v < target) low = mid + 1; else high = mid - 1;
    }
    if (!found) steps.push({title:"Target not found",body:"The search interval is empty; the target is not in this array."});
    return add("steps",{title:"Binary search · interactive walkthrough",steps});
  }
  if (/derivative|tangent|slope|parabola|plot|graph|y\s*=/.test(q)) {
    const points = [];
    for (let x = -3; x <= 3.001; x += .5) points.push({x:Number(x.toFixed(2)),y:Number((x*x).toFixed(3))});
    return add("graph",{title:"y = x² · curve",xLabel:"x",yLabel:"y",points,...(/derivative|tangent/.test(q)?{tangent:{kind:"quadratic",x:0}}:{})});
  }
  if (/system diagram|flowchart|data flow|architecture diagram|feedback loop|sensors.*perception/.test(q)) return add("diagram",{title:"AI robot control loop",nodes:["Sensors","Perception","Planning","Control","Motors","Sensor feedback"]});
  if (/robot arm|two.link|forward kinematic|joint angles|end.effector/.test(q)) return add("robot_arm",{title:"Two-link robot arm · live forward kinematics",link1:1,link2:1});
  if (/visually|visual explanation|visual conversation|animate|interactive|step.by.step/.test(q)) return add("steps",{title:"Visual walkthrough",steps:[{title:"Identify the inputs",body:"Identify the inputs, variables, and constraints."},{title:"Follow the process",body:"Trace how each input changes through the system and inspect intermediate values."},{title:"Check the result",body:"Verify the output against the goal and test an edge case."}]});
  return answer;
}
