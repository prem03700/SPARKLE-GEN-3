const MAX_TEXT = 500;
const TYPES = new Set(["card", "table", "chart", "diagram", "prompt", "graph", "steps", "robot_arm"]);
const minGraphX = points => Math.min(...points.map(point => point.x));
const maxGraphX = points => Math.max(...points.map(point => point.x));

export function validateAnswerBlock(value, expectedType = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Expected an object." };
  const type = expectedType || value.type;
  if (!TYPES.has(type)) return { ok: false, error: "Unsupported block type." };
  const clean = (v, limit = MAX_TEXT) => typeof v === "string" ? v.trim().slice(0, limit) : "";
  if (type === "card") {
    const title = clean(value.title, 160), body = clean(value.body, 2000);
    const bullets = Array.isArray(value.bullets) ? value.bullets.slice(0, 8).map(v => clean(v, 240)).filter(Boolean) : [];
    const prompt = clean(value.prompt, 1000);
    if (!title || (!body && !bullets.length)) return { ok: false, error: "A card needs a title and body or bullets." };
    return { ok: true, value: { type, title, body, bullets, prompt } };
  }
  if (type === "table") {
    const columns = Array.isArray(value.columns) ? value.columns.slice(0, 6).map(v => clean(v, 80)) : [];
    if (!columns.length || columns.some(v => !v) || !Array.isArray(value.rows) || value.rows.length > 30) return { ok: false, error: "A table needs 1–6 columns and at most 30 rows." };
    const rows = value.rows.map(row => Array.isArray(row) ? columns.map((_, i) => clean(row[i], 500)) : null);
    if (rows.some(row => !row)) return { ok: false, error: "Table rows must be arrays." };
    return { ok: true, value: { type, title: clean(value.title, 160), columns, rows } };
  }
  if (type === "chart") {
    const items = Array.isArray(value.items) ? value.items.slice(0, 12).map(item => ({
      label: clean(item?.label, 80),
      value: item?.value
    })) : [];
    if (!items.length || items.some(item => !item.label || typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < 0 || item.value > 1e12)) return { ok: false, error: "A chart needs 1–12 labels and finite non-negative numeric values." };
    return { ok: true, value: { type, title: clean(value.title, 160), items } };
  }
  if (type === "diagram") {
    const nodes = Array.isArray(value.nodes) ? value.nodes.slice(0, 12).map(v => clean(v, 120)) : [];
    if (nodes.length < 2 || nodes.some(v => !v)) return { ok: false, error: "A diagram needs 2–12 non-empty nodes." };
    return { ok: true, value: { type, title: clean(value.title, 160), nodes } };
  }
  if (type === "graph") {
    const points = Array.isArray(value.points) ? value.points.slice(0, 24).map(point => ({
      x: point?.x, y: point?.y, label: clean(point?.label, 60)
    })) : [];
    if (points.length < 2 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e9 || Math.abs(point.y) > 1e9)) {
      return { ok: false, error: "A graph needs 2–24 points with finite numeric x and y values." };
    }
    let tangent = null;
    if (value.tangent !== undefined) {
      if (!value.tangent || typeof value.tangent !== "object" || value.tangent.kind !== "quadratic") return { ok: false, error: "Graph tangent must use a supported function model." };
      const x = value.tangent.x === undefined ? 0 : value.tangent.x;
      if (!Number.isFinite(x) || x < minGraphX(points) || x > maxGraphX(points)) return { ok: false, error: "Tangent position must fall inside the plotted x range." };
      tangent = { kind: "quadratic", x };
    }
    return { ok: true, value: { type, title: clean(value.title, 160), xLabel: clean(value.xLabel, 60), yLabel: clean(value.yLabel, 60), points, tangent } };
  }
  if (type === "robot_arm") {
    const link1=Number(value.link1),link2=Number(value.link2);
    if (![link1,link2].every(n=>Number.isFinite(n)&&n>0&&n<=10)) return {ok:false,error:"Robot link lengths must be positive and at most 10."};
    return {ok:true,value:{type,title:clean(value.title,160)||"Two-link robot arm",link1,link2}};
  }
  if (type === "steps") {
    const steps = Array.isArray(value.steps) ? value.steps.slice(0, 12).map((step, index) => ({
      title: clean(step?.title, 120), body: clean(step?.body, 500), index
    })) : [];
    if (steps.length < 2 || steps.some(step => !step.title || !step.body)) return { ok: false, error: "An animated explanation needs 2–12 steps with a title and explanation." };
    return { ok: true, value: { type, title: clean(value.title, 160), steps } };
  }
  const text = clean(value.text || value.prompt, 1000);
  if (!text) return { ok: false, error: "A prompt block needs text." };
  return { ok: true, value: { type, text } };
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function renderAnswerBlock(input, expectedType = "") {
  const checked = validateAnswerBlock(input, expectedType);
  if (!checked.ok) return "";
  const value = checked.value, e = escapeHTML;
  if (value.type === "card") {
    return '<section class="answer-card"><h3>' + e(value.title) + '</h3>' + (value.body ? '<p>' + e(value.body) + '</p>' : "") +
      (value.bullets.length ? '<ul>' + value.bullets.map(item => '<li>' + e(item) + '</li>').join("") + '</ul>' : "") +
      (value.prompt ? '<button type="button" class="answer-prompt-button" data-answer-prompt="' + e(value.prompt) + '">Use as next message ↗</button>' : "") + '</section>';
  }
  if (value.type === "table") {
    return (value.title ? '<h3 class="answer-block-title">' + e(value.title) + '</h3>' : "") +
      '<div class="answer-table-wrap"><table class="answer-table"><thead><tr>' + value.columns.map(c => '<th scope="col">' + e(c) + '</th>').join("") + '</tr></thead><tbody>' +
      value.rows.map(row => '<tr>' + row.map(cell => '<td>' + e(cell) + '</td>').join("") + '</tr>').join("") + '</tbody></table></div>';
  }
  if (value.type === "chart") {
    const max = Math.max(1, ...value.items.map(item => item.value));
    return (value.title ? '<h3 class="answer-block-title">' + e(value.title) + '</h3>' : "") +
      '<figure class="answer-chart" role="img" aria-label="' + e(value.title || "Bar chart") + '">' + value.items.map(item =>
        '<div class="answer-chart-row"><span class="answer-chart-label">' + e(item.label) + '</span><span class="answer-chart-track"><span class="answer-chart-bar" style="width:' + Math.round(item.value / max * 100) + '%"></span></span><strong>' + e(item.value) + '</strong></div>'
      ).join("") + '</figure>';
  }
  if (value.type === "diagram") {
    return (value.title ? '<h3 class="answer-block-title">' + e(value.title) + '</h3>' : "") +
      '<ol class="answer-diagram" aria-label="' + e(value.title || "Process diagram") + '">' + value.nodes.map((node, i) =>
        '<li><span>' + e(node) + '</span>' + (i < value.nodes.length - 1 ? '<span class="answer-diagram-arrow" aria-hidden="true">↓</span>' : "") + '</li>'
      ).join("") + '</ol>';
  }
  if (value.type === "graph") {
    const xs = value.points.map(point => point.x), ys = value.points.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const mapX = x => 28 + ((x - minX) / spanX) * 344;
    const mapY = y => 156 - ((y - minY) / spanY) * 128;
    const coords = value.points.map(point => ({ x: mapX(point.x), y: mapY(point.y) }));
    const path = coords.map((point, i) => (i ? "L" : "M") + point.x.toFixed(2) + " " + point.y.toFixed(2)).join(" ");
    let tangent = "";
    let controls = "";
    if (value.tangent) {
      const a = value.tangent.x;
      tangent = '<path data-tangent-line class="answer-tangent-line" d="M ' + mapX(minX).toFixed(2) + ' ' + mapY(2*a*minX-a*a).toFixed(2) + ' L ' + mapX(maxX).toFixed(2) + ' ' + mapY(2*a*maxX-a*a).toFixed(2) + '"/>' +
        '<circle data-tangent-point class="answer-tangent-point" cx="' + mapX(a).toFixed(2) + '" cy="' + mapY(a*a).toFixed(2) + '" r="5"/>';
      controls = '<div class="answer-tangent-controls" data-tangent-graph data-min-x="' + minX + '" data-max-x="' + maxX + '" data-min-y="' + minY + '" data-max-y="' + maxY + '" data-initial-x="' + a + '">' +
        '<label>Tangent point x = <output data-tangent-value>' + a + '</output><input data-tangent-slider type="range" min="' + minX + '" max="' + maxX + '" step="0.1" value="' + a + '" aria-label="Move tangent point along the curve"/></label>' +
        '<p data-tangent-slope aria-live="polite">At x = ' + a + ', slope f′(x) = ' + (2*a) + '</p><button type="button" class="soft-button" data-tangent-reset>Reset tangent</button></div>';
    }
    return (value.title ? '<h3 class="answer-block-title">' + e(value.title) + '</h3>' : "") +
      '<figure class="answer-line-graph"><svg viewBox="0 0 400 190" role="img" aria-label="' + e(value.title || "Line graph") + '" class="answer-graph-svg"><path class="answer-graph-grid" d="M28 28H372 M28 70H372 M28 113H372 M28 156H372 M28 28V156 M114 28V156 M200 28V156 M286 28V156 M372 28V156"/><path class="answer-graph-axis" d="M28 20V156H380"/><path class="answer-graph-line" pathLength="1" d="' + path + '"/>' +
      coords.map((point, i) => '<circle class="answer-graph-point" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="3.5"><title>' + e(value.points[i].label || ("(" + value.points[i].x + ", " + value.points[i].y + ")")) + '</title></circle>').join("") +
      tangent + '<text x="200" y="184" text-anchor="middle" class="answer-graph-label">' + e(value.xLabel) + '</text><text x="9" y="92" text-anchor="middle" class="answer-graph-label" transform="rotate(-90 9 92)">' + e(value.yLabel) + '</text></svg>' + controls + '</figure>';
  }
  if (value.type === "robot_arm") {
    return '<section class="answer-robot-arm" data-robot-arm data-link1="'+value.link1+'" data-link2="'+value.link2+'"><h3 class="answer-block-title">'+e(value.title)+'</h3><p>Move the joint sliders. The arm and end-effector coordinates update from forward kinematics.</p><div class="robot-arm-controls"><label>Base angle θ₁ <output data-angle1>45°</output><input type="range" min="-180" max="180" value="45" step="1" data-angle="1" aria-label="Base joint angle"></label><label>Elbow angle θ₂ <output data-angle2>35°</output><input type="range" min="-180" max="180" value="35" step="1" data-angle="2" aria-label="Elbow joint angle"></label></div><svg class="robot-arm-svg" viewBox="-2.5 -2.5 5 5" role="img" aria-label="Interactive two-link robot arm"><path class="robot-grid" d="M-2 0H2 M0 -2V2"/><circle class="robot-base" cx="0" cy="0" r=".07"/><path data-arm-link1 class="robot-link" d="M0 0L0 0"/><path data-arm-link2 class="robot-link robot-link-secondary" d="M0 0L0 0"/><circle data-arm-elbow class="robot-joint" cx="0" cy="0" r=".07"/><circle data-arm-tip class="robot-tip" cx="0" cy="0" r=".06"/></svg><p aria-live="polite">End effector: <strong data-arm-coordinates>(—, —)</strong></p><p class="robot-arm-equations">x = L₁ cos θ₁ + L₂ cos(θ₁ + θ₂)<br>y = L₁ sin θ₁ + L₂ sin(θ₁ + θ₂)</p><button type="button" class="soft-button" data-arm-reset>Reset angles</button></section>';
  }
  if (value.type === "steps") {
    return '<section class="answer-steps" data-answer-steps><h3 class="answer-block-title">' + e(value.title || "Step-by-step explanation") + '</h3><div class="answer-step-progress" role="status" aria-live="polite">Step 1 of ' + value.steps.length + '</div>' +
      value.steps.map((step, i) => '<div class="answer-step-body" data-step-panel="' + i + '"' + (i ? ' hidden' : '') + '><span class="answer-step-number">' + String(i + 1).padStart(2, "0") + '</span><h4>' + e(step.title) + '</h4><p>' + e(step.body) + '</p></div>').join("") +
      '<div class="answer-step-controls"><button type="button" class="soft-button" data-step-prev disabled>← Previous</button><button type="button" class="soft-button" data-step-next>Next step →</button></div>' +
      '<ol class="answer-step-track">' + value.steps.map((step, i) => '<li><button type="button" data-step-index="' + i + '" aria-label="Show step ' + (i + 1) + ': ' + e(step.title) + '" aria-current="' + (i === 0 ? "step" : "false") + '">' + (i + 1) + '</button></li>').join("") + '</ol></section>';
  }
  return '<section class="answer-prompt"><p>' + e(value.text) + '</p><button type="button" class="answer-prompt-button" data-answer-prompt="' + e(value.text) + '">Use as next message ↗</button></section>';
}

/** Recognizes only explicit fenced SPARKLE JSON blocks; invalid blocks remain ordinary code. */
export function prepareStructuredAnswer(raw) {
  const blocks = [];
  const text = String(raw ?? "").replace(/\`\`\`(sparkle-(?:card|table|chart|diagram|prompt|graph|steps|robot_arm)|json)\s*\n([\s\S]*?)\n?\`\`\`/g, (whole, language, json) => {
    try {
      const parsed = JSON.parse(json);
      let type = language.startsWith("sparkle-") ? language.slice(8) : String(parsed.type || "");
      // Some models return the documented visual schema in a generic JSON fence
      // rather than the required sparkle-* fence. Upgrade only recognized,
      // validated schemas; unrelated JSON remains a normal code block.
      if (language === "json" && type === "diagram" && !Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        const ordered = [];
        for (const edge of parsed.edges.slice(0, 12)) {
          if (!Array.isArray(edge) || edge.length < 2) continue;
          const from = String(edge[0]).slice(0, 120), to = String(edge[1]).slice(0, 120);
          if (from && !ordered.includes(from)) ordered.push(from);
          if (to && !ordered.includes(to)) ordered.push(to);
        }
        parsed.nodes = ordered;
      }
      if (language === "json" && !["card", "table", "chart", "diagram", "prompt", "graph", "steps", "robot_arm"].includes(type)) return whole;
      const html = renderAnswerBlock(parsed, type);
      if (!html) return whole;
      const token = "SPARKLEANSWERBLOCKTOKEN" + blocks.length + "END";
      blocks.push({ token, html });
      return token;
    } catch {
      return whole;
    }
  });
  return { text, blocks };
}

export function renderPreparedAnswer(html, blocks) {
  let result = String(html ?? "");
  for (const block of blocks || []) result = result.replace("<p>" + block.token + "</p>", block.html).replace(block.token, block.html);
  return result;
}
