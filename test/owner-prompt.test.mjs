// Run: npm test. Answering the run's pending question or permission from the card: normalizing the
// requests, the owner's selections, the exact response shapes, and that only the card answers.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  answersOnClick,
  cleanPromptText,
  isComplete,
  MAX_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_QUESTIONS,
  ownerPrompts,
  permissionResponse,
  questionResponse,
  selectOption,
} from "../shared/owner-prompt.ts";

// The shape Paseo's Claude provider gives AskUserQuestion (allowOther added by Paseo).
const question = (overrides = {}) => ({
  id: "perm-1",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: {
    questions: [
      {
        question: "Which of the two Save buttons should I use?",
        header: "Save button",
        options: [
          { label: "Top", description: "The one in the header" },
          { label: "Bottom", description: "The one under the form" },
        ],
        multiSelect: false,
        allowOther: true,
      },
    ],
  },
  ...overrides,
});

test("a question request becomes a card prompt", () => {
  const [prompt] = ownerPrompts([question()]);
  assert.deepEqual(prompt, {
    kind: "question",
    requestId: "perm-1",
    questions: [
      {
        key: "Which of the two Save buttons should I use?",
        text: "Which of the two Save buttons should I use?",
        header: "Save button",
        options: [
          { label: "Top", description: "The one in the header" },
          { label: "Bottom", description: "The one under the form" },
        ],
        multiSelect: false,
        allowOther: true,
      },
    ],
  });
});

test("permission requests get their actions, or Allow and Deny", () => {
  const [withActions, plain] = ownerPrompts([
    {
      id: "perm-2",
      kind: "tool",
      name: "browser_click",
      title: "Click “Delete project”",
      description: "On example.com settings",
      actions: [
        { id: "allow-once", label: "Allow once", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny" },
        { id: "weird", label: "Weird", behavior: "maybe" },
      ],
    },
    { id: "perm-3", kind: "tool", name: "browser_fill" },
  ]);
  assert.deepEqual(withActions, {
    kind: "permission",
    requestId: "perm-2",
    title: "Click “Delete project”",
    description: "On example.com settings",
    actions: [
      { id: "allow-once", label: "Allow once", behavior: "allow" },
      { id: "deny", label: "Deny", behavior: "deny" },
    ],
  });
  assert.deepEqual(plain.actions.map((action) => action.label), ["Allow", "Deny"]);
  assert.equal(plain.title, "browser_fill");
});

test("unusable requests are left to the run view; counts are capped", () => {
  assert.deepEqual(ownerPrompts([question({ id: "" }), question({ input: { questions: [] } }), question({ input: null })]), []);
  assert.deepEqual(ownerPrompts(null), []);
  const many = question({
    input: {
      questions: Array.from({ length: 6 }, (_, q) => ({
        question: `Question ${q}?`,
        options: Array.from({ length: 12 }, (_, o) => ({ label: `Option ${o}` })),
      })),
    },
  });
  const [prompt] = ownerPrompts([many]);
  assert.equal(prompt.questions.length, MAX_QUESTIONS);
  assert.equal(prompt.questions[0].options.length, MAX_OPTIONS);
});

test("text from the run is cleaned and capped for display; the answer key stays the full question", () => {
  assert.equal(cleanPromptText("A​‮B\u0007  C", 50), "AB C");
  assert.equal(cleanPromptText("line 1\r\nline 2\n\n\n\nline 3\u0007", 50, true), "line 1\nline 2\n\nline 3");
  assert.equal(cleanPromptText(42, 10), "");
  const long = "x".repeat(MAX_QUESTION_TEXT + 50);
  const [prompt] = ownerPrompts([question({ input: { questions: [{ question: long, options: [{ label: "OK" }] }] } })]);
  assert.equal(prompt.questions[0].text.length, MAX_QUESTION_TEXT);
  assert.equal(prompt.questions[0].key, long, "Paseo matches answers on the full question text");
});

test("one single-choice question answers on click; others need Send", () => {
  const [single] = ownerPrompts([question()]);
  assert.equal(answersOnClick(single), true);
  const [multi] = ownerPrompts([question({ input: { questions: [{ question: "Pick", options: [{ label: "A" }], multiSelect: true }] } })]);
  assert.equal(answersOnClick(multi), false);
  const [two] = ownerPrompts([question({ input: { questions: [{ question: "One?", options: [{ label: "A" }] }, { question: "Two?", options: [{ label: "B" }] }] } })]);
  assert.equal(answersOnClick(two), false);
  const [free] = ownerPrompts([question({ input: { questions: [{ question: "Type the code?" }] } })]);
  assert.equal(answersOnClick(free), false, "no options: only Open run");
});

test("selections: single choice replaces, multiple choice toggles, unknown labels are ignored", () => {
  const [single] = ownerPrompts([question()]);
  let selections = selectOption(single, {}, 0, "Top");
  selections = selectOption(single, selections, 0, "Bottom");
  assert.deepEqual(selections, { 0: ["Bottom"] });
  assert.deepEqual(selectOption(single, selections, 0, "Sideways"), selections);
  assert.deepEqual(selectOption(single, selections, 5, "Top"), selections);
  const [multi] = ownerPrompts([question({ input: { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: true }] } })]);
  let picks = selectOption(multi, {}, 0, "A");
  picks = selectOption(multi, picks, 0, "B");
  assert.deepEqual(picks, { 0: ["A", "B"] });
  assert.deepEqual(selectOption(multi, picks, 0, "A"), { 0: ["B"] });
});

test("the question answer is keyed by full question text, choices joined, only when complete", () => {
  const [two] = ownerPrompts([
    question({
      input: {
        questions: [
          { question: "Which environment?", options: [{ label: "Staging" }, { label: "Production" }] },
          { question: "Which checks?", options: [{ label: "Lint" }, { label: "Types" }], multiSelect: true },
        ],
      },
    }),
  ]);
  assert.equal(questionResponse(two, { 0: ["Staging"] }), null);
  assert.equal(isComplete(two, { 0: ["Staging"], 1: [] }), false);
  assert.deepEqual(questionResponse(two, { 0: ["Staging"], 1: ["Lint", "Types"] }), {
    behavior: "allow",
    updatedInput: { answers: { "Which environment?": "Staging", "Which checks?": "Lint, Types" } },
  });
});

test("permission responses carry the pressed action", () => {
  assert.deepEqual(permissionResponse({ id: "allow-once", label: "Allow once", behavior: "allow" }), { behavior: "allow", selectedActionId: "allow-once" });
  assert.deepEqual(permissionResponse({ id: null, label: "Allow", behavior: "allow" }), { behavior: "allow" });
  assert.deepEqual(permissionResponse({ id: null, label: "Deny", behavior: "deny" }), { behavior: "deny", message: "The owner declined on the card." });
});

test("owner questions are answered only from the card: nothing else calls respondToPermission", () => {
  const root = new URL("..", import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".") || name === "test" || name === "scripts") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const callers = files.filter((file) => /respondToPermission\s*\(/.test(readFileSync(file, "utf8"))).map((file) => file.slice(root.length));
  assert.deepEqual(callers, ["client/owner-prompt.tsx"], "the server and the chat paths never answer for the owner");
});
