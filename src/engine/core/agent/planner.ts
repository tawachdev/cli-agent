import type { ModelBinding } from "../../models/router";
import type { PublishEvent } from "./loop";

const PLANNER_PROMPT =
  "You are the planning module of a coding agent. Produce a concise numbered plan (max 6 steps) for the task. Output only the plan.";

export async function runPlanner(
  binding: ModelBinding,
  numCtx: number,
  temperature: number,
  task: string,
  signal: AbortSignal | undefined,
  publish: PublishEvent,
): Promise<string> {
  let plan = "";
  for await (const chunk of binding.provider.complete(
    {
      model: binding.model,
      messages: [
        { role: "system", content: PLANNER_PROMPT },
        { role: "user", content: task },
      ],
      numCtx,
      temperature,
    },
    signal,
  )) {
    if (chunk.type === "token") {
      plan += chunk.text;
    }
  }
  const cleaned = plan.trim();
  publish("plan.updated", { plan: cleaned });
  return cleaned;
}
