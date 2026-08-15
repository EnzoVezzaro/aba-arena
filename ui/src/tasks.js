/**
 * The default benchmark series. Each task runs on BOTH panels (ACC vs
 * no-ACC) with the same repository context and the same model config.
 *
 * The success check is a transparent heuristic (output length + content
 * hints) — it is displayed as such in the UI, never presented as a
 * rigorous metric.
 */
export const DEFAULT_TASKS = [
  {
    title: 'Repository comprehension',
    prompt:
      'Summarize this repository: its purpose, main modules and how they relate, and the conventions a contributor must follow. Be specific and concrete.',
    hints: [/module|component|service|architecture|api|package/i, /convention|pattern|style|rule/i],
    minChars: 120,
  },
  {
    title: 'Write a unit test',
    prompt:
      'Write one meaningful unit test for the primary module of this repository. Explain in one short paragraph what it verifies, then give the test code.',
    hints: [/test|assert|expect|describe|it\(/i, /```/],
    minChars: 120,
  },
  {
    title: 'Find and fix a bug',
    prompt:
      'Find the most likely bug or code smell in the main source files of this repository. Propose a concrete fix, including a code snippet showing the corrected code.',
    hints: [/bug|smell|issue|risk|fix/i, /```/],
    minChars: 150,
  },
  {
    title: 'Add a feature (plan)',
    prompt:
      'Explain how you would add a new feature to this project following its existing conventions: which files you would touch, in what order, and how you would validate the change.',
    hints: [/feature|step|file|module|implement/i],
    minChars: 120,
  },
];

export function checkSuccess(output, task) {
  const text = output || '';
  if (text.trim().length < (task.minChars || 100)) return false;
  if (task.hints && task.hints.length > 0) {
    return task.hints.some((re) => re.test(text));
  }
  return true;
}
