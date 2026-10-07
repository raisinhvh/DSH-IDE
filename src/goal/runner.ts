import { MAX_JOB_ROUNDS } from './types';
import type { CheckResult, JobHost, JobState } from './types';
import { isStalled, nextCriterionId, parseBlocked, parseChecklist, parseVerdict } from './parse';
import { draftPrompt, fixPrompt, repairChecklistPrompt, revisePrompt, verifyPrompt, workPrompt } from './prompts';

export function createJob(spec: string): JobState {
  return { spec, phase: 'draft', round: 0, maxRounds: MAX_JOB_ROUNDS, criteria: [], decisions: [], failHistory: [] };
}

export function addDecision(job: JobState, question: string, answer: string): number {
  return job.decisions.push({ question, answer });
}

export async function runJob(job: JobState, host: JobHost): Promise<void> {
  const stop = async (reason: string): Promise<void> => {
    job.phase = 'stopped';
    job.stopReason = reason;
    await host.update(job);
  };
  const checkpoint = (): void => { if (host.cancelled()) throw new Error('Cancelled'); };
  const step = async <T>(call: () => Promise<T>): Promise<T> => {
    checkpoint();
    const result = await call();
    checkpoint();
    if (result === undefined) throw new Error('Cancelled');
    return result;
  };
  const update = async (): Promise<void> => { await host.update(job); checkpoint(); };
  const draft = async (prompt: string, label: string): Promise<boolean> => {
    let parsed = parseChecklist(await step(() => host.runTurn(prompt, label)) as string);
    if ('error' in parsed) {
      const error = parsed.error;
      parsed = parseChecklist(await step(() => host.runTurn(repairChecklistPrompt(error), '/job · fixing checklist format')) as string);
    }
    if ('error' in parsed) { await stop(`The agent did not return a checklist: ${parsed.error}`); return false; }
    if ('blocked' in parsed) { await stop(`Blocked: ${parsed.blocked}`); return false; }
    job.criteria = parsed.criteria.map((criterion, index) => ({ ...criterion, id: `C${index + 1}`, status: 'pending' }));
    await update();
    return true;
  };
  try {
    checkpoint();
    if (!await draft(draftPrompt(job), '/job · drafting checklist')) return;
    while (true) {
      const answers = await step(() => host.ask([{
        header: 'Checklist', question: 'Approve the job checklist shown in the job bar? Approving also lets DSH run its check commands without asking.',
        options: [{ label: 'Approve', description: 'Start working' }, { label: 'Stop job', description: 'End the job without working' }],
      }]));
      if (!answers || !answers.length) { await stop('Checklist not approved'); return; }
      const answer = answers[0];
      if (answer === 'Stop job') { await stop('Stopped by you'); return; }
      if (answer === 'Approve') break;
      addDecision(job, 'Checklist feedback', answer);
      await update();
      if (!await draft(revisePrompt(job, answer), '/job · revising checklist')) return;
    }
    for (let round = 1; round <= job.maxRounds; round++) {
      checkpoint();
      job.phase = 'work';
      job.round = round;
      await update();
      const failingIds = job.criteria.filter(criterion => criterion.status === 'fail').map(criterion => criterion.id);
      const label = `/job · round ${round}${round > 1 ? ` · fixing ${failingIds.join(', ')}` : ''}`;
      const reply = await step(() => host.runTurn(round === 1 ? workPrompt(job) : fixPrompt(job), label)) as string;
      const blocked = parseBlocked(reply);
      if (blocked) { await stop(`Blocked: ${blocked}`); return; }
      job.phase = 'verify';
      await update();
      const checks: CheckResult[] = [];
      for (const criterion of job.criteria) {
        if (!criterion.check) continue;
        const result = await step(() => host.runCheck(criterion.check!));
        checks.push({ id: criterion.id, command: criterion.check, ...result });
      }
      const ids = job.criteria.map(criterion => criterion.id);
      const reviewLabel = `/job · review ${round}`;
      let verdict = parseVerdict(await step(() => host.review(verifyPrompt(job, checks), reviewLabel)) as string, ids);
      if ('error' in verdict) {
        const note = `Your previous reply had invalid verdict JSON (${verdict.error}). Return the required JSON block.`;
        verdict = parseVerdict(await step(() => host.review(verifyPrompt(job, checks, note), reviewLabel)) as string, ids);
      }
      if ('error' in verdict) { await stop(`The reviewer did not return a verdict: ${verdict.error}`); return; }
      for (const result of verdict.results) {
        const criterion = job.criteria.find(item => item.id === result.id)!;
        const check = checks.find(item => item.id === result.id);
        criterion.status = result.pass ? 'pass' : 'fail';
        criterion.evidence = result.evidence;
        if (check && check.code !== 0) {
          criterion.status = 'fail';
          criterion.evidence = `\`${check.command}\` exited ${check.code ?? 'without finishing'}: ${check.output.slice(-600)}`;
        }
      }
      await update();
      for (let offset = 0; offset < verdict.unbacked.length; offset += 4) {
        const items = verdict.unbacked.slice(offset, offset + 4);
        const questions = items.map(item => ({
          header: 'Unbacked', question: `The work includes something the spec and your answers don't cover: ${item}. What should happen?`,
          options: [{ label: 'Keep it', description: 'Add it to the checklist as a requirement' }, { label: 'Remove it', description: 'The next round removes it' }],
        }));
        const answers = await step(() => host.ask(questions));
        if (!answers) continue;
        for (let index = 0; index < items.length; index++) {
          const answer = answers[index];
          if (answer === undefined) continue;
          const number = addDecision(job, questions[index].question, answer);
          await update();
          const item = items[index];
          job.criteria.push({
            id: nextCriterionId(job.criteria), text: answer === 'Keep it' ? `Keep: ${item}` : answer === 'Remove it' ? `Remove: ${item}` : `${item}: ${answer}`,
            source: `answer:${number}`, status: 'fail', evidence: 'Added from your answer',
          });
          await update();
        }
      }
      const failing = job.criteria.filter(criterion => criterion.status === 'fail').map(criterion => criterion.id).sort();
      job.failHistory.push(failing);
      await update();
      if (!failing.length) {
        job.phase = 'done';
        job.stopReason = 'All criteria pass';
        await update();
        return;
      }
      if (isStalled(job.failHistory)) { await stop(`Stalled: ${failing.join(', ')} failed two rounds in a row`); return; }
      if (round === job.maxRounds) { await stop(`Reached round ${job.maxRounds} with ${failing.length} failing`); return; }
    }
  } catch (error) {
    try { await stop(error instanceof Error ? error.message : String(error)); } catch {}
  }
}
