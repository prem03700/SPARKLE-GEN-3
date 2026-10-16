import test from "node:test";
import assert from "node:assert/strict";
import { createInitialUIState } from "../src/core/ui-state.js";
import { tasksView } from "../src/domains/tasks/view.js";

const pageHeading = (eyebrow, title, description) => `<header><small>${eyebrow}</small><h1>${title}</h1><p>${description}</p></header>`;

test("Tasks workspace renders task metadata, relations, filters, and safe empty states", () => {
  const state = createInitialUIState("light");
  state.tasks = [{ id: "t-1", title: "Study <robotics>", details: "Solve dynamics", status: "in-progress", done: false, priority: "urgent", dueDate: "2026-10-15", tags: ["study", "robotics"], goalId: "g-1", projectId: "p-1", createdAt: "2026-10-10T12:00:00Z" }];
  state.goals = [{ id: "g-1", title: "Master robotics" }];
  state.projects = [{ id: "p-1", name: "Robot arm" }];
  const html = tasksView({ state, pageHeading });
  for (const token of ["taskSearch", "taskStatusFilter", "taskSort", "taskSelectAll", "bulk-complete-tasks", "bulk-delete-tasks", "Study &lt;robotics&gt;", "priority-urgent", "Goal: Master robotics", "Project: Robot arm", "study", "robotics", "task-overdue", "task-record-details", "Record details", "local timezone", "no supported scheduler is connected"]) {
    assert.ok(html.includes(token), `expected task workspace output to include ${token}`);
  }
});

test("Tasks workspace preserves legacy done records and shows a useful initial empty state", () => {
  const state = createInitialUIState("light");
  state.tasks = [{ id: "legacy", title: "Finished legacy task", done: true, createdAt: "2026-10-10T00:00:00Z" }];
  const html = tasksView({ state, pageHeading });
  assert.match(html, /data-status="completed"/);
  assert.match(html, /checked aria-label="Mark open Finished legacy task"/);
  state.tasks = [];
  const empty = tasksView({ state, pageHeading });
  assert.match(empty, /No tasks yet/);
  assert.match(empty, /Create your first task/);
});
