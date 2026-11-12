// Outputs of the team's turns (packages/engine/schemas/team_*.schema.json), for tests and fake-agent scenarios.

export const brief = (criteria = ["Subtraction works on two numbers"]) => ({
  title: "Add subtraction",
  goal: "The calculator can subtract.",
  scope: ["a sub(a, b) function"],
  out_of_scope: ["a user interface"],
  constraints: [],
  criteria: criteria.map((criterion, i) => ({ id: `AC${i + 1}`, criterion })),
  notes: null,
});

export const task = (id: string, over: Partial<ReturnType<typeof baseTask>> = {}) => ({ ...baseTask(id), ...over });
const baseTask = (id: string) => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  assignee: "dev-1",
  testers: ["qa-1"],
  area: [`src/${id.toLowerCase()}.ts`],
  depends_on: [] as string[],
  criteria: ["AC1"],
  test_focus: "the happy path and the boundaries",
});

/** The PM's turns, one per action. */
export const teamPm = {
  none: (message: string | null = "Noted.") => ({ message, action: { kind: "none" } }),
  questions: (message: string | null = null) => ({
    message,
    action: {
      kind: "questions",
      questions: [{
        header: "Scope", question: "Should subtraction handle decimals?", multi_select: false,
        options: [{ label: "Yes", description: "Floats too" }, { label: "No", description: "Integers only" }],
      }],
    },
  }),
  brief: (b = brief()) => ({ message: "Here is what I understood.", action: { kind: "brief", brief: b } }),
  planReview: (approve: boolean, summary: string | null = approve ? "Two tasks: the function, then its docs." : null, group: string | null = null) => ({
    message: null,
    action: { kind: "plan_review", approve, issues: approve ? [] : [{ id: "P1", issue: "AC1 has no task", group }], summary },
  }),
  leadNote: (note = "Integers only.", group: string | null = null) => ({ message: "I told the techlead.", action: { kind: "lead_note", note, group } }),
  escalate: (questionId: string, question = "Should it round? The techlead cannot tell.") => ({ message: null, action: { kind: "escalate", question_id: questionId, question } }),
  areas: (areas: Array<{ group: string; area?: string; criteria: string[] }>) => ({
    message: null, action: { kind: "areas", areas: areas.map((a) => ({ group: a.group, area: a.area ?? `The ${a.group} part.`, criteria: a.criteria })) },
  }),
  teamAnswer: (questionId: string, answer = "Integers only.") => ({ message: null, action: { kind: "team_answer", question_id: questionId, answer } }),
  changeRequest: (b = brief(["Subtraction works", "Multiplication works"])) => ({ message: "That changes the scope.", action: { kind: "change_request", brief: b } }),
  acceptance: (status: "met" | "partly" | "not_met" = "met") => ({
    message: "The work is done.",
    action: { kind: "acceptance", criteria: [{ id: "AC1", status, evidence: "qa-1: C1 passes" }], summary: "Subtraction is in." },
  }),
};

export const teamPlan = (tasks = [task("T1")]) => ({ summary: "One task.", tasks, risks: [], report: `Plan: ${tasks.length} task(s).` });

export const teamWork = (status: "done" | "blocked" = "done", question: string | null = status === "blocked" ? "Integers or floats?" : null) => ({
  status, summary: status === "done" ? "Implemented it." : "I need an answer.", files_changed: ["src/t1.ts"], question, notes: [],
});

export const teamReview = (verdict: "approve" | "changes" = "approve") => ({
  verdict,
  summary: verdict === "approve" ? "Looks good." : "One problem.",
  findings: verdict === "approve" ? [] : [{
    id: "R1", severity: "high", file: "src/t1.ts", line: 3, title: "Wrong sign", detail: "a - b is b - a", criteria: ["AC1"], origin: "in_scope",
  }],
});

export const teamTests = () => ({
  summary: "Two cases.", test_files: ["test/t1.test.ts"],
  cases: [{ id: "C1", criterion: "AC1", description: "3 - 1 = 2" }, { id: "C2", criterion: null, description: "0 - 0 = 0" }],
  how_to_run: "node test/t1.test.mjs",
});

export const teamCheck = (verdict: "pass" | "fail" = "pass", suspect: "code" | "test" | "plan" = "code") => ({
  verdict,
  summary: verdict === "pass" ? "All cases pass." : "C1 fails.",
  results: [{ case: "C1", status: verdict, detail: "" }],
  failures: verdict === "pass" ? [] : [{
    id: "Q1", title: "C1 fails", detail: "sub(3, 1) returned -2", reproduction: "node test/t1.test.mjs", expected: "2", actual: "-2", criteria: ["AC1"], suspect,
  }],
  added_tests: [],
});

export const teamTriage = (
  action: "retry" | "reassign" | "fix_tests" | "add_tasks" | "escalate" = "retry",
  over: { assignee?: string | null; question?: string | null; tasks?: ReturnType<typeof task>[] } = {},
) => ({
  action,
  assignee: over.assignee ?? (action === "reassign" ? "dev-2" : null),
  guidance: "Swap the operands.",
  question: over.question ?? (action === "escalate" ? "Should it round?" : null),
  tasks: over.tasks ?? (action === "add_tasks" ? [task("T9")] : []),
  report: `Triage: ${action}.`,
});

export const teamAnswer = (answer: string | null = "Integers only.", escalate: string | null = null) => ({ answer, escalate, report: null });
