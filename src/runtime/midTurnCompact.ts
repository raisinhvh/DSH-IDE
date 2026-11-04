import { KEEP_IMAGES } from './imageTrim';

/**
 * Mid-turn compaction, the same for every provider. Once a running turn's conversation passes the auto compaction
 * threshold DSH asks the agent to save a checkpoint and stop. The work then continues in a fresh session from that
 * checkpoint, without waiting for the user's next message. Main chats save it with the checkpoint tool; subagents,
 * which may have no DSH tools, reply with it.
 *
 * Claude Code (stdin) and Codex (turn/steer) take the request into the running turn. ACP has no way to do that, so DSH
 * stops the prompt there and sends the request as the session's next prompt.
 */
export interface CompactWatch {
  /** Tokens of conversation, beyond the session's fixed overhead, at which the agent is asked. */
  threshold: number;
  /** Context when the agent was first asked. */
  askedAt?: number;
  /** Set once the request was repeated. */
  urged?: boolean;
  /** ACP only: the request to send once the stopped prompt has returned. */
  followUp?: string;
}

/** Opens a request sent as a new prompt after DSH stopped the running one. */
export const PAUSED_NOTE = 'DSH stopped your last step to send this; if it was cut off, finish or redo it first. ';

/** A running turn: Claude Code and Codex take a message into it; an ACP prompt can only be stopped. */
export type TurnChannel = { say(text: string): boolean } | { interrupt(): boolean };

/** Sends a compaction request to the running turn. False when no turn is running. */
export function sendCompactRequest(watch: CompactWatch, turn: TurnChannel, text: string): boolean {
  if ('say' in turn) return turn.say(text);
  if (!turn.interrupt()) return false;
  watch.followUp = PAUSED_NOTE + text;
  return true;
}

/** The request waiting for a stopped ACP prompt to return, cleared as it is taken. */
export function takeFollowUp(watch: CompactWatch | undefined): string | undefined {
  const text = watch?.followUp;
  if (watch) watch.followUp = undefined;
  return text;
}

/** Growth after the first request at which it is repeated more firmly. */
export const URGE_AFTER_TOKENS = 30_000;

/** Fresh sessions one subagent run may continue into, so a run that keeps filling its context still ends. */
export const MAX_SUBAGENT_SEGMENTS = 8;

/** First line of a subagent's checkpoint reply. */
export const CHECKPOINT_MARKER = 'CHECKPOINT';

/** What to tell the agent after a context report of `conversation` tokens: nothing, the request, or a firmer repeat. */
export function compactStep(watch: CompactWatch, conversation: number): 'ask' | 'urge' | undefined {
  if (watch.askedAt === undefined) {
    if (conversation < watch.threshold) return undefined;
    watch.askedAt = conversation;
    return 'ask';
  }
  if (!watch.urged && conversation >= watch.askedAt + URGE_AFTER_TOKENS) {
    watch.urged = true;
    return 'urge';
  }
  return undefined;
}

const SUMMARY_CONTENTS = `what is done, the decisions and why, the current state (values, settings, what works and what does not), files changed, the paths of up to ${KEEP_IMAGES} images you still need, and the exact next step`;

/** The message that asks a main-chat agent to checkpoint. */
export function chatCompactRequest(tokens: number, urge: boolean): string {
  const size = `about ${Math.round(tokens / 1000)}k tokens`;
  if (urge) return `DSH: context is ${size}. Call checkpoint now, then end your turn with one short line. DSH continues the task automatically.`;
  return `DSH: this turn's context is ${size}, past the auto compaction limit. Finish the step you are on without starting a new one, then call checkpoint. `
    + `Its summary is all the next session gets: ${SUMMARY_CONTENTS}. Then end your turn with one short line. `
    + 'DSH continues the task in a fresh session automatically; do not ask the user anything. '
    + 'If the whole task is already finished, skip the checkpoint and give your final answer as usual.';
}

/** The message that asks a subagent to reply with a checkpoint. */
export function subagentCompactRequest(tokens: number, urge: boolean): string {
  const size = `about ${Math.round(tokens / 1000)}k tokens`;
  if (urge) return `DSH: context is ${size}. Stop now and reply with only your checkpoint, starting with the line "${CHECKPOINT_MARKER}".`;
  return `DSH: your context is ${size}, past the auto compaction limit. Finish the step you are on without starting a new one, then stop and reply with only a checkpoint for yourself, `
    + `starting with the line "${CHECKPOINT_MARKER}". Besides your original task it is all your next session gets: ${SUMMARY_CONTENTS}. `
    + 'DSH then continues the task in a fresh session automatically. '
    + `If the whole task is already finished, do not write a checkpoint: reply with your final report as usual, without the word ${CHECKPOINT_MARKER}.`;
}

/** The checkpoint in a subagent's reply since it was asked, or undefined when it ended without one (for example because it had finished). */
export function subagentCheckpoint(replySinceAsked: string): string | undefined {
  const at = replySinceAsked.lastIndexOf(CHECKPOINT_MARKER);
  if (at < 0) return undefined;
  const summary = replySinceAsked.slice(at + CHECKPOINT_MARKER.length).replace(/^[*_#:\t ]+/, '').trim();
  return summary || undefined;
}

/** The opening of a subagent's next session: the original task and its checkpoint. */
export function subagentResumeTask(task: string, checkpoint: string, segment: number): string {
  return `${task}\n\n---\nYou already worked on this task. DSH ended that session (part ${segment}) to save context; your checkpoint from it:\n\n${checkpoint}\n\n`
    + 'Continue from the checkpoint. Do not redo finished work; check the working copy when unsure what is already there.';
}

/** The internal message that continues a main chat after a mid-turn checkpoint. */
export const CONTINUE_AFTER_CHECKPOINT = 'Continue the task from your checkpoint. (DSH ended the previous session to save context; the user has not sent anything new.)';
