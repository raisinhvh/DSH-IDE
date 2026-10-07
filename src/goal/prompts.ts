import type { CheckResult, JobCriterion, JobState } from './types';

const context = (job: JobState): string => `Spec:\n${job.spec}\n\nDecisions:\n${job.decisions.map((decision, index) => `#${index + 1} Q: ${decision.question} A: ${decision.answer}`).join('\n') || '(none yet)'}`;
const checklist = (criteria: JobCriterion[]): string => criteria.map(item => `${item.id} [${item.source}] ${item.text}${item.check ? ` — check: \`${item.check}\`` : ''}`).join('\n');
const draftRules = (job: JobState): string => `You are drafting a job checklist. You must be READ-ONLY: no creating, editing or deleting files; reading code is fine.
Find holes and undecided design decisions in the spec. Ask the user with ask_questions (or AskUserQuestion) over as many rounds as needed. Never fill a gap yourself. Answers are added to the decisions log numbered from #${job.decisions.length + 1} in the order asked; use those numbers for answer sources.
Use one observable/testable criterion per line, without duplicates or restating the spec wholesale. Tag source as "spec", "checklist" (the user's own checklist in the spec), or "answer:N". Optional "check" is a shell command whose exit code 0 proves that criterion; only use commands safe to repeat (tests, type checks, linters).
If the spec cannot be done, return {"blocked":"reason"}. Otherwise end with exactly one \`\`\`json block containing {"criteria":[{"text":"...","source":"spec","check":"optional command"}]}. The user sees the checklist in the job bar; do not repeat it in prose.`;
const workRules = `Do the work in the working copy. If any decision is not covered by the spec or decisions log, call ask_questions immediately instead of guessing. If you cannot proceed, end your reply with a line JOB BLOCKED: <reason>. A separate review checks every criterion against the files, so do not claim completion; finish with a short summary of what changed.`;

export function draftPrompt(job: JobState): string {
  return `${draftRules(job)}\n\n${context(job)}`;
}

export function revisePrompt(job: JobState, feedback: string): string {
  return `${draftRules(job)}\nProduce the full revised checklist JSON.\n\n${context(job)}\n\nCurrent checklist:\n${checklist(job.criteria)}\n\nUser feedback:\n${feedback}`;
}

export function repairChecklistPrompt(error: string): string {
  return `Your last reply had no valid checklist JSON (${error}). Reply with only the \`\`\`json block.`;
}

export function workPrompt(job: JobState): string {
  return `${workRules}\n\n${context(job)}\n\nChecklist:\n${checklist(job.criteria)}`;
}

export function fixPrompt(job: JobState): string {
  const failing = job.criteria.filter(item => item.status === 'fail');
  return `Round ${job.round}. Fix these failing criteria.\n${workRules}\n\n${context(job)}\n\nFailing criteria:\n${failing.map(item => `${checklist([item])}\nEvidence: ${item.evidence || '(none)'}`).join('\n')}`;
}

export function verifyPrompt(job: JobState, checks: CheckResult[], retryNote?: string): string {
  return `${retryNote ? retryNote + '\n\n' : ''}You are the READ-ONLY reviewer: no creating, editing or deleting files. Check every criterion against the actual files in the working copy, not against the worker's claims. Cite evidence (path:line or command output). A criterion whose check exited non-zero or did not finish fails.
List "unbacked": design choices in this job's changes that neither the spec nor the decisions log supports (empty array if none).
End with exactly one \`\`\`json block containing {"results":[{"id":"C1","pass":true,"evidence":"..."}],"unbacked":["..."]}.
\n${context(job)}\n\nChecklist:\n${checklist(job.criteria)}\n\nCheck results:\n${checks.map(check => `${check.id}: \`${check.command}\`\nExit code: ${check.code ?? 'without finishing'}\nOutput tail:\n${check.output.slice(-2000)}`).join('\n\n') || '(no check commands)'}`;
}
