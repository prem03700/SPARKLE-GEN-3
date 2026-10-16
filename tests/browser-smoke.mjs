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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Browser JavaScript failed");
  return response.result?.value;
}

try {
  cpSync(join(projectRoot, "server.py"), join(serverRoot, "server.py"));
  cpSync(join(projectRoot, "personal_core.py"), join(serverRoot, "personal_core.py"));
  cpSync(join(projectRoot, "rd_simulation.py"), join(serverRoot, "rd_simulation.py"));
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
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "Browser runtime exception");
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
  await evaluate('document.querySelector("[data-view=chat]").click()');
  assert.equal(await evaluate('!!document.querySelector("[data-action=toggle-voice]")'), true, "voice control should render in the Chat workspace");
  assert.equal(await evaluate('!!document.querySelector("[data-action=toggle-chat-fullscreen]")'), true, "Chat should offer an in-app full-screen toggle");
  const normalChatMaxWidth = await evaluate('getComputedStyle(document.querySelector(".chat-layout")).maxWidth');
  await evaluate('document.querySelector("[data-action=toggle-chat-fullscreen]").click()');
  assert.equal(await evaluate('document.body.classList.contains("chat-fullscreen")'), true, "full-screen toggle should expand Chat");
  assert.ok(await evaluate('document.querySelector(".chat-layout").getBoundingClientRect().width >= innerWidth - 30'), "full-screen Chat should use nearly the entire viewport width");
  await evaluate('document.querySelector("[data-action=toggle-chat-fullscreen]").click()');
  assert.equal(await evaluate('document.body.classList.contains("chat-fullscreen")'), false, "full-screen toggle should restore the standard workspace");
  assert.equal(normalChatMaxWidth, "1040px", "standard Chat should use the wider 1040px content limit");
  await evaluate('document.querySelector("#chatInput").value = Array(8).fill("A longer draft line for composer auto-resize").join("\\n"); document.querySelector("#chatInput").dispatchEvent(new Event("input", { bubbles: true }))');
  assert.ok(await evaluate('parseFloat(document.querySelector("#chatInput").style.height) > 54'), "composer should grow automatically for multiline drafts");
  await evaluate('document.querySelector("#chatInput").value = ""; document.querySelector("#chatInput").dispatchEvent(new Event("input", { bubbles: true }))');
  assert.equal(await evaluate('!!document.querySelector("[data-action=export-data]") || (document.querySelector("[data-view=settings]") !== null)'), true, "settings navigation should render");
  assert.equal(await evaluate('!!document.querySelector("[data-action=toggle-image-mode]")'), true, "image generation mode should be available in Chat");
  await evaluate('document.querySelector("[data-action=toggle-image-mode]").click()');
  assert.equal(await evaluate('document.querySelector("[data-action=toggle-image-mode]").getAttribute("aria-pressed")'), "true", "image mode should toggle on accessibly");
  assert.match(await evaluate('document.querySelector("#chatInput").placeholder'), /image/i, "image mode should update the composer prompt");
  await evaluate('document.querySelector("[data-action=toggle-image-mode]").click()');
  assert.equal(await evaluate('document.querySelector("[data-action=toggle-image-mode]").getAttribute("aria-pressed")'), "false", "image mode should toggle off without sending a prompt");
  const richBlockHTML = await evaluate('import("/src/core/answer-renderer.js").then(m => { const ticks=String.fromCharCode(96).repeat(3); const nl=String.fromCharCode(10); const source=ticks+"sparkle-card"+nl+JSON.stringify({title:"<unsafe>",body:"Safe text"})+nl+ticks; const prepared=m.prepareStructuredAnswer(source); return m.renderPreparedAnswer("<p>"+prepared.text+"</p>",prepared.blocks); })');
  assert.match(richBlockHTML, /answer-card/, "structured assistant blocks should render in the browser");
  assert.match(richBlockHTML, /&lt;unsafe&gt;/, "structured assistant block text should be escaped in the browser");
  const tangentInteraction = await evaluate('import("/src/core/answer-renderer.js").then(m => { const box=document.createElement("div"); box.innerHTML=m.renderAnswerBlock({title:"y = x²",points:[{x:-2,y:4},{x:0,y:0},{x:2,y:4}],tangent:{kind:"quadratic",x:0}},"graph"); document.body.append(box); const slider=box.querySelector("[data-tangent-slider]"),line=box.querySelector("[data-tangent-line]"),before=line.getAttribute("d"); slider.value="1"; slider.dispatchEvent(new Event("input",{bubbles:true})); const moved=line.getAttribute("d"),slope=box.querySelector("[data-tangent-slope]").textContent; box.querySelector("[data-tangent-reset]").click(); const reset=slider.value; box.remove(); return {hasControl:!!slider,before,moved,slope,reset}; })');
  assert.notEqual(tangentInteraction.moved, tangentInteraction.before, "moving the tangent slider should move the tangent line in the browser");
  assert.ok(tangentInteraction.slope.includes("slope f′(x) = 2.0"), "tangent interaction should update the derivative value");
  assert.equal(tangentInteraction.reset, "0", "tangent reset should restore the initial point");
  const armInteraction = await evaluate('import("/src/core/answer-renderer.js").then(m => { const box=document.createElement("div"); box.innerHTML=m.renderAnswerBlock({title:"Two-link arm",link1:1,link2:1},"robot_arm"); document.body.append(box); const slider=box.querySelector(\'input[data-angle="1"]\'),tip=box.querySelector("[data-arm-tip]"); slider.value="90"; slider.dispatchEvent(new Event("input",{bubbles:true})); const moved=tip.getAttribute("cx"),coords=box.querySelector("[data-arm-coordinates]").textContent; box.querySelector("[data-arm-reset]").click(); const reset=slider.value; box.remove(); return {moved,coords,reset}; })');
  assert.notEqual(armInteraction.moved, "0", "changing a robot joint should update the SVG end effector");
  assert.ok(armInteraction.coords.includes("("), "forward kinematics should report end-effector coordinates");
  assert.equal(armInteraction.reset, "45", "robot-arm reset should restore the default base angle");
  assert.equal(await evaluate('import("/src/core/realtime-websocket-voice.js").then(m => typeof m.createRealtimeWebSocketVoiceSession)'), "function", "full-duplex voice module should be served by the private app");

  // Verify theme persistence controls, collapsible desktop navigation, and a
  // narrow mobile viewport before exercising application workflows.
  const originalTheme = await evaluate('document.documentElement.dataset.theme');
  await evaluate('document.querySelector("#themeToggle").click()');
  assert.notEqual(await evaluate('document.documentElement.dataset.theme'), originalTheme, "theme toggle should switch light/dark theme");
  await evaluate('document.querySelector("#themeToggle").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), originalTheme, "theme toggle should restore the original theme");
  assert.ok(await evaluate('getComputedStyle(document.body).fontFamily.includes("system-ui")'), "UI should use the system font stack without relying on a missing remote font");
  await evaluate('document.querySelector("[data-view=settings]").click()');
  assert.equal(await evaluate('!!document.querySelector(".connection-card")'), true, "Settings should retain private device and Personal Core controls");
  assert.equal(await evaluate('document.querySelectorAll("[data-theme-choice]").length'), 0, "theme gallery must not be embedded in Settings");
  assert.equal(await evaluate('!!document.querySelector("#customThemeName")'), false, "custom theme creator must live only in the dedicated appearance tab");
  assert.equal(await evaluate('!!document.querySelector("#themeSourceImage")'), false, "image-to-theme tools must not be embedded in Settings");
  await evaluate('document.querySelector("[data-view=appearance]").click()');
  assert.equal(await evaluate('document.querySelectorAll("[data-theme-choice]").length'), 12, "dedicated Themes & appearance tab should offer twelve full palette themes");
  assert.equal(await evaluate('!!document.querySelector("#themeSourceImage") && document.querySelector("#extractImageTheme").disabled'), true, "image-inspired theme controls should be present and wait for an image selection");
  const lightBackground = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()');
  await evaluate('Array.from(document.querySelectorAll("[data-theme-choice]")).find(b => b.dataset.themeChoice === "ocean").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), "ocean", "choosing a theme card should immediately apply that palette");
  assert.notEqual(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()'), lightBackground, "theme selection should change the actual workspace background");
  assert.equal(await evaluate('document.querySelector("#settingTheme").value'), "ocean", "theme selector should stay synchronized with the selected card");
  assert.equal(await evaluate('localStorage.getItem("sparkle-theme")'), "ocean", "theme selection should persist locally");
  await evaluate('Array.from(document.querySelectorAll("[data-theme-choice]")).find(b => b.dataset.themeChoice === "light").click()');
  await evaluate('document.querySelector("#densitySelect").value = "Compact"; document.querySelector("[data-action=save-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.density'), "compact", "Compact density should apply a real CSS preset");
  const compactPadding = await evaluate('getComputedStyle(document.querySelector(".panel-card")).padding');
  await evaluate('document.querySelector("#densitySelect").value = "Spacious"; document.querySelector("[data-action=save-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.density'), "spacious", "Spacious density should apply a real CSS preset");
  const spaciousPadding = await evaluate('getComputedStyle(document.querySelector(".panel-card")).padding');
  assert.notEqual(compactPadding, spaciousPadding, "density presets should change layout spacing");
  await evaluate('document.querySelector("#densitySelect").value = "Comfortable"; document.querySelector("[data-action=save-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.density'), "comfortable", "browser smoke should restore the default density");
  assert.equal(await evaluate('!!document.querySelector("#fontScale") && !!document.querySelector("#customThemeName")'), true, "advanced appearance and custom theme creator should render");
  await evaluate('document.querySelector("#fontScale").value = "17"; document.querySelector("#radiusScale").value = "18"; document.querySelector("#contrastMode").value = "high"; document.querySelector("[data-action=save-advanced-appearance]").click()');
  assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--font-size-base")'), "17px", "advanced text scale should apply");
  assert.equal(await evaluate('document.documentElement.dataset.contrast'), "high", "high-contrast setting should apply");
  await evaluate('document.querySelector("#customThemeName").value = "Browser Smoke Palette"; document.querySelector("#customBg").value = "#121923"; document.querySelector("#customAccent").value = "#ff8844"; document.querySelector("[data-action=save-custom-theme]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), "custom", "saved custom palette should become active");
  assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()'), "#121923", "custom palette should set its validated background");
  assert.equal(await evaluate('({rows:document.querySelectorAll(".custom-theme-row").length,hasList:!!document.querySelector("#customThemeList"),hasCreator:!!document.querySelector("#customThemeName"),hasText:document.querySelector("#viewRoot").innerText.includes("Custom theme creator")})').then(v=>v.rows), 1, "custom theme should appear in the saved palette list");
  assert.equal(await evaluate('document.querySelector("#settingTheme").value'), "Browser Smoke Palette", "custom palette should appear in theme selector");
  await evaluate('document.querySelector("[data-action=edit-custom-theme]").click()');
  assert.equal(await evaluate('document.querySelector("#customThemeName").value'), "Browser Smoke Palette", "saved palette can be loaded back into the creator");
  await evaluate('document.querySelector("#fontScale").value = "15"; document.querySelector("#radiusScale").value = "12"; document.querySelector("#contrastMode").value = "normal"; document.querySelector("[data-action=save-advanced-appearance]").click()');
  assert.equal(await evaluate('document.querySelectorAll("[data-workspace-appearance-row]").length'), 10, "per-workspace appearance should offer all ten supported workspaces");
  const globalThemeBeforeWorkspaceOverride = await evaluate('localStorage.getItem("sparkle-theme")');
  await evaluate('(()=>{const row=document.querySelector("[data-workspace-appearance-row=chat]");row.querySelector("[data-workspace-theme]").value="ocean";row.querySelector("[data-workspace-accent]").value="#123456";row.querySelector("[data-workspace-density]").value="Compact";row.querySelector("[data-workspace-layout]").value="focused";row.querySelector("[data-action=save-workspace-appearance]").click()})()');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("sparkle-workspace-appearance")).chat.theme'), "ocean", "workspace appearance should persist independently");
  await evaluate('document.querySelector("[data-view=chat]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), "ocean", "Chat should use its workspace-specific theme");
  assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--accent")'), "#123456", "Chat should use its workspace-specific accent");
  assert.equal(await evaluate('document.documentElement.dataset.density'), "compact", "Chat should use its workspace-specific density");
  assert.equal(await evaluate('document.documentElement.dataset.workspaceLayout'), "focused", "Chat should use its workspace-specific layout");
  assert.equal(await evaluate('localStorage.getItem("sparkle-theme")'), globalThemeBeforeWorkspaceOverride, "workspace theme must not overwrite the global theme preference");
  await evaluate('document.querySelector("[data-view=appearance]").click(); document.querySelector("[data-action=reset-workspace-appearance][data-workspace=chat]").click(); document.querySelector("[data-view=chat]").click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), "custom", "resetting a workspace should restore the global custom theme");
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
  // Exercise reusable-skill CRUD, search, versioning, enable/disable, and removal in-browser.
  await evaluate('document.querySelector("[data-view=learning]").click()');
  assert.equal(await evaluate('!!document.querySelector("#skillName") && !!document.querySelector("#skillInstructions")'), true, "Learning & Skills should expose the reusable-skill editor");
  await evaluate('document.querySelector("#skillName").value = "Browser Skill Fixture"; document.querySelector("#skillDescription").value = "A browser CRUD test"; document.querySelector("#skillInstructions").value = "Review the input and return concise findings."; document.querySelector("#skillInputs").value = "A sample paragraph"; document.querySelector("#skillOutputs").value = "Findings"; document.querySelector("[data-action=create-skill]").click()');
  assert.equal(await evaluate('document.querySelector(".skill-card h3")?.textContent'), "Browser Skill Fixture", "new skill definition should render in the catalog");
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1")).skills.length'), 1, "skill definition should persist to browser workspace storage");
  await evaluate('document.querySelector("#skillSearch").value = "browser crud"; document.querySelector("#skillSearch").dispatchEvent(new Event("input", {bubbles:true}))');
  assert.equal(await evaluate('document.querySelectorAll(".skill-card").length'), 1, "skill search should match descriptive metadata");
  await evaluate('document.querySelector("#skillSearch").value = "not-a-match"; document.querySelector("#skillSearch").dispatchEvent(new Event("input", {bubbles:true}))');
  assert.equal(await evaluate('document.querySelectorAll(".skill-card").length'), 0, "skill search should filter non-matching definitions");
  await evaluate('document.querySelector("#skillSearch").value = ""; document.querySelector("#skillSearch").dispatchEvent(new Event("input", {bubbles:true}))');
  await evaluate('document.querySelector("[data-action=toggle-skill]").click()');
  assert.match(await evaluate('document.querySelector(".skill-card .card-kicker").textContent'), /Disabled/, "disabled skill should be visibly marked and not invokable");
  await evaluate('document.querySelector("[data-action=toggle-skill]").click()');
  await evaluate('document.querySelector("[data-action=edit-skill]").click()');
  assert.equal(await evaluate('document.querySelector("#appDialog").open'), true, "editing a skill should use the integrated application dialog");
  await evaluate('document.querySelector("#appDialogField0").value = "Browser Skill Fixture v2"; document.querySelector("#appDialogSubmit").click()');
  assert.equal(await evaluate('document.querySelector(".skill-card h3")?.textContent'), "Browser Skill Fixture v2", "skill editing should update the definition");
  assert.match(await evaluate('document.querySelector(".skill-card .card-kicker").textContent'), /v2/, "editing should increment the skill version");
  await evaluate('document.querySelector("[data-action=delete-skill]").click()');
  assert.equal(await evaluate('document.querySelector("#appDialog").open'), true, "removal should require confirmation");
  await evaluate('document.querySelector("#appDialogSubmit").click()');
  assert.equal(await evaluate('document.querySelectorAll(".skill-card").length'), 0, "confirmed removal should remove the definition");
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1")).skills.length'), 0, "removed definition should persist as removed");
  await evaluate('document.querySelector("[data-lab-tab]")?.click()');
  assert.deepEqual(runtimeErrors, [], `workspaces should not throw browser runtime exceptions: ${runtimeErrors.join("; ")}`);

  await evaluate('document.querySelector("[data-view=settings]").click()');
  await evaluate(`document.querySelector("#deviceName").value = "Isolated browser test"; document.querySelector("#pairingCode").value = ${JSON.stringify(pairingCode)}; document.querySelector("[data-action=pair-device]").click()`);
  // The first sync can ask whether pre-existing local records should be imported.
  // Accept that explicit in-app dialog in this isolated smoke-test profile.
  for (let i = 0; i < 100; i++) {
    const dialogOpen = await evaluate('!!document.querySelector("#appDialog")?.open');
    if (dialogOpen) { await evaluate('document.querySelector("#appDialogSubmit").click()'); break; }
    const alreadyPaired = await evaluate('document.body.innerText.includes("Paired · private server")');
    if (alreadyPaired) break;
    await delay(50);
  }
  let paired = false;
  for (let i = 0; i < 100; i++) {
    paired = await evaluate('document.body.innerText.includes("Paired · private server")');
    if (paired) break;
    await delay(100);
  }
  assert.ok(paired, "browser should pair successfully against the isolated private server");

  const token = await evaluate('localStorage.getItem("sparkle-auth-token")');
  assert.ok(token, "paired browser should hold a device token");

  // Coding & IDE files are saved in the shared workspace and can be reopened.
  await evaluate('document.querySelector("[data-view=coding]").click()');
  await evaluate('document.querySelector("#codeFileName").value = "persistent-smoke.py"; document.querySelector("#codeLanguage").value = "Python"; document.querySelector("#codeEditor").value = '+JSON.stringify("def answer():\n    return 42\n")+'; document.querySelector("[data-action=save-code-file]").click()');
  let savedCodeFile = null;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(baseURL + "/api/data", { headers: { Authorization: "Bearer " + token } });
    const snapshot = await response.json();
    savedCodeFile = (snapshot.data.projects || []).find(item => item.kind === "code_file" && item.name === "persistent-smoke.py");
    if (savedCodeFile) break;
    await delay(100);
  }
  assert.ok(savedCodeFile, "Coding & IDE should persist a named code file to the server workspace");
  assert.match(savedCodeFile.content, /return 42/);
  await evaluate('document.querySelector("#codeEditor").value = "unsaved replacement"; document.querySelector("[data-action=load-code-file]").click()');
  assert.match(await evaluate('document.querySelector("#codeEditor").value'), /return 42/, "opening a saved file should restore its persisted content");
  await evaluate('document.querySelector("[data-view=projects]").click()');
  assert.equal(await evaluate('document.querySelector("#viewRoot").innerText.includes("persistent-smoke.py")'), false, "code files should not be misrepresented as project briefs");

  // Personal Core proposals are visible in Settings, persist on the server,
  // and record approval without executing the proposed operation.
  await evaluate('document.querySelector("[data-view=settings]").click()');
  assert.equal(await evaluate('!!document.querySelector("#coreProposalType")'), true, "paired Settings should render the Personal Core proposal form");
  await evaluate('document.querySelector("#coreProposalType").value = "shell_execution"; document.querySelector("#coreProposalTitle").value = "Browser smoke command proposal"; document.querySelector("#coreProposalDetails").value = "Must remain unexecuted"; document.querySelector("[data-action=create-core-proposal]").click()');
  let proposalVisible = false;
  for (let i = 0; i < 50; i++) {
    proposalVisible = await evaluate('document.body.innerText.includes("Browser smoke command proposal") && document.body.innerText.includes("proposed")');
    if (proposalVisible) break;
    await delay(100);
  }
  assert.equal(proposalVisible, true, "new proposal should render from the authenticated Python service");
  const proposalResponse = await fetch(`${baseURL}/api/core/proposals`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(proposalResponse.status, 200, "paired browser should list durable proposals");
  const proposals = (await proposalResponse.json()).proposals;
  const proposal = proposals.find(item => item.title === "Browser smoke command proposal");
  assert.ok(proposal?.id, "proposal should have a durable server-generated ID");
  await evaluate('document.querySelector(\'[data-action="decide-core-proposal"][data-decision="approved"]\').click()');
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector("#appDialog")?.open')) break; await delay(20); }
  await evaluate('if(document.querySelector("#appDialog")?.open) document.querySelector("#appDialogSubmit").click()');
  let proposalApproved = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseURL}/api/core/proposals`, { headers: { Authorization: `Bearer ${token}` } });
    const current = (await response.json()).proposals.find(item => item.id === proposal.id);
    if (current?.status === "approved") { proposalApproved = true; break; }
    await delay(100);
  }
  await evaluate('window.confirm = window.__proposalOriginalConfirm; delete window.__proposalOriginalConfirm');
  assert.equal(proposalApproved, true, "explicit UI approval should be durably recorded");
  const approvedDecision = await fetch(`${baseURL}/api/core/proposals/${proposal.id}/decision`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ decision: "rejected" }) });
  assert.equal(approvedDecision.status, 409, "a decided proposal cannot be approved/rejected a second time");

  // Safe record proposals create exactly one durable workspace record only
  // after the explicit approve click; privileged proposals above stayed inert.
  await evaluate('document.querySelector("#coreProposalType").value = "create_task"; document.querySelector("#coreProposalTitle").value = "Approved Core task"; document.querySelector("#coreProposalDetails").value = "Created only after explicit approval"; document.querySelector("[data-action=create-core-proposal]").click()');
  let taskProposalVisible = false;
  for (let i = 0; i < 50; i++) {
    taskProposalVisible = await evaluate('document.body.innerText.includes("Approved Core task") && document.body.innerText.includes("proposed")');
    if (taskProposalVisible) break;
    await delay(100);
  }
  assert.equal(taskProposalVisible, true, "task proposal should be shown before approval");
  await evaluate('document.querySelector("[data-action=decide-core-proposal][data-decision=approved]").click()');
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector("#appDialog")?.open')) break; await delay(20); }
  await evaluate('if(document.querySelector("#appDialog")?.open) document.querySelector("#appDialogSubmit").click()');
  let coreTaskSaved = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(baseURL + "/api/data", { headers: { Authorization: "Bearer " + token } });
    const snapshot = await response.json();
    coreTaskSaved = snapshot.data.tasks?.filter(item => item.title === "Approved Core task").length === 1;
    if (coreTaskSaved) break;
    await delay(100);
  }
  await evaluate('window.confirm = window.__proposalOriginalConfirm; delete window.__proposalOriginalConfirm');
  assert.equal(coreTaskSaved, true, "explicitly approved task proposal should create exactly one SQLite workspace record");
  await delay(1800);
  assert.equal(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}").tasks || []).filter(item => item.title === "Approved Core task").length'), 1, "live workspace polling should deliver the approved task to the open browser");

  // A proposal created from another paired device should appear in Settings
  // automatically while this screen stays open, without pressing Refresh.
  const proposalSyncCodeResponse = await fetch(baseURL + "/api/setup-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(proposalSyncCodeResponse.status, 200);
  const proposalSyncCode = (await proposalSyncCodeResponse.json()).code;
  const proposalSyncPair = await fetch(baseURL + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: proposalSyncCode, name: "Proposal sync writer" }) });
  assert.equal(proposalSyncPair.status, 201);
  const proposalSyncToken = (await proposalSyncPair.json()).token;
  const remoteProposalResponse = await fetch(baseURL + "/api/core/proposals", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + proposalSyncToken }, body: JSON.stringify({ action_type: "agent_handoff", title: "REMOTE CORE PROPOSAL SENTINEL", details: "Should appear without refresh" }) });
  assert.equal(remoteProposalResponse.status, 201);
  let proposalSyncVisible = false;
  for (let i = 0; i < 70; i++) {
    proposalSyncVisible = await evaluate('document.body.innerText.includes("REMOTE CORE PROPOSAL SENTINEL")');
    if (proposalSyncVisible) break;
    await delay(100);
  }
  assert.equal(proposalSyncVisible, true, "another device's proposal should appear in the open Settings queue without refresh");

  await evaluate('document.querySelector("[data-view=tasks]").click()');
  await delay(100);
  await evaluate('document.querySelector("[data-action=new-task]").click()');
  await evaluate('document.querySelector("#appDialogField0").value = "SPARKLE browser smoke task"; document.querySelector("#appDialogField1").value = "Browser persistence smoke test"; document.querySelector("#appDialogForm").requestSubmit()');
  await delay(150);
  let state = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")');
  assert.ok(state.tasks?.some(task => task.title === "SPARKLE browser smoke task"), "task creation should persist to browser storage");
  let serverData;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, "paired browser token should read the private workspace");
    serverData = await response.json();
    if (serverData.data.tasks?.some(task => task.title === "SPARKLE browser smoke task")) break;
    await delay(100);
  }
  assert.ok(serverData.data.tasks?.some(task => task.title === "SPARKLE browser smoke task"), "task should sync to the server database");

  // A separately paired client writes a newer server revision. The already-open
  // browser must render it automatically without a reload and update local storage.
  await delay(250);
  const secondCodeResponse = await fetch(`${baseURL}/api/setup-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(secondCodeResponse.status, 200, "server should issue a fresh code for the second test device");
  const secondCode = (await secondCodeResponse.json()).code;
  const secondPairResponse = await fetch(`${baseURL}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: secondCode, name: "Isolated remote sync writer" }) });
  assert.equal(secondPairResponse.status, 201, "second isolated client should pair");
  const secondToken = (await secondPairResponse.json()).token;
  const secondReadResponse = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${secondToken}` } });
  assert.equal(secondReadResponse.status, 200, "second paired client should read the shared workspace");
  const remoteWorkspace = await secondReadResponse.json();
  remoteWorkspace.data.tasks.push({ id: "remote-live-sync-fixture", title: "REMOTE LIVE SYNC SENTINEL", details: "Automatic cross-device refresh acceptance", done: false, createdAt: new Date().toISOString() });
  const remoteWriteResponse = await fetch(`${baseURL}/api/data`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secondToken}` }, body: JSON.stringify({ data: remoteWorkspace.data, preferences: remoteWorkspace.preferences, revision: remoteWorkspace.revision }) });
  assert.equal(remoteWriteResponse.status, 200, "second paired client should advance the shared workspace revision");
  let liveSyncVisible = false;
  for (let i = 0; i < 30; i++) {
    liveSyncVisible = await evaluate('document.body.innerText.includes("REMOTE LIVE SYNC SENTINEL") && (JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}").tasks || []).some(task => task.title === "REMOTE LIVE SYNC SENTINEL")');
    if (liveSyncVisible) break;
    await delay(100);
  }
  assert.equal(liveSyncVisible, true, "a remote device update should render and persist locally without reloading the open browser");

  // Exercise goal, learning-plan, project-brief, and R&D draft creation actions.
  await evaluate('document.querySelector("[data-action=new-goal]").click(); document.querySelector("#appDialogField0").value = "SPARKLE browser smoke task"; document.querySelector("#appDialogField1").value = "Browser persistence smoke test"; document.querySelector("#appDialogForm").requestSubmit()');
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
  for (let i = 0; i < 50 && await evaluate('document.querySelectorAll("#simSweepResults tbody tr").length') !== 5; i++) await delay(50);
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
  assert.equal(await evaluate('document.querySelector("#breadcrumbPage").textContent === "Home" && document.querySelector(".nav-item[data-view=home]").classList.contains("active")'), true, "a refreshed browser should open Home as the main page");
  await evaluate('document.querySelector("[data-view=tasks]").click()');
  await delay(100);
  const afterReload = await evaluate('({visible: document.body.innerText.includes("SPARKLE browser smoke task"), saved: (JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}").tasks || []).some(task => task.title === "SPARKLE browser smoke task")})');
  assert.equal(afterReload.visible, true, "saved task should render after page reload");
  assert.equal(afterReload.saved, true, "saved task should remain in browser storage after reload");

  // End-to-end CRUD acceptance for all user-owned saved-record collections.
  await evaluate(`window.__crudOriginalPrompt = window.prompt; window.__crudOriginalConfirm = window.confirm; window.confirm = () => true; window.__crudPromptQueue = []; window.__crudDialogObserver = new MutationObserver(() => { const d=document.querySelector("#appDialog"); if(!d?.open) return; const values=window.__crudPromptQueue.splice(0); const controls=[...d.querySelectorAll("input,textarea,select")]; if(!values.length && controls.length) return; d.dataset.smokeFilled="1"; controls.forEach((control,i)=>{ if(values[i]!==undefined) control.value=values[i]; }); d.querySelector("#appDialogForm").requestSubmit(); }); window.__crudDialogObserver.observe(document.querySelector("#appDialog"),{attributes:true,attributeFilter:["open"]});`);
  await evaluate(`document.querySelector("#appDialog").addEventListener("close", () => { delete document.querySelector("#appDialog").dataset.smokeFilled; });`);
  const promptFor = async values => evaluate(`window.__crudPromptQueue = ${JSON.stringify(values)}`);
  await evaluate('document.querySelector("[data-view=tasks]").click()');
  const taskId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").tasks||[]).find(x=>x.title==="SPARKLE browser smoke task")?.id');
  await promptFor(["SPARKLE browser task edited","Edited task details"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="task"][data-id="${taskId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").tasks||[]).some(x=>x.title==="SPARKLE browser task edited"&&x.details==="Edited task details")'), "task edit should persist locally");
  // Native dialog close events are queued as a separate browser task. Wait for
  // that lifecycle event before opening the next edit dialog in this smoke run.
  await delay(25);
  const goalId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").goals||[]).find(x=>x.title==="SPARKLE browser smoke task")?.id');
  await promptFor(["SPARKLE browser goal edited","Edited goal details"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="goal"][data-id="${goalId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").goals||[]).some(x=>x.title==="SPARKLE browser goal edited")'), "goal edit should persist locally");

  await evaluate('document.querySelector("[data-view=knowledge]").click(); document.querySelector("#noteTitle").value="CRUD smoke note"; document.querySelector("#noteContent").value="Original note body"; document.querySelector("[data-action=save-note]").click()');
  await evaluate('document.querySelector("#noteTitle").value="Robot joint torque and kinematics"; document.querySelector("#noteContent").value="Actuator torque moves robotic joints and computes end effector pose through a kinematic chain."; document.querySelector("[data-action=save-note]").click()');
  let knowledgeSavedOnServer = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(baseURL + "/api/data", { headers: { Authorization: "Bearer " + token } });
    const snapshot = await response.json();
    knowledgeSavedOnServer = (snapshot.data.knowledge || []).some(item => item.title === "Robot joint torque and kinematics");
    if (knowledgeSavedOnServer) break;
    await delay(100);
  }
  assert.equal(knowledgeSavedOnServer, true, "Knowledge note must persist on the Python server before semantic search starts");
  await evaluate('document.querySelector("#knowledgeSearchInput").value="How do robot arms move their joints?"; document.querySelector("[data-action=knowledge-search]").click()');
  let semanticKnowledgeStatus = "";
  for (let i = 0; i < 100; i++) {
    semanticKnowledgeStatus = await evaluate('document.querySelector("#viewRoot").innerText');
    if (semanticKnowledgeStatus.includes("Semantic search ·") || semanticKnowledgeStatus.includes("Keyword fallback ·")) break;
    await delay(100);
  }
  assert.ok(semanticKnowledgeStatus.includes("Semantic search ·") || semanticKnowledgeStatus.includes("Keyword fallback ·"), "Knowledge search should complete with semantic mode or a visible lexical fallback");
  assert.ok(semanticKnowledgeStatus.includes("Robot joint torque and kinematics"), "natural-language search should surface the related saved note");
  await evaluate('document.querySelector("#knowledgeSearchInput").value=""; document.querySelector("[data-action=knowledge-search]").click()');
  const noteId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").knowledge||[]).find(x=>x.title==="CRUD smoke note")?.id');
  await promptFor(["CRUD smoke note edited","Edited note body"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="knowledge"][data-id="${noteId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").knowledge||[]).some(x=>x.title==="CRUD smoke note edited"&&x.content==="Edited note body")'), "Knowledge note edit should persist locally");

  await evaluate('document.querySelector("[data-view=research]").click(); document.querySelector("#researchInput").value="CRUD smoke research question"; document.querySelector("[data-action=save-research]").click()');
  const researchId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").researchDrafts||[]).find(x=>x.question==="CRUD smoke research question")?.id');
  await promptFor(["CRUD smoke research question edited"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="research"][data-id="${researchId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").researchDrafts||[]).some(x=>x.question==="CRUD smoke research question edited")'), "research-question edit should persist locally");

  await evaluate('document.querySelector("[data-view=learning]").click(); document.querySelector("#learnTopic").value="CRUD smoke learning"; document.querySelector("#learnGoal").value="Original learning goal"; document.querySelector("[data-action=save-learning]").click()');
  const learningId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").learningPlans||[]).find(x=>x.topic==="CRUD smoke learning")?.id');
  await promptFor(["CRUD smoke learning edited","Intermediate","Edited learning goal"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="learning"][data-id="${learningId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").learningPlans||[]).some(x=>x.topic==="CRUD smoke learning edited"&&x.level==="Intermediate")'), "learning-plan edit should persist locally");
  await evaluate(`document.querySelector("#learnTopicTitle-${learningId}").value="Coordinate frames"; document.querySelector("#learnTopicOutcome-${learningId}").value="Explain and solve a frame-composition example"; document.querySelector('[data-action="learning-topic-add"][data-plan-id="${learningId}"]').click()`);
  const learningTopicId = await evaluate(`(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").learningPlans||[]).find(x=>x.id==="${learningId}")?.topics?.[0]?.id`);
  assert.ok(learningTopicId, "ordered learning topic should persist");
  await evaluate(`document.querySelector('[data-action="learning-session-start"][data-topic-id="${learningTopicId}"]').click()`);
  await delay(1100);
  await evaluate(`document.querySelector('[data-action="learning-session-pause"][data-topic-id="${learningTopicId}"]').click()`);
  assert.ok(await evaluate(`(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").learningPlans||[]).find(x=>x.id==="${learningId}").topics[0].secondsStudied>=1`), "study session should persist elapsed time");
  await promptFor(["5","4","Explained the coordinate frame composition and solved a concrete transform example with the correct order of operations.","Review multiplication order"]);
  await evaluate(`document.querySelector('[data-action="learning-assess"][data-topic-id="${learningTopicId}"]').click()`);
  const recordedLearningEvidence = await evaluate(`(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").learningPlans||[]).find(x=>x.id==="${learningId}").topics[0]`);
  assert.equal(recordedLearningEvidence.assessments[0].score, 80, "assessment score should be computed from the recorded answer counts");
  assert.equal(recordedLearningEvidence.assessments[0].source, "learner-reported");
  assert.equal(recordedLearningEvidence.masteryStatus, "mastered", "mastery requires an assessment and written evidence");
  assert.ok(recordedLearningEvidence.revisionDueAt, "assessment should schedule a suggested revision date");
  await evaluate('document.querySelector("[data-view=projects]").click(); document.querySelector("#projectName").value="CRUD smoke project"; document.querySelector("#projectOutcome").value="Original outcome"; document.querySelector("#projectCriteria").value="Original criteria"; document.querySelector("[data-action=save-project]").click()');
  const projectId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").projects||[]).find(x=>x.name==="CRUD smoke project")?.id');
  await promptFor(["CRUD smoke project edited","Edited outcome","Edited criteria"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="project"][data-id="${projectId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").projects||[]).some(x=>x.name==="CRUD smoke project edited"&&x.outcome==="Edited outcome")'), "project edit should persist locally");

  await evaluate('document.querySelector("[data-view=lab]").click(); document.querySelector("[data-lab-tab=Research]").click(); document.querySelector("#labQuestion").value="CRUD smoke R&D question"; document.querySelector("#labHypothesis").value="Original hypothesis"; document.querySelector("[data-action=save-lab]").click()');
  const labId = await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").labDrafts||[]).find(x=>x.question==="CRUD smoke R&D question")?.id');
  await promptFor(["CRUD smoke R&D question edited","Edited hypothesis"]);
  await evaluate(`document.querySelector('[data-action="edit-item"][data-kind="lab"][data-id="${labId}"]').click()`);
  assert.ok(await evaluate('(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").labDrafts||[]).some(x=>x.question==="CRUD smoke R&D question edited"&&x.hypothesis==="Edited hypothesis")'), "R&D draft edit should persist locally");
  let crudEditsSynced = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    const remote = await response.json();
    crudEditsSynced = remote.data.tasks?.some(x=>x.title==="SPARKLE browser task edited")
      && remote.data.goals?.some(x=>x.title==="SPARKLE browser goal edited")
      && remote.data.knowledge?.some(x=>x.title==="CRUD smoke note edited")
      && remote.data.researchDrafts?.some(x=>x.question==="CRUD smoke research question edited")
      && remote.data.learningPlans?.some(x=>x.topic==="CRUD smoke learning edited")
      && remote.data.projects?.some(x=>x.name==="CRUD smoke project edited")
      && remote.data.labDrafts?.some(x=>x.question==="CRUD smoke R&D question edited");
    if (crudEditsSynced) break;
    await delay(100);
  }
  assert.equal(crudEditsSynced, true, "edits across every persisted record collection should sync to the private server");

  // Delete each record using its explicit UI affordance and verify local persistence.
  const deleteRecord = async (kind, collection, predicate) => {
    const itemId = await evaluate(`(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").${collection}||[]).find(${predicate})?.id`);
    assert.ok(itemId, `a ${kind} fixture should exist before deletion`);
    if (kind === "lab") await evaluate('document.querySelector("[data-view=lab]").click(); document.querySelector("[data-lab-tab=Research]").click()');
    else await evaluate(`document.querySelector('[data-view="${kind==="task"||kind==="goal"?"tasks":kind==="knowledge"?"knowledge":kind==="project"?"projects":kind==="research"?"research":"learning"}"]').click()`);
    await evaluate(`document.querySelector('[data-action="delete-item"][data-kind="${kind}"][data-id="${itemId}"]').click()`);
    await delay(0);
    let stillPresent = await evaluate(`(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").${collection}||[]).some(x=>x.id===${JSON.stringify(itemId)})`);
    if (stillPresent && await evaluate('!!document.querySelector("#appDialog")?.open')) {
      await evaluate('document.querySelector("#appDialogSubmit").click()');
    }
    let stillPresentAfterConfirm = true;
    for (let i = 0; i < 50; i++) {
      stillPresentAfterConfirm = await evaluate(`(JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").${collection}||[]).some(x=>x.id===${JSON.stringify(itemId)})`);
      if (!stillPresentAfterConfirm) break;
      await delay(20);
    }
    assert.equal(stillPresentAfterConfirm, false, `${kind} deletion should persist locally`);
  };
  await deleteRecord("task","tasks",'x=>x.title==="SPARKLE browser task edited"');
  await deleteRecord("goal","goals",'x=>x.title==="SPARKLE browser goal edited"');
  await deleteRecord("knowledge","knowledge",'x=>x.title==="CRUD smoke note edited"');
  await deleteRecord("research","researchDrafts",'x=>x.question==="CRUD smoke research question edited"');
  await deleteRecord("learning","learningPlans",'x=>x.topic==="CRUD smoke learning edited"');
  await deleteRecord("project","projects",'x=>x.name==="CRUD smoke project edited"');
  await deleteRecord("lab","labDrafts",'x=>x.question==="CRUD smoke R&D question edited"');
  let crudDeletesSynced = false;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    const remote = await response.json();
    crudDeletesSynced = !remote.data.tasks?.some(x=>x.title==="SPARKLE browser task edited")
      && !remote.data.goals?.some(x=>x.title==="SPARKLE browser goal edited")
      && !remote.data.knowledge?.some(x=>x.title==="CRUD smoke note edited")
      && !remote.data.researchDrafts?.some(x=>x.question==="CRUD smoke research question edited")
      && !remote.data.learningPlans?.some(x=>x.topic==="CRUD smoke learning edited")
      && !remote.data.projects?.some(x=>x.name==="CRUD smoke project edited")
      && !remote.data.labDrafts?.some(x=>x.question==="CRUD smoke R&D question edited");
    if (crudDeletesSynced) break;
    await delay(100);
  }
  assert.equal(crudDeletesSynced, true, "deletions across every persisted record collection should sync to the private server");
  await evaluate('window.__crudDialogObserver?.disconnect(); window.prompt = window.__crudOriginalPrompt; window.confirm = window.__crudOriginalConfirm; delete window.__crudDialogObserver; delete window.__crudOriginalPrompt; delete window.__crudOriginalConfirm; delete window.__crudPromptQueue');

  // A partial/malformed backup must fail closed and preserve current records.
  const partialBackupPath = join(serverRoot, "partial-backup-fixture.json");
  writeFileSync(partialBackupPath, JSON.stringify({ format: "sparkle-gen3-local-backup", version: 1, data: { tasks: [] } }));
  const oversizedBackupPath = join(serverRoot, "oversized-workspace-fixture.json");
  const oversizedData = { chat: [], conversations: [], workspaceChats: [], tasks: [], goals: [], knowledge: Array.from({length: 40}, (_,i)=>({id:"large-"+i,title:"Large note "+i,content:"x".repeat(50000)})), projects: [], researchDrafts: [], workspaceHistory: [], learningPlans: [], labDrafts: [] };
  writeFileSync(oversizedBackupPath, JSON.stringify({format:"sparkle-gen3-local-backup",version:1,data:oversizedData,preferences:{}}));
  const backupPath = join(serverRoot, "restore-fixture.json");
  writeFileSync(backupPath, JSON.stringify({
    format: "sparkle-gen3-local-backup", version: 1,
    data: { chat: [], conversations: [], workspaceChats: [], tasks: [{ title: "Restored fixture task", details: "Backup restore e2e", done: false }], goals: [], knowledge: [], projects: [], researchDrafts: [], workspaceHistory: [], learningPlans: [], labDrafts: [] },
    preferences: { theme: "dark", density: "Compact", accent: "#53684d", memoryEnabled: false }
  }));
  await evaluate('document.querySelector("[data-view=settings]").click()');
  await cdp("DOM.enable");
  const documentTree = await cdp("DOM.getDocument", { depth: 1 });
  const backupInput = await cdp("DOM.querySelector", { nodeId: documentTree.root.nodeId, selector: "#backupImport" });
  assert.ok(backupInput.nodeId, "backup restore input should be available in Settings");
  const setBackupFile = async path => { const tree = await cdp("DOM.getDocument", { depth: 1 }); const input = await cdp("DOM.querySelector", { nodeId: tree.root.nodeId, selector: "#backupImport" }); assert.ok(input.nodeId, "backup restore input should remain available after view updates"); await cdp("DOM.setFileInputFiles", { files: [path], nodeId: input.nodeId }); };
  const preRestore = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")');
  await evaluate(`window.__backupExportOriginalURL = URL.createObjectURL.bind(URL); window.__backupExportOriginalClick = HTMLAnchorElement.prototype.click; window.__backupExportBlob = null; URL.createObjectURL = blob => { window.__backupExportBlob = blob; return "blob:backup-smoke"; }; HTMLAnchorElement.prototype.click = function() { window.__backupExportFilename = this.download; };`);
  await evaluate('document.querySelector("[data-action=export-data]").click()');
  const exportedBackup = await evaluate('window.__backupExportBlob ? window.__backupExportBlob.text().then(text=>({filename:window.__backupExportFilename,payload:JSON.parse(text)})) : null');
  assert.ok(exportedBackup, "backup export should produce a JSON Blob");
  assert.match(exportedBackup.filename, /^sparkle-gen3-backup-\d{4}-\d{2}-\d{2}\.json$/, "backup export should use a dated JSON filename");
  assert.equal(exportedBackup.payload.format, "sparkle-gen3-local-backup", "export should include the supported backup format marker");
  assert.deepEqual(Object.keys(exportedBackup.payload.data).sort(), ["chat","conversations","goals","knowledge","labDrafts","learningPlans","projects","researchDrafts","skillRuns","skills","tasks","workspaceChats","workspaceHistory"].sort(), "export should include every workspace collection");
  await evaluate('URL.createObjectURL = window.__backupExportOriginalURL; HTMLAnchorElement.prototype.click = window.__backupExportOriginalClick; delete window.__backupExportOriginalURL; delete window.__backupExportOriginalClick; delete window.__backupExportBlob; delete window.__backupExportFilename');
  await setBackupFile(partialBackupPath);
  await delay(150);
  const afterPartialBackup = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")');
  assert.deepEqual(afterPartialBackup, preRestore, "an incomplete backup must not clear or change any existing local workspace records");
  assert.equal(await evaluate('document.body.innerText.includes("Backup not restored")'), true, "invalid backup should report that restore was rejected");
  await setBackupFile(oversizedBackupPath);
  await delay(150);
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")'), preRestore, "a valid but oversized workspace must be rejected without changing current records");
  const oversizedToast = await evaluate('document.querySelector("#toast").textContent');
  assert.match(oversizedToast, /safe 1\.8 MB/i, "oversized workspace should explain the safe persistence/sync bound; toast was: " + oversizedToast);
  await setBackupFile(backupPath);
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector("#appDialog")?.open')) break; await delay(20); }
  await evaluate('if(document.querySelector("#appDialog")?.open) document.querySelector("#appDialog").querySelector("[data-dialog-cancel]").click()');
  await delay(50);
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1") || "{}")'), preRestore, "canceling the restore confirmation must preserve current records");
  await setBackupFile(backupPath);
  for (let i = 0; i < 50; i++) { if (await evaluate('!!document.querySelector("#appDialog")?.open')) break; await delay(20); }
  await evaluate('if(document.querySelector("#appDialog")?.open) document.querySelector("#appDialogSubmit").click()');
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
  assert.equal(await evaluate('document.body.innerText.includes("Restored fixture task")'), true, "valid backup restore should render the replacement records");

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
  let reloadReady = false;
  for (let i = 0; i < 100; i++) {
    reloadReady = await evaluate('document.readyState === "complete" && !!document.querySelector("[data-view=chat]")');
    if (reloadReady) break;
    await delay(100);
  }
  assert.equal(reloadReady, true, "page should be ready after reload before checking recovery");
  await evaluate('document.querySelector("[data-view=chat]").click()');
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
  // Shift+Enter keeps the draft; plain Enter must trigger the real form path.
  await evaluate('document.querySelector("#chatInput").value = "first line"; document.querySelector("#chatInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }))');
  assert.equal(await evaluate('document.querySelector("#chatInput").value'), "first line", "Shift+Enter should preserve the multiline draft");
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
    document.querySelector("#chatInput").value = "SPARKLE Enter-key streaming smoke test";
    document.querySelector("#chatInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`);
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
  // Editing uses the accessible in-app dialog; emulate typing the revised message
  // and submitting it instead of assuming the dialog auto-submits like a prompt.
  await evaluate('document.querySelector("#appDialogField0").value = "Edited smoke user turn"; document.querySelector("#appDialogForm").requestSubmit()');
  let editCompleted = false;
  for (let i = 0; i < 50; i++) {
    editCompleted = await evaluate('window.__editRetryCount === 2 && document.body.innerText.includes("Mock follow-up response 2") && !document.querySelector("[data-action=cancel-response]")');
    if (editCompleted) break;
    await delay(50);
  }
  assert.equal(editCompleted, true, "editing a sent user turn should resubmit the edited turn and finalize its response");

  // Conversation history supports durable custom titles, content search, and archive round-trips.
  await evaluate('document.querySelector("#historyList [data-action=rename-conversation]")?.click()');
  const renameDialogOpened = await evaluate('document.querySelector("#appDialog")?.open === true && document.querySelector("#appDialogField0") !== null');
  assert.equal(renameDialogOpened, true, "history should expose an in-app rename action");
  await evaluate('document.querySelector("#appDialogField0").value = "Persistent renamed smoke conversation"; document.querySelector("#appDialogForm").requestSubmit()');
  let renamed = false;
  for (let i = 0; i < 30; i++) {
    renamed = await evaluate('document.querySelector("#historyList")?.innerText.includes("Persistent renamed smoke conversation") === true');
    if (renamed) break;
    await delay(50);
  }
  assert.equal(renamed, true, "renaming should update the visible history title; history=" + await evaluate('document.querySelector("#historyList")?.innerText') + "; saved=" + await evaluate('JSON.stringify((JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").conversations||[]).map(c=>({id:c.id,title:c.title,titleCustom:c.titleCustom})))'));
  const titlePersisted = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").conversations?.some(c=>c.title==="Persistent renamed smoke conversation"&&c.titleCustom===true)===true');
  assert.equal(titlePersisted, true, "custom title and its lock flag should persist locally");
  await evaluate('document.querySelector("#chatInput").value = "Follow-up to preserve custom title"; document.querySelector("#chatForm").requestSubmit()');
  let customTitlePreserved = false;
  for (let i = 0; i < 50; i++) {
    customTitlePreserved = await evaluate('document.body.innerText.includes("Mock follow-up response 3") && document.querySelector("#historyList")?.innerText.includes("Persistent renamed smoke conversation") === true && !document.querySelector("[data-action=cancel-response]")');
    if (customTitlePreserved) break;
    await delay(50);
  }
  assert.equal(customTitlePreserved, true, "sending a later message must not overwrite a custom conversation title");
  await evaluate('(()=>{const q = document.querySelector("#conversationHistorySearch"); q.value = "Edited smoke user turn"; q.dispatchEvent(new Event("input", {bubbles:true}));})()');
  const contentSearchWorks = await evaluate('document.querySelector("#historyList")?.innerText.includes("Persistent renamed smoke conversation") === true');
  assert.equal(contentSearchWorks, true, "conversation history search should match older message content, not just titles");
  await evaluate('(()=>{const q = document.querySelector("#conversationHistorySearch"); q.value = ""; q.dispatchEvent(new Event("input", {bubbles:true})); document.querySelector("#historyList [data-action=toggle-archive-conversation]")?.click();})()');
  const archivedHidden = await evaluate('!document.querySelector("#historyList")?.innerText.includes("Persistent renamed smoke conversation")');
  assert.equal(archivedHidden, true, "archived conversations should leave the active history list");
  const archivePersisted = await evaluate('JSON.parse(localStorage.getItem("sparkle-data-v1")||"{}").conversations?.some(c=>c.title==="Persistent renamed smoke conversation"&&c.archived===true)===true');
  assert.equal(archivePersisted, true, "archive state should persist with the conversation record");
  let managedConversationSynced = false;
  for (let i = 0; i < 30; i++) {
    const managedResponse = await fetch(`${baseURL}/api/data`, { headers: { Authorization: `Bearer ${token}` } });
    const managedData = await managedResponse.json();
    managedConversationSynced = managedData.data?.conversations?.some(c=>c.title==="Persistent renamed smoke conversation"&&c.titleCustom===true&&c.archived===true)===true;
    if (managedConversationSynced) break;
    await delay(100);
  }
  assert.equal(managedConversationSynced, true, "renamed and archived conversation metadata should sync to the private server");
  await evaluate('document.querySelector("[data-action=toggle-archived-conversations]").click()');
  const archivedVisible = await evaluate('document.querySelector("#historyList")?.innerText.includes("Persistent renamed smoke conversation") === true && document.querySelector("[data-action=toggle-archive-conversation]") !== null');
  assert.equal(archivedVisible, true, "archived conversations should remain discoverable and offer unarchive");
  await evaluate('document.querySelector("#historyList [data-action=toggle-archive-conversation]")?.click(); document.querySelector("[data-action=toggle-archived-conversations]").click()');
  const unarchivedVisible = await evaluate('document.querySelector("#historyList")?.innerText.includes("Persistent renamed smoke conversation") === true');
  assert.equal(unarchivedVisible, true, "unarchiving should restore a conversation to active history");
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
  // While a request is active, navigation and New conversation must not detach
  // the pending response from its originating conversation.
  const isolationHeld = await evaluate('(()=>{ const before = document.querySelector("#conversation")?.innerText || ""; document.querySelector("#newChat").click(); document.querySelector("[data-view=settings]").click(); const after = document.querySelector("#conversation")?.innerText || ""; return before === after && !!document.querySelector("[data-action=cancel-response]") && !!document.querySelector("#conversation"); })()');
  assert.equal(isolationHeld, true, "New conversation and workspace navigation must leave an active response in its originating chat");
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
  // The destructive action is deliberately confirmation-gated; explicitly
  // submit its in-app confirmation dialog as a real user would.
  await evaluate('document.querySelector("#appDialogForm").requestSubmit()');
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
  console.log("PASS browser smoke: workspaces, theme/sidebar, mobile layout/navigation, pairing, Personal Core durable proposals, explicit task approval without privileged execution, and cross-device proposal sync without refresh; live workspace revision sync without reload, persisted-record CRUD and server sync, task/goal/learning/project/R&D sync, live simulation controls, deterministic five-point sweep, saved run manifests, Crossref/citations, reload recovery, streamed chat/timing, edit/retry, cancellation, backup restore, and confirmed workspace clearing");
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
