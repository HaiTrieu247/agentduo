import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { emptyForm, formProblems, formSubmission, isAnswered, setWords, toggleOption } from "@agentduo/engine/clarification/form";
import { dismissable, keptByRun, type ClarificationAnswer, type ClarificationRequest } from "@agentduo/engine/clarification/clarification";
import { whoLabel } from "@agentduo/engine/format";

interface Props {
  request: ClarificationRequest;
  /** Every question answered: the answers, complete and valid. */
  onSubmit(answers: ClarificationAnswer[]): void;
  /** Answer later: Claude's call ends (it cannot wait across a restart); the planner's request stays saved. */
  onLater(): void;
  /** Claude only: tell it no answer is given. */
  onDismiss(): void;
}

/**
 * An agent's question with annotated options: all of the question (its header, the question, each option with its
 * description), a way to choose one or several, and a way to write something else. Nothing is chosen until the user
 * does it: the focus is not a selection, Enter on an option toggles it, and only Submit sends, once every question has
 * an answer.
 */
export function QuestionPrompt({ request, onSubmit, onLater, onDismiss }: Props) {
  const questions = request.questions;
  const [form, setForm] = useState(emptyForm);
  const [qi, setQi] = useState(0);
  const [row, setRow] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const canDismiss = dismissable(request);
  const q = questions[qi]!;
  // Rows of the question shown: its options, "something else", then the actions.
  const other = q.options.length;
  const submit = other + 1;
  const later = other + 2;
  const dismiss = canDismiss ? other + 3 : -1;
  const rows = other + (canDismiss ? 4 : 3);
  const picked = form.picked[q.id] ?? [];
  const words = (form.words[q.id] ?? "").trim();

  useInput((input, key) => {
    if (typing) {
      if (key.return) {
        setForm((f) => setWords(questions, f, q.id, draft));
        setTyping(false);
        setNotice("");
      } else if (key.escape) {
        setTyping(false);
        setDraft(form.words[q.id] ?? "");
      } else if (key.backspace || key.delete) setDraft((d) => d.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setDraft((d) => d + input.replace(/\r\n?/g, " ").replace(/\n/g, " "));
      return;
    }
    if (key.upArrow) setRow((r) => (r - 1 + rows) % rows);
    else if (key.downArrow) setRow((r) => (r + 1) % rows);
    else if (key.leftArrow || (key.tab && key.shift)) {
      setQi((i) => (i - 1 + questions.length) % questions.length);
      setRow(0);
    } else if (key.rightArrow || key.tab) {
      setQi((i) => (i + 1) % questions.length);
      setRow(0);
    } else if (key.escape) onLater();
    else if (input === " " && row < other) {
      setForm((f) => toggleOption(questions, f, q.id, q.options[row]!.id));
      setNotice("");
    } else if (key.return) {
      if (row < other) {
        setForm((f) => toggleOption(questions, f, q.id, q.options[row]!.id));
        setNotice("");
      } else if (row === other) {
        setDraft(form.words[q.id] ?? "");
        setTyping(true);
      } else if (row === submit) {
        const answers = formSubmission(questions, form);
        if (answers) onSubmit(answers);
        else setNotice(`Not yet: ${formProblems(questions, form).join("; ")}.`);
      } else if (row === later) onLater();
      else if (row === dismiss) onDismiss();
    }
  });

  const mark = (on: boolean) => (q.multiSelect ? (on ? "[x]" : "[ ]") : on ? "(•)" : "( )");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold wrap="truncate-end">
        {`? ${whoLabel(request.agent, request.role)} asks you ${questions.length === 1 ? "a question" : `${questions.length} questions`}`}
        {questions.length > 1 ? ` — ${qi + 1} of ${questions.length}` : ""}
      </Text>
      {questions.length > 1 ? (
        <Text dimColor wrap="truncate-end">
          {questions.map((x, i) => `${i === qi ? "▸" : " "}${i + 1}${isAnswered(x, form) ? "✓" : "·"}`).join("  ")}
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text bold wrap="wrap">{q.header ? `[${q.header}] ${q.question}` : q.question}</Text>
        <Text dimColor>{q.multiSelect ? "Several may apply: choose any number, or write your own." : "Choose one, or write your own."}</Text>
        {q.options.map((o, i) => (
          <Box key={o.id} flexDirection="column">
            <Text wrap="wrap">
              <Text color={row === i ? "cyan" : undefined}>{`${row === i ? "❯ " : "  "}${mark(picked.includes(o.id))} `}</Text>
              <Text bold={picked.includes(o.id)}>{o.label}</Text>
            </Text>
            {o.description ? <Text dimColor wrap="wrap">{`        ${o.description}`}</Text> : null}
          </Box>
        ))}
        <Box flexDirection="column">
          {typing ? (
            <Text wrap="wrap">
              <Text color="cyan">{"❯ ✎ "}</Text>
              {draft}
              <Text inverse> </Text>
            </Text>
          ) : (
            <Text wrap="wrap">
              <Text color={row === other ? "cyan" : undefined}>{`${row === other ? "❯ " : "  "}${words ? "[x]" : q.multiSelect ? "[ ]" : "( )"} `}</Text>
              <Text bold={!!words}>{words ? `Something else: ${words}` : "Something else…"}</Text>
            </Text>
          )}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {typing ? (
          <Text dimColor>Type your answer · Enter keeps it · Esc goes back</Text>
        ) : (
          <>
            <Text color={row === submit ? "cyan" : undefined} bold={row === submit}>{`${row === submit ? "❯ " : "  "}Submit answers`}</Text>
            <Text color={row === later ? "cyan" : undefined}>
              {`${row === later ? "❯ " : "  "}Answer later`}
              <Text dimColor>{keptByRun(request) ? "  (the run waits; /resume answers)" : "  (ends this answer; ask again after)"}</Text>
            </Text>
            {canDismiss ? (
              <Text color={row === dismiss ? "cyan" : undefined}>
                {`${row === dismiss ? "❯ " : "  "}Don't answer`}
                <Text dimColor>  (tells the agent it got no answer)</Text>
              </Text>
            ) : null}
            <Text dimColor wrap="truncate-end">{`  ↑↓ move · Enter/Space ${row < other ? "toggles" : "selects"} · ${questions.length > 1 ? "←→ question · " : ""}Esc answer later`}</Text>
          </>
        )}
        {notice ? <Text color="yellow" wrap="wrap">{notice}</Text> : null}
      </Box>
    </Box>
  );
}
