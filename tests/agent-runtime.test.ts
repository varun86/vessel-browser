import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app } from "electron";
import { AgentRuntime } from "../src/main/agent/runtime";
import type { SessionSnapshot } from "../src/shared/types";

function makeRuntime(): AgentRuntime {
  const tabManager = {
    snapshotSession: (): SessionSnapshot => ({ tabs: [], activeTabId: null }),
    restoreSession: () => {},
  };
  return new AgentRuntime(tabManager as never);
}

test("updateCheckpointNote updates the matching checkpoint by id", async () => {
  const statePath = path.join(app.getPath("userData"), "vessel-agent-runtime.json");
  await fs.rm(statePath, { force: true });

  const runtime = makeRuntime();
  const checkpoint = runtime.createCheckpoint("Before risky flow", "old note");

  const updated = runtime.updateCheckpointNote(checkpoint.id, "new note");

  assert.ok(updated);
  assert.equal(updated.id, checkpoint.id);
  assert.equal(updated.note, "new note");
  assert.equal(runtime.getState().checkpoints[0]?.note, "new note");
});

test("auto approval mode bypasses explicitly approval-gated actions", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("auto");

  const result = await runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    dangerous: true,
    requiresApproval: true,
    executor: async () => "navigated",
  });

  assert.equal(result, "navigated");
  assert.equal(runtime.getState().supervisor.pendingApprovals.length, 0);
  assert.equal(runtime.getState().actions[0]?.status, "completed");
});

test("confirm-dangerous still pauses explicitly approval-gated actions", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("confirm-dangerous");

  const resultPromise = runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    dangerous: true,
    requiresApproval: true,
    executor: async () => "navigated",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  assert.equal(runtime.getState().actions[0]?.status, "waiting-approval");

  runtime.resolveApproval(approval.id, true);
  assert.equal(await resultPromise, "navigated");
});

test("paused supervisor still requires approval even in auto mode", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("auto");
  runtime.pause();

  const resultPromise = runtime.runControlledAction({
    source: "ai",
    name: "read_page",
    executor: async () => "read",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  assert.match(approval.reason, /paused/i);

  runtime.resolveApproval(approval.id, false);
  assert.equal(await resultPromise, "Action rejected: read_page");
});
