import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const projectRoot = join(import.meta.dirname, "..");
const profile = mkdtempSync(join(tmpdir(), "sparkle-gen3-browser-test-"));
const serverRoot = mkdtempSync(join(tmpdir(), "sparkle-gen3-server-test-"));
let baseURL;
let serverHandle;
let processHandle;
let socket;
let sessionId;
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];

function cdp(method, params = {}, targetSession = sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome DevTools timed out: ${method}`));
    }, 6000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }));
  });
}

async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Browser JavaScript failed");
  return response.result?.value;
}

try {
  cpSync(join(projectRoot, "server.py"), join(serverRoot, "server.py"));
  cpSync(join(projectRoot, "index.html"), join(serverRoot, "index.html"));
  cpSync(join(projectRoot, "src"), join(serverRoot, "src"), { recursive: true });
  const portProbe = createServer();
  await new Promise((resolve, reject) => portProbe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const appPort = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  baseURL = `http://127.0.0.1:${appPort}`;
  serverHandle = spawn("python3", ["server.py"], {
    cwd: serverRoot,
    env: { ...process.env, SPARKLE_HOST: "127.0.0.1", SPARKLE_PORT: String(appPort), SPARKLE_MODEL_PROVIDER: "ollama", SPARKLE_MODEL: "qwen3:8b" },
    stdio: "ignore"
  });
  let serverReady = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(baseURL); if (response.ok) { serverReady = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(serverReady, "isolated temporary SPARKLE server should start");
  const setupResponse = await fetch(`${baseURL}/api/setup-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(setupResponse.status, 200, "host should be able to generate a one-time pairing code");
  const pairingCode = (await setupResponse.json()).code;

  processHandle = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) { port = Number(readFileSync(portFile, "utf8").split("\n")[0]); break; }
    await delay(100);
  }
  assert.ok(port, "Chrome DevTools should start with an isolated temporary profile");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails?.text || "Browser runtime exception");
    if (message.method === "Page.javascriptDialogOpening") {
      cdp("Page.handleJavaScriptDialog", { accept: true, promptText: "SPARKLE browser smoke task" }).catch(() => {});
    }
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      clearTimeout(item.timer);
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
  };
  const target = await cdp("Target.createTarget", { url: baseURL }, null);
  sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }, null)).sessionId;
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  let loaded = false;
  for (let i = 0; i < 100; i++) {
    loaded = await evaluate('document.readyState === "complete" && !!document.querySelector("#viewRoot")');
    if (loaded) break;
    await delay(100);
  }
  assert.ok(loaded, "SPARKLE main view should load");
  assert.match(await evaluate("document.title"), /SPARKLE GEN-3/);
  assert.equal(await evaluate('!!document.querySelector("[data-action=toggle-voice]")'), true, "voice control should render");
  assert.equal(await evaluate('!!document.querySelector("[data-action=export-data]") || (document.querySelector("[data-view=settings]") !== null)'), true, "settings navigation should render");

  // Verify theme persistence controls, collapsible desktop navigation, and a
  // narrow mobile viewport before exercising application workflows.
  const originalTheme = await evaluate('document.documentElement.dataset.theme');
  await evaluate('document.querySelector("#themeToggle").click()');
  assert.notEqual(await evaluate('document.documentElement.dataset.theme'), originalTheme, "theme toggle should switch light/dark theme");
  await evaluate('document.querySelector("#themeToggle").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), originalTheme, "theme toggle should restore the original theme");
  assert.ok(await evaluate('getComputedStyle(document.body).fontFamily.includes("system-ui")'), "UI should use the system font stack without relying on a missing remote font");
  await evaluate('document.querySelector("[data-view=settings]").click()');
  await evaluate('document.querySelector("#densitySelect").value = "Compact"; document.querySelector("[data-action=save-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.density'), "compact", "Compact density should apply a real CSS preset");
  const compactPadding = await evaluate('getComputedStyle(document.querySelector(".panel-card")).padding');
  await evaluate('document.querySelector("#densitySelect").value = "Spacious"; document.querySelector("[data-action=save-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.density'), "spacious", "Spacious density should apply a real CSS preset");
  const spaciousPadding = await evaluate('getComputedStyle(document.querySelector(".panel-card")).padding');
  assert.notEqual(compactPadding, spaciousPadding, "density presets should change layout spacing");
  await evaluate('document.querySelector("#densitySelect").value = "Comfortable"; document.querySelector("[data-action=save-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.density'), "comfortable", "browser smoke should restore the default density");
  await evaluate('document.querySelector("[data-view=chat]").click()');
  await evaluate('document.querySelector("#collapseSidebar").click()');
  assert.equal(await evaluate('document.body.classList.contains("sidebar-collapsed")'), true, "desktop sidebar should collapse");
  await evaluate('document.querySelector("#collapseSidebar").click()');
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(100);
  const mobileLayout = await evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,menuVisible:getComputedStyle(document.querySelector("#mobileMenu")).display!=="none"})');
  assert.equal(mobileLayout.menuVisible, true, "mobile navigation control should be visible on a phone-sized viewport");
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.width, "phone-sized layout should not overflow horizontally");
  await evaluate('document.querySelector("#mobileMenu").click()');
  assert.equal(await evaluate('document.body.classList.contains("mobile-nav-open")'), true, "mobile navigation should open");
  await evaluate('document.querySelector("#mobileScrim").click()');
  assert.equal(await evaluate('document.body.classList.contains("mobile-nav-open")'), false, "mobile navigation should close from the scrim");
  await cdp("Emulation.clearDeviceMetricsOverride", {});

  const views = await evaluate('Array.from(document.querySelectorAll("[data-view]")).filter(b => b.tagName === "BUTTON").map(b => b.dataset.view).filter((v, i, a) => a.indexOf(v) === i)');
  assert.ok(views.length >= 9, `expected all major workspaces to be navigable, found ${views.length}`);
  for (const view of views) {
    await evaluate(`document.querySelector('[data-view="${view}"]').click()`);
    await delay(40);
    const contentLength = await evaluate('document.querySelector("#viewRoot")?.innerText.trim().length || 0');
    assert.ok(contentLength > 20, `workspace ${view} should render useful content`);
  }
  await evaluate('document.querySelector("[data-lab-tab]")?.click()');
  assert.deepEqual(runtimeErrors, [], `workspaces should not throw browser runtime exceptions: ${runtimeErrors.join("; ")}`);

  await evaluate('document.querySelector("[data-view=settings]").click()');
  await evaluate(`document.querySelector("#deviceName").value = "Isolated browser test"; document.querySelector("#pairingCode").value = ${JSON.stringify(pairingCode)}; document.querySelector("[data-action=pair-device]").click()`);
  let paired = false;
  for (let i = 0; i < 100; i++) {
    paired = await evaluate('document.body.innerText.includes("Paired · private server")');
    if (paired) break;
    await delay(100);
  }
  assert.ok(paired, "browser should pair successfully against the isolated private server");

  await evaluate('document.querySelector("[data-view=tasks]").click()');
  await delay(100);
  await evaluate('document.querySelector("[data-action=new-task]").click()');
  await delay(150);
  let state = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")');
  assert.ok(state.tasks?.some(task => task.title === "SPARKLE browser smoke task"), "task creation should persist to browser storage");
  const token = await evaluate('localStorage.getItem("sparkle-auth-token")');
  assert.ok(token, "paired browser should hold a device token");
  let serverData;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, "paired browser token should read the private workspace");
    serverData = await response.json();
    if (serverData.data.tasks?.some(task => task.title === "SPARKLE browser smoke task")) break;
    await delay(100);
  }
  assert.ok(serverData.data.tasks?.some(task => task.title === "SPARKLE browser smoke task"), "task should sync to the server database");

  // Exercise goal, learning-plan, project-brief, and R&D draft creation actions.
  await evaluate('document.querySelector("[data-action=new-goal]").click()');
  await evaluate('document.querySelector("[data-view=learning]").click(); document.querySelector("#learnTopic").value = "Robot kinematics"; document.querySelector("#learnGoal").value = "Explain forward kinematics"; document.querySelector("[data-action=save-learning]").click()');
  await evaluate('document.querySelector("[data-view=projects]").click(); document.querySelector("#projectName").value = "SPARKLE smoke project"; document.querySelector("#projectOutcome").value = "Verified project persistence"; document.querySelector("#projectCriteria").value = "Saved without auto-creating tasks"; document.querySelector("[data-action=save-project]").click()');
  await evaluate('document.querySelector("[data-view=lab]").click(); document.querySelector("[data-lab-tab=Research]").click(); document.querySelector("#labQuestion").value = "Can this R&D draft persist?"; document.querySelector("#labHypothesis").value = "It should survive sync"; document.querySelector("[data-action=save-lab]").click()');
  state = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")');
  assert.ok(state.goals?.some(goal => goal.title === "SPARKLE browser smoke task"), "goal creation should persist locally");
  assert.ok(state.learningPlans?.some(plan => plan.topic === "Robot kinematics"), "learning plan should persist locally");
  assert.ok(state.projects?.some(project => project.name === "SPARKLE smoke project"), "project brief should persist locally");
  assert.ok(state.labDrafts?.some(draft => draft.question === "Can this R&D draft persist?"), "R&D research draft should persist locally");

  // Exercise the built-in real-time simulation, one-step controls, and bounded experiment sweep.
  await evaluate('document.querySelector("[data-lab-tab=Simulation]").click()');
  assert.equal(await evaluate('!!document.querySelector("#simCanvas")'), true, "R&D Simulation should render a live canvas");
  assert.equal(await evaluate('document.querySelectorAll("#simModel option").length'), 4, "four registered simulation models should be available");
  await evaluate('document.querySelector("[data-action=sim-step]").click()');
  assert.equal(await evaluate('document.querySelector("#simSteps").textContent'), "1", "single-step control should advance one simulation step");
  await evaluate('document.querySelector("[data-action=sim-start]").click()');
  await delay(180);
  await evaluate('document.querySelector("[data-action=sim-pause]").click()');
  assert.ok(Number(await evaluate('parseFloat(document.querySelector("#simTime").textContent)')) > 0, "live simulation should advance its clock");
  await evaluate('document.querySelector("[data-action=sim-sweep]").click()');
  assert.equal(await evaluate('document.querySelectorAll("#simSweepResults tbody tr").length'), 5, "experiment sweep should render five bounded runs");
  await evaluate('document.querySelector("[data-action=sim-save]").click()');
  state = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")');
  assert.ok(state.labDrafts?.some(run => run.kind === "simulation_run" && run.engine.includes("built-in")), "simulation run manifest should persist");
  assert.ok(state.labDrafts?.some(run => run.kind === "experiment_sweep" && run.results?.length === 5), "sweep results should persist");

  let workspaceActionsSynced = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(baseURL + "/api/data", { headers: { Authorization: "Bearer " + token } });
    const data = await response.json();
    workspaceActionsSynced = data.data.goals?.some(goal => goal.title === "SPARKLE browser smoke task")
      && data.data.learningPlans?.some(plan => plan.topic === "Robot kinematics")
      && data.data.projects?.some(project => project.name === "SPARKLE smoke project")
      && data.data.labDrafts?.some(draft => draft.question === "Can this R&D draft persist?")
      && data.data.labDrafts?.some(run => run.kind === "simulation_run")
      && data.data.labDrafts?.some(run => run.kind === "experiment_sweep");
    if (workspaceActionsSynced) break;
    await delay(100);
  }
  assert.equal(workspaceActionsSynced, true, "goal, learning, project, and R&D records should sync to the private server");

  // Exercise scholarly-search UI with a deterministic fake API response; the server
  // contract is tested separately against Crossref's bounded metadata mapping.
  await evaluate('document.querySelector("[data-view=research]").click()');
  await evaluate(`window.__sparkleOriginalFetch = window.fetch.bind(window); window.__researchRequestBody = null; window.fetch = (input, init = {}) => { const url = typeof input === "string" ? input : input.url; if (url.includes("/api/research/search")) { window.__researchRequestBody = JSON.parse(init.body); return Promise.resolve(new Response(JSON.stringify({ provider: "Crossref", results: [{ title: "SPARKLE Smoke Test Paper", authors: ["Ada Researcher"], year: 2024, venue: "Test Robotics Journal", doi: "10.9999/sparkle.smoke", url: "https://doi.org/10.9999/sparkle.smoke", type: "journal-article" }] }), { status: 200, headers: { "Content-Type": "application/json" } })); } return window.__sparkleOriginalFetch(input, init); }; document.querySelector("#researchSearchInput").value = "robotics safety"; document.querySelector('[data-action="research-search"]').click();`);
  let researchRendered = false;
  for (let i = 0; i < 50; i++) {
    researchRendered = await evaluate('document.body.innerText.includes("SPARKLE Smoke Test Paper")');
    if (researchRendered) break;
    await delay(100);
  }
  assert.equal(researchRendered, true, "Crossref metadata should render in the Research workspace");
  const researchPrivacy = await evaluate('({body: window.__researchRequestBody, doi: document.querySelector(".research-result a")?.href})');
  assert.deepEqual(researchPrivacy.body, { query: "robotics safety" }, "only the explicit search phrase should be sent to the search endpoint");
  assert.equal(researchPrivacy.doi, "https://doi.org/10.9999/sparkle.smoke", "source link should use HTTPS DOI destination");
  await evaluate('document.querySelector("[data-action=save-research-source]").click()');
  let sourceSaved = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    sourceSaved = data.data.knowledge?.some(note => note.title === "SPARKLE Smoke Test Paper" && note.content.includes("https://doi.org/10.9999/sparkle.smoke"));
    if (sourceSaved) break;
    await delay(100);
  }
  assert.equal(sourceSaved, true, "user-selected citation should save to Knowledge and sync");
  await evaluate('window.fetch = window.__sparkleOriginalFetch; delete window.__sparkleOriginalFetch; delete window.__researchRequestBody');

  await cdp("Page.reload", { ignoreCache: true });
  let reconnected = false;
  for (let i = 0; i < 100; i++) {
    reconnected = await evaluate('document.querySelector("#connectionPill")?.innerText.includes("Private · Ollama") || document.body.innerText.includes("Paired · private server")');
    if (reconnected) break;
    await delay(100);
  }
  assert.ok(reconnected, "browser should restore its paired session after reload");
  await evaluate('document.querySelector("[data-view=tasks]").click()');
  await delay(100);
  const afterReload = await evaluate('({visible: document.body.innerText.includes("SPARKLE browser smoke task"), saved: (JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}").tasks || []).some(task => task.title === "SPARKLE browser smoke task")})');
  assert.equal(afterReload.visible, true, "saved task should render after page reload");
  assert.equal(afterReload.saved, true, "saved task should remain in browser storage after reload");

  const backupPath = join(serverRoot, "restore-fixture.json");
  writeFileSync(backupPath, JSON.stringify({
    format: "sparkle-gen3-local-backup", version: 1,
    data: { chat: [], conversations: [], workspaceChats: [], tasks: [{ title: "Restored fixture task", details: "Backup restore e2e", done: false }], goals: [], knowledge: [], projects: [], researchDrafts: [], learningPlans: [], labDrafts: [] },
    preferences: { theme: "dark", density: "Compact", accent: "#53684d", memoryEnabled: false }
  }));
  await evaluate('document.querySelector("[data-view=settings]").click()');
  await cdp("DOM.enable");
  const documentTree = await cdp("DOM.getDocument", { depth: 1 });
  const backupInput = await cdp("DOM.querySelector", { nodeId: documentTree.root.nodeId, selector: "#backupImport" });
  assert.ok(backupInput.nodeId, "backup restore input should be available in Settings");
  await cdp("DOM.setFileInputFiles", { files: [backupPath], nodeId: backupInput.nodeId });
  let restored = false;
  for (let i = 0; i < 50; i++) {
    restored = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}").tasks || []).some(task => task.title === "Restored fixture task")');
    if (restored) break;
    await delay(100);
  }
  assert.ok(restored, "validated backup restore should replace local workspace records");
  await evaluate('document.querySelector("[data-view=tasks]").click()');
  assert.equal(await evaluate('document.body.innerText.includes("Restored fixture task")'), true, "restored task should render");
  let restoredServer;
  for (let i = 0; i < 50; i++) {
    const restoredResponse = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(restoredResponse.status, 200);
    restoredServer = await restoredResponse.json();
    if (restoredServer.data.tasks?.some(task => task.title === "Restored fixture task")) break;
    await delay(100);
  }
  assert.ok(restoredServer.data.tasks?.some(task => task.title === "Restored fixture task"), "restored backup should sync to the private server");

  // Simulate a tab closing mid-inference: the next load must recover the server-saved pending placeholder.
  const interrupted = {
    data: { ...restoredServer.data, chat: [
      { role: "user", html: "<p>Question before reload</p>" },
      { role: "assistant", html: "<p>Thinking with your configured AI engine…</p>", pending: true }
    ], workspaceChats: [{ agent: "main", currentConversationId: null, chat: [
      { role: "user", html: "<p>Question before reload</p>" },
      { role: "assistant", html: "<p>Thinking with your configured AI engine…</p>", pending: true }
    ] }] },
    preferences: restoredServer.preferences,
    revision: restoredServer.revision
  };
  const seedInterrupted = await fetch(`${baseURL}/api/data`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(interrupted) });
  assert.equal(seedInterrupted.status, 200, "test should be able to seed an interrupted conversation through the normal API");
  await cdp("Page.reload", { ignoreCache: true });
  let interruptionRecovered = false;
  for (let i = 0; i < 100; i++) {
    interruptionRecovered = await evaluate('document.body.innerText.includes("Response interrupted")');
    if (interruptionRecovered) break;
    await delay(100);
  }
  assert.equal(interruptionRecovered, true, "reload should replace a stuck pending response with a recoverable interruption");
  let recoveredServer;
  for (let i = 0; i < 50; i++) {
    const recoveredResponse = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    recoveredServer = await recoveredResponse.json();
    if (recoveredServer.data.chat?.[1]?.pending !== true) break;
    await delay(100);
  }
  assert.equal(recoveredServer.data.chat?.[1]?.pending, undefined, "recovered interruption should sync back to server persistence");
  assert.match(recoveredServer.data.chat?.[1]?.html || "", /Response interrupted/, "server should persist the recovered state");

  // Stream a controlled response through the actual browser reader and verify
  // that partial text appears before the final event arrives.
  await evaluate('document.querySelector("[data-view=chat]")?.click()');
  await evaluate(`window.__sparkleOriginalFetch = window.fetch.bind(window);
    const enc = new TextEncoder();
    const frame = (event, data) => enc.encode("event: " + event + String.fromCharCode(10) + "data: " + JSON.stringify(data) + String.fromCharCode(10, 10));
    window.fetch = (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/chat/stream")) {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(frame("meta", { model: "smoke-model", model_provider: "mock", provider_label: "Mock", memory_used: false }));
          controller.enqueue(frame("delta", { text: "Streaming works" }));
          setTimeout(() => {
            controller.enqueue(frame("delta", { text: " incrementally" }));
            controller.enqueue(frame("done", { answer: "Streaming works incrementally", first_token_ms: 10, elapsed_ms: 100 }));
            controller.close();
          }, 600);
          init.signal?.addEventListener("abort", () => { try { controller.error(new DOMException("Aborted", "AbortError")); } catch {} }, { once: true });
        } }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      }
      return window.__sparkleOriginalFetch(input, init);
    };
    document.querySelector("#chatInput").value = "SPARKLE streaming smoke test";
    document.querySelector("#chatForm").requestSubmit();`);
  let partialVisible = false;
  for (let i = 0; i < 40; i++) {
    partialVisible = await evaluate('document.body.innerText.includes("Streaming works") && !!document.querySelector("[data-action=cancel-response]")');
    if (partialVisible) break;
    await delay(25);
  }
  assert.equal(partialVisible, true, "partial assistant text should appear while the response is still streaming");
  let streamCompleted = false;
  for (let i = 0; i < 60; i++) {
    streamCompleted = await evaluate('document.body.innerText.includes("Streaming works incrementally") && document.body.innerText.includes("First token") && document.body.innerText.includes("Total") && !document.querySelector("[data-action=cancel-response]")');
    if (streamCompleted) break;
    await delay(25);
  }
  assert.equal(streamCompleted, true, "stream completion should finalize the assistant message");
  await evaluate('window.fetch = window.__sparkleOriginalFetch; delete window.__sparkleOriginalFetch');

  // Verify retry and edit resubmit through the stream path without a live provider.
  await evaluate('window.__sparkleOriginalFetch = window.fetch.bind(window); window.__editRetryCount = 0; const retryEnc = new TextEncoder(); const retryFrame = (event, data) => retryEnc.encode("event: " + event + String.fromCharCode(10) + "data: " + JSON.stringify(data) + String.fromCharCode(10, 10)); window.fetch = (input, init = {}) => { const url = typeof input === "string" ? input : input.url; if (url.includes("/api/chat/stream")) { window.__editRetryCount++; const answer = "Mock follow-up response " + window.__editRetryCount; return Promise.resolve(new Response(new ReadableStream({start(controller) { controller.enqueue(retryFrame("meta", {model:"smoke-model",model_provider:"mock",provider_label:"Mock",memory_used:false})); controller.enqueue(retryFrame("delta",{text:answer})); controller.enqueue(retryFrame("done",{answer,first_token_ms:4,elapsed_ms:20})); controller.close(); }}), {status:200,headers:{"Content-Type":"text/event-stream"}})); } return window.__sparkleOriginalFetch(input,init); }; document.querySelectorAll("[data-action=retry-message]").item(document.querySelectorAll("[data-action=retry-message]").length-1).click();');
  let retryCompleted = false;
  for (let i = 0; i < 50; i++) {
    retryCompleted = await evaluate('window.__editRetryCount === 1 && document.body.innerText.includes("Mock follow-up response 1") && !document.querySelector("[data-action=cancel-response]")');
    if (retryCompleted) break;
    await delay(50);
  }
  assert.equal(retryCompleted, true, "retry should resubmit the selected user turn and finalize a new response");
  await evaluate('document.querySelectorAll("[data-action=edit-message]").item(document.querySelectorAll("[data-action=edit-message]").length-1).click()');
  let editCompleted = false;
  for (let i = 0; i < 50; i++) {
    editCompleted = await evaluate('window.__editRetryCount === 2 && document.body.innerText.includes("Mock follow-up response 2") && !document.querySelector("[data-action=cancel-response]")');
    if (editCompleted) break;
    await delay(50);
  }
  assert.equal(editCompleted, true, "editing a sent user turn should resubmit the edited turn and finalize its response");
  await evaluate('window.fetch = window.__sparkleOriginalFetch; delete window.__sparkleOriginalFetch; delete window.__editRetryCount');

  // Exercise the stop-response affordance with a controllable in-page fetch that
  // honors AbortSignal; no provider request is sent by this test.
  await evaluate('document.querySelector("[data-view=chat]")?.click()');
  await evaluate(`window.__sparkleOriginalFetch = window.fetch.bind(window); window.fetch = (input, init = {}) => { const url = typeof input === "string" ? input : input.url; if (url.includes("/api/chat")) return new Promise((resolve, reject) => { const abort = () => reject(new DOMException("Aborted", "AbortError")); if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true }); }); return window.__sparkleOriginalFetch(input, init); }; document.querySelector("#chatInput").value = "SPARKLE cancel response smoke test"; document.querySelector("#chatForm").requestSubmit();`);
  let stopButtonVisible = false;
  for (let i = 0; i < 50; i++) {
    stopButtonVisible = await evaluate('!!document.querySelector("[data-action=cancel-response]")');
    if (stopButtonVisible) break;
    await delay(100);
  }
  assert.equal(stopButtonVisible, true, "pending assistant response should offer a Stop response action");
  await evaluate('document.querySelector("[data-action=cancel-response]").click()');
  let cancelled = false;
  for (let i = 0; i < 50; i++) {
    cancelled = await evaluate('document.body.innerText.includes("Response stopped")');
    if (cancelled) break;
    await delay(100);
  }
  assert.equal(cancelled, true, "cancelling should replace the pending placeholder with a clear recoverable status");
  await evaluate('window.fetch = window.__sparkleOriginalFetch; delete window.__sparkleOriginalFetch');
  let cancelSynced = false;
  for (let i = 0; i < 50; i++) {
    const cancelResponse = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    const cancelData = await cancelResponse.json();
    cancelSynced = cancelData.data.chat?.some(message => message.role === "assistant" && /Response stopped/.test(message.html || ""));
    if (cancelSynced) break;
    await delay(100);
  }
  assert.equal(cancelSynced, true, "cancelled-response status should persist to the private server");

  // Verify confirmed workspace clearing is synchronized to the isolated server.
  await evaluate('document.querySelector("[data-view=settings]").click(); document.querySelector("[data-action=clear-data]").click()');
  let workspaceCleared = false;
  for (let i = 0; i < 50; i++) {
    const clearResponse = await fetch(baseURL + "/api/data", { headers: { Authorization: "Bearer " + token } });
    const clearData = await clearResponse.json();
    workspaceCleared = ["chat","conversations","tasks","goals","knowledge","projects","researchDrafts","learningPlans","labDrafts"].every(key => Array.isArray(clearData.data[key]) && clearData.data[key].length === 0);
    if (workspaceCleared) break;
    await delay(100);
  }
  assert.equal(workspaceCleared, true, "confirmed clear-data action should empty all workspace collections on the server");
  assert.deepEqual(runtimeErrors, [], `browser session should not throw runtime exceptions: ${runtimeErrors.join("; ")}`);
  console.log("PASS browser smoke: workspaces, theme/sidebar, mobile layout/navigation, pairing, task/goal/learning/project/R&D sync, live simulation controls, deterministic five-point sweep, saved run manifests, Crossref/citations, reload recovery, streamed chat/timing, edit/retry, cancellation, backup restore, and confirmed workspace clearing");
} finally {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser test ended")); }
  pending.clear();
  try { socket?.close(); } catch {}
  try { processHandle?.kill("SIGTERM"); } catch {}
  try { serverHandle?.kill("SIGTERM"); } catch {}
  await delay(250);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(serverRoot, { recursive: true, force: true }); } catch {}
}
