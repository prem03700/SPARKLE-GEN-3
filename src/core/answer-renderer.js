const MAX_TEXT = 500;
const TYPES = new Set(["card", "table", "chart", "diagram", "prompt", "graph", "steps"]);

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
    return { ok: true, value: { type, title: clean(value.title, 160), xLabel: clean(value.xLabel, 60), yLabel: clean(value.yLabel, 60), points } };
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
    const coords = value.points.map(point => ({
      x: 28 + ((point.x - minX) / spanX) * 344,
      y: 156 - ((point.y - minY) / spanY) * 128
    }));
    const path = coords.map((point, i) => (i ? "L" : "M") + point.x.toFixed(2) + " " + point.y.toFixed(2)).join(" ");
    return (value.title ? '<h3 class="answer-block-title">' + e(value.title) + '</h3>' : "") +
      '<figure class="answer-line-graph"><svg viewBox="0 0 400 190" role="img" aria-label="' + e(value.title || "Line graph") + '" class="answer-graph-svg"><path class="answer-graph-grid" d="M28 28H372 M28 70H372 M28 113H372 M28 156H372 M28 28V156 M114 28V156 M200 28V156 M286 28V156 M372 28V156"/><path class="answer-graph-axis" d="M28 20V156H380"/><path class="answer-graph-line" pathLength="1" d="' + path + '"/>' +
      coords.map((point, i) => '<circle class="answer-graph-point" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="3.5"><title>' + e(value.points[i].label || ("(" + value.points[i].x + ", " + value.points[i].y + ")")) + '</title></circle>').join("") +
      '<text x="200" y="184" text-anchor="middle" class="answer-graph-label">' + e(value.xLabel) + '</text><text x="9" y="92" text-anchor="middle" class="answer-graph-label" transform="rotate(-90 9 92)">' + e(value.yLabel) + '</text></svg></figure>';
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
  const text = String(raw ?? "").replace(/\`\`\`sparkle-(card|table|chart|diagram|prompt|graph|steps)\s*\n([\s\S]*?)\n?\`\`\`/g, (whole, type, json) => {
    try {
      const parsed = JSON.parse(json);
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
