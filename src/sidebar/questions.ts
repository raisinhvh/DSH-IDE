import type { SidebarQuestion } from './view';

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Validates the ask_questions arguments sent by an agent. */
export function parseQuestions(args: Record<string, unknown>): { questions: SidebarQuestion[] } | { error: string } {
  const raw = args.questions;
  if (!Array.isArray(raw) || !raw.length) return { error: '"questions" must be a non-empty array.' };
  if (raw.length > 4) return { error: 'Ask at most 4 questions per call.' };
  const questions: SidebarQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const question = text(entry.question, 400);
    if (!question) return { error: `Question ${index + 1} needs a "question" string.` };
    const options = (Array.isArray(entry.options) ? entry.options : []).flatMap(option => {
      const candidate = (option && typeof option === 'object' ? option : {}) as Record<string, unknown>;
      const label = text(candidate.label, 120);
      return label ? [{ label, description: text(candidate.description, 300) || undefined }] : [];
    });
    if (options.length < 2 || options.length > 4) return { error: `Question ${index + 1} needs 2 to 4 options.` };
    questions.push({ question, header: text(entry.header, 12) || undefined, options });
  }
  return { questions };
}

/** Text returned to the agent. `answers` is null when the user skipped. */
export function formatAnswers(questions: SidebarQuestion[], answers: string[] | null): string {
  if (!answers) return 'The user skipped these questions without answering. Continue with your best judgement or ask again in plain text.';
  return questions.map((item, index) => `${index + 1}. ${item.question}\n   Answer: ${text(answers[index], 2000) || '(no answer)'}`).join('\n');
}
