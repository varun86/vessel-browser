import assert from "node:assert/strict";
import test from "node:test";

import { isSafeAutomationKitId } from "../src/shared/automation-kit-constants";
import {
  buildSlashSkillValues,
  getSkillCommandTokens,
  getSkillSlashSuggestionQuery,
  getSkillSlashSuggestions,
  parseSkillSlashInvocation,
} from "../src/renderer/src/lib/automation-kits";
import type { AutomationKit } from "../src/shared/types";

const customSkill: AutomationKit = {
  id: "custom-research-helper",
  name: "Research Helper",
  description: "Research a topic",
  category: "research",
  icon: "Search",
  inputs: [
    {
      key: "topic",
      label: "Topic",
      type: "textarea",
      required: true,
    },
  ],
  promptTemplate: "Research {{topic}}",
};

const instructionOnlySkill: AutomationKit = {
  id: "summarize-page",
  name: "Summarize Page",
  description: "Summarize the active page",
  category: "research",
  icon: "FileText",
  inputs: [],
  promptTemplate: "Summarize the active page.",
};

const selfContainedTaskSkill: AutomationKit = {
  id: "custom-daily-brief",
  name: "Daily Brief",
  description: "Write a daily brief",
  category: "productivity",
  icon: "Zap",
  inputs: [
    {
      key: "task",
      label: "Task",
      type: "textarea",
      required: true,
    },
  ],
  promptTemplate: "Write a concise daily brief from the current page.\n\nTask:\n{{task}}",
};

const taskOnlySkill: AutomationKit = {
  id: "custom-task-only",
  name: "Task Only",
  description: "Requires task text",
  category: "productivity",
  icon: "Zap",
  inputs: [
    {
      key: "task",
      label: "Task",
      type: "textarea",
      required: true,
    },
  ],
  promptTemplate: "Task:\n{{task}}",
};

test("isSafeAutomationKitId rejects path separators and null bytes", () => {
  assert.equal(isSafeAutomationKitId("custom-kit"), true);
  assert.equal(isSafeAutomationKitId("nested/kit"), false);
  assert.equal(isSafeAutomationKitId("nested\\kit"), false);
  assert.equal(isSafeAutomationKitId("bad\0kit"), false);
});

test("skill slash commands match skill ids and name slugs", () => {
  assert.deepEqual(getSkillCommandTokens(customSkill), [
    "research-helper",
    "custom-research-helper",
  ]);

  assert.equal(
    parseSkillSlashInvocation(
      "/custom-research-helper compare sources",
      [customSkill],
    )?.task,
    "compare sources",
  );
  assert.equal(
    parseSkillSlashInvocation("/skill research-helper compare sources", [
      customSkill,
    ])?.kit.id,
    customSkill.id,
  );
  assert.deepEqual(
    parseSkillSlashInvocation("/summarize-page", [instructionOnlySkill]),
    { kit: instructionOnlySkill, task: "" },
  );
  assert.equal(parseSkillSlashInvocation("/unknown compare", [customSkill]), null);
});

test("buildSlashSkillValues fills a task-like required field", () => {
  const { values, missingLabels } = buildSlashSkillValues(
    customSkill,
    "compare sources",
  );

  assert.deepEqual(values, { topic: "compare sources" });
  assert.deepEqual(missingLabels, []);
});

test("buildSlashSkillValues allows instruction-only skills without task text", () => {
  const { values, missingLabels } = buildSlashSkillValues(
    instructionOnlySkill,
    "",
  );

  assert.deepEqual(values, {});
  assert.deepEqual(missingLabels, []);
});

test("buildSlashSkillValues allows self-contained simple task skills without slash task text", () => {
  const { values, missingLabels } = buildSlashSkillValues(
    selfContainedTaskSkill,
    "",
  );

  assert.deepEqual(values, { task: "" });
  assert.deepEqual(missingLabels, []);
});

test("buildSlashSkillValues still requires task text when the prompt is only a task placeholder", () => {
  const { values, missingLabels } = buildSlashSkillValues(taskOnlySkill, "");

  assert.deepEqual(values, { task: "" });
  assert.deepEqual(missingLabels, ["Task"]);
});

test("skill slash suggestions filter until task text begins", () => {
  assert.equal(getSkillSlashSuggestionQuery("/"), "");
  assert.equal(getSkillSlashSuggestionQuery("/skill research"), "research");
  assert.equal(getSkillSlashSuggestionQuery("/research-helper"), "research-helper");
  assert.equal(getSkillSlashSuggestionQuery("/research-helper compare"), null);

  assert.deepEqual(
    getSkillSlashSuggestions("/rese", [customSkill]).map((kit) => kit.id),
    [customSkill.id],
  );
  assert.deepEqual(
    getSkillSlashSuggestions("/skill helper", [customSkill]).map((kit) => kit.id),
    [customSkill.id],
  );
});
