import { vi } from "vitest";
import { AgentRunner, type CallOptions } from "../../src/agents/runner.js";
import type { TeamRules } from "../../src/team/rules.js";

/** An agent call of a team run, with the rules RULES.md held when its prompts were built. */
export interface RuleRead {
  member: string | null;
  schema: string | null;
  /** The whole prompt and, for a session that goes on, the continued one: the agent is given one of them. */
  prompts: string[];
  /** The texts of the rules in RULES.md as the call started. */
  rules: string[];
}

/**
 * Records every agent call with what `store`'s RULES.md holds as the call starts. `TeamRun.call` reads the rules and gives
 * the runner the prompts it built from them with no await in between, so these are the rules the call's prompts carry.
 * The fake agents' log cannot tell which calls came after a rule was written: it is in the order the processes started,
 * and a lesson turn runs beside the jobs started with it (`schedule`), so a call already on its way when the lesson's rule
 * is written may be logged after the lesson, rightly without the rule.
 */
export function recordRuleReads(store: () => TeamRules): RuleRead[] {
  const reads: RuleRead[] = [];
  const call = AgentRunner.prototype.call;
  vi.spyOn(AgentRunner.prototype, "call").mockImplementation(function (this: AgentRunner, o: CallOptions) {
    const resume = o.session?.resume?.prompt;
    reads.push({
      member: o.mode !== "text" && o.member ? o.member.name : null,
      schema: o.mode !== "text" ? o.schemaName : null,
      prompts: resume ? [o.prompt, resume] : [o.prompt],
      rules: store().rules().map((r) => r.text),
    });
    return call.call(this, o);
  });
  return reads;
}
