import type { SidebarQuestion } from '../sidebar/view';

/** A job ends after this many work rounds even if criteria still fail. */
export const MAX_JOB_ROUNDS = 7;

export type JobPhase = 'draft' | 'work' | 'verify' | 'done' | 'stopped';
export type CriterionStatus = 'pending' | 'pass' | 'fail';

/** One acceptance criterion. `source` is 'spec', 'checklist' (the user's own list) or 'answer:N' (decisions[N - 1]). */
export interface JobCriterion { id: string; text: string; source: string; check?: string; status: CriterionStatus; evidence?: string }
export interface JobDecision { question: string; answer: string }

/** A /job run, saved on the chat's session record. */
export interface JobState {
  spec: string;
  criteria: JobCriterion[];
  decisions: JobDecision[];
  /** Work rounds started so far; 0 while drafting. */
  round: number;
  maxRounds: number;
  phase: JobPhase;
  stopReason?: string;
  /** Failing criterion ids from each review, oldest first. */
  failHistory: string[][];
}

export interface JobVerdict { results: { id: string; pass: boolean; evidence: string }[]; unbacked: string[] }
export interface CheckResult { id: string; command: string; code: number | null; output: string }

/** What the job loop needs from the extension. */
export interface JobHost {
  /** Runs one turn in the job's chat, shown in the chat as `label`. Resolves with the agent's reply, or undefined if the turn was cancelled. */
  runTurn(prompt: string, label: string): Promise<string | undefined>;
  /** Runs the reviewer (a separate read-only agent, or a turn in the same chat). Resolves with its reply, or undefined if cancelled. */
  review(prompt: string, label: string): Promise<string | undefined>;
  /** Shows questions in the chat. Resolves with one answer per question, or null if skipped/cancelled. */
  ask(questions: SidebarQuestion[]): Promise<string[] | null>;
  /** Runs a check command in the working copy. */
  runCheck(command: string): Promise<{ code: number | null; output: string }>;
  /** Persists the job and shows it in the job bar. Called after every state change. */
  update(job: JobState): void | Promise<void>;
  /** True once the user cancelled the chat's task. */
  cancelled(): boolean;
}
