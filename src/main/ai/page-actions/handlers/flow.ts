import type { ActionContext } from "../core";
import { coerceStringArray } from "../../../tools/input-coercion";

export function handleFlowStart(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const goal = typeof args.goal === "string" ? args.goal : "";
  const steps = coerceStringArray(args.steps) ?? [];
  if (!goal || steps.length === 0) return "Error: goal and steps are required";
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  const flow = ctx.runtime.startFlow(goal, steps, wc?.getURL());
  return `Flow started: ${flow.goal}\n${flow.steps.map((s, i) => `  ${i === 0 ? "→" : " "} ${s.label}`).join("\n")}`;
}

export function handleFlowAdvance(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const flow = ctx.runtime.advanceFlow(
    typeof args.detail === "string" ? args.detail : undefined,
  );
  if (!flow) return "No active flow to advance";
  return `Step completed.${ctx.runtime.getFlowContext()}`;
}

export function handleFlowStatus(ctx: ActionContext): string {
  const flow = ctx.runtime.getFlowState();
  if (!flow) return "No active workflow.";
  return ctx.runtime.getFlowContext();
}

export function handleFlowEnd(ctx: ActionContext): string {
  ctx.runtime.clearFlow();
  return "Workflow ended.";
}
