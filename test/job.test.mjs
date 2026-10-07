import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractJson, parseChecklist, parseVerdict, parseBlocked, isStalled, nextCriterionId } from '../dist/goal/parse.mjs';
import { draftPrompt, revisePrompt, repairChecklistPrompt, workPrompt, fixPrompt, verifyPrompt } from '../dist/goal/prompts.mjs';
import { createJob, addDecision, runJob } from '../dist/goal/runner.mjs';
import { parseSlash } from '../dist/slash/registry.mjs';

const json = value => '```json\n' + JSON.stringify(value) + '\n```';
const draft = (criteria = [{ text: 'Works', source: 'spec' }]) => json({ criteria });
const verdict = (results = [['C1', true]], unbacked = []) => json({ results: results.map(([id, pass]) => ({ id, pass, evidence: `${id} inspected` })), unbacked });

function scripted({ turns = [], reviews = [], answers = [['Approve']], checks = [], cancelled = () => false, notes = [] } = {}) {
  const calls = [], updates = [];
  const take = (queue, name) => { assert.ok(queue.length, `Unexpected ${name}`); return queue.shift(); };
  return {
    calls, updates, notes,
    host: {
      runTurn: async (prompt, label) => { calls.push({ kind: 'turn', prompt, label }); return take(turns, 'turn'); },
      review: async (prompt, label) => { calls.push({ kind: 'review', prompt, label }); return take(reviews, 'review'); },
      ask: async questions => { calls.push({ kind: 'ask', questions }); return take(answers, 'ask'); },
      runCheck: async command => { calls.push({ kind: 'check', command }); return take(checks, 'check'); },
      update: job => updates.push(structuredClone(job)),
      cancelled,
      takeNotes: () => notes.splice(0),
    },
  };
}

/** A host whose user sends `note` while the `index`th call of `kind` runs, ending that call early. */
function interruptedAt(fake, kind, index, note) {
  const original = fake.host[kind];
  let count = 0;
  fake.host[kind] = async (...args) => {
    if (count++ !== index) return original(...args);
    fake.calls.push({ kind: `interrupted ${kind}`, args });
    fake.notes.push(note);
    return kind === 'ask' ? null : undefined;
  };
  return fake;
}

test('parses known slash commands and leaves ordinary or unknown messages alone', () => {
  assert.deepEqual(parseSlash('/job spec'), { name: 'job', args: 'spec' });
  assert.deepEqual(parseSlash('/job'), { name: 'job', args: '' });
  assert.equal(parseSlash('/foo'), undefined);
  assert.equal(parseSlash('plain text'), undefined);
});

test('extracts the last JSON fence or balanced object, respecting strings and escapes', () => {
  assert.deepEqual(extractJson(json({ first: true }) + '\n' + json({ last: true })), { last: true });
  assert.deepEqual(extractJson('```\n{"bare":true}\n```'), { bare: true });
  const value = { text: 'a } brace and "quote"', nested: { ok: true } };
  assert.deepEqual(extractJson('old {"old":true} prose ' + JSON.stringify(value) + ' end'), value);
  assert.equal(extractJson('no JSON {broken}'), undefined);
});

test('checklists trim, dedupe, validate sources and preserve safe command strings', () => {
  assert.deepEqual(parseChecklist(draft([
    { text: ' Works ', source: 'answer:2', check: ' npm test ' },
    { text: 'works', source: 'checklist' }, { text: ' ', source: 'spec' },
    { text: 'Other', source: 'made-up', check: '' }, { text: 'Listed', source: 'checklist' },
  ])), { criteria: [
    { text: 'Works', source: 'answer:2', check: 'npm test' },
    { text: 'Other', source: 'spec' }, { text: 'Listed', source: 'checklist' },
  ] });
  assert.deepEqual(parseChecklist(json({ blocked: ' Impossible ' })), { blocked: 'Impossible' });
  assert.ok('error' in parseChecklist('bad'));
  assert.ok('error' in parseChecklist(draft([])));
});

test('verdicts fail missing ids, ignore unknown ids, and require boolean passes', () => {
  const parsed = parseVerdict(json({ results: [{ id: 'C1', pass: 'true', evidence: ' no ' }, { id: 'C99', pass: true }], unbacked: [' choice ', '', 'choice', 4] }), ['C1', 'C2']);
  assert.deepEqual(parsed, { results: [
    { id: 'C1', pass: false, evidence: 'no' },
    { id: 'C2', pass: false, evidence: 'The reviewer gave no verdict for this criterion.' },
  ], unbacked: ['choice'] });
  assert.ok('error' in parseVerdict('bad', ['C1']));
  assert.ok('error' in parseVerdict(json({}), ['C1']));
});

test('blocked lines, stalls and criterion ids use the requested boundaries', () => {
  assert.equal(parseBlocked('Summary\n job blocked: Missing access \n'), 'Missing access');
  assert.equal(parseBlocked('Mention JOB BLOCKED: not a line'), undefined);
  assert.equal(parseBlocked('JOB BLOCKED:\nnext line'), undefined);
  assert.equal(isStalled([['C1', 'C2'], ['C2', 'C1']]), true);
  assert.equal(isStalled([[], []]), false);
  assert.equal(isStalled([['C1']]), false);
  assert.equal(isStalled([['C1'], ['C2']]), false);
  assert.equal(nextCriterionId([]), 'C1');
  assert.equal(nextCriterionId([{ id: 'C2' }, { id: 'C10' }, { id: 'other' }]), 'C11');
});

test('prompts carry current decisions and direct read-only drafting and review', () => {
  const job = createJob('Build the requested feature');
  assert.equal(job.maxRounds, 10);
  assert.equal(addDecision(job, 'Color?', 'Blue'), 1);
  job.criteria = [{ id: 'C1', text: 'Blue button', source: 'answer:1', check: 'npm test', status: 'pass' }, { id: 'C2', text: 'Works', source: 'spec', status: 'fail', evidence: 'Broken' }];
  job.round = 2;
  assert.match(draftPrompt(job), /READ-ONLY/);
  assert.match(draftPrompt(job), /#2/);
  assert.match(revisePrompt(job, 'Change it'), /Change it/);
  assert.match(repairChecklistPrompt('bad'), /bad/);
  assert.match(workPrompt(job), /#1 Q: Color\? A: Blue/);
  assert.match(workPrompt(job), /C1 \[answer:1\] Blue button — check: `npm test`/);
  assert.match(fixPrompt(job), /^Round 2\. /);
  assert.doesNotMatch(fixPrompt(job), /Round 2 of/);
  assert.match(fixPrompt(job), /Broken/);
  assert.doesNotMatch(fixPrompt(job), /C1 \[/);
  const review = verifyPrompt(job, [{ id: 'C1', command: 'npm test', code: 1, output: 'failed output' }], 'Retry JSON');
  assert.ok(review.startsWith('Retry JSON'));
  assert.match(review, /Exit code: 1\nOutput tail:\nfailed output/);
});

test('job works, reviews and fixes only failures before finishing', async () => {
  const job = createJob('Make it work');
  const fake = scripted({ turns: [draft(), 'Changed files', 'Fixed files'], reviews: [verdict([['C1', false]]), verdict()] });
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.equal(job.round, 2);
  assert.equal(job.stopReason, 'All criteria pass');
  assert.deepEqual(job.failHistory, [['C1'], []]);
  assert.match(fake.calls.filter(call => call.kind === 'turn')[2].label, /fixing C1/);
  assert.ok(fake.updates.some(state => state.phase === 'work'));
  assert.ok(fake.updates.some(state => state.phase === 'verify'));
});

test('failed and unfinished checks override reviewer passes and stall stops the loop', async () => {
  for (const code of [1, null]) {
    const job = createJob('Run checks');
    const fake = scripted({ turns: [draft([{ text: 'Tests pass', source: 'spec', check: 'npm test' }]), 'Work', 'Fix'], reviews: [verdict(), verdict()], checks: [{ code, output: 'x'.repeat(800) }, { code, output: 'failure' }] });
    await runJob(job, fake.host);
    assert.equal(job.criteria[0].status, 'fail');
    assert.match(job.criteria[0].evidence, code === null ? /without finishing/ : /exited 1/);
    assert.equal(job.stopReason, 'Stalled: C1 failed two rounds in a row');
    assert.equal(job.phase, 'stopped');
  }
});

test('worker and drafter can stop a blocked job', async () => {
  for (const turns of [[json({ blocked: 'Impossible' })], [draft(), 'JOB BLOCKED: Impossible']]) {
    const job = createJob('Work');
    await runJob(job, scripted({ turns }).host);
    assert.equal(job.phase, 'stopped');
    assert.equal(job.stopReason, 'Blocked: Impossible');
  }
});

test('checklist feedback is logged and a full revision is approved before working', async () => {
  const job = createJob('Work');
  const fake = scripted({ turns: [draft(), draft([{ text: 'Revised', source: 'answer:1' }]), 'Work'], answers: [['Change requirement'], ['Approve']], reviews: [verdict()] });
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.deepEqual(job.decisions, [{ question: 'Checklist feedback', answer: 'Change requirement' }]);
  assert.equal(job.criteria[0].text, 'Revised');
  assert.match(fake.calls.filter(call => call.kind === 'turn')[1].prompt, /#1 Q: Checklist feedback A: Change requirement/);
});

test('cancelled turns and cancellation between checks stop without another host call', async () => {
  const job = createJob('Work');
  await runJob(job, scripted({ turns: [undefined] }).host);
  assert.equal(job.stopReason, 'Cancelled');
  assert.equal(job.phase, 'stopped');
  const other = createJob('Work');
  let cancelled = false;
  const fake = scripted({ turns: [draft([{ text: 'Check', check: 'test' }]), 'Work'], cancelled: () => cancelled });
  fake.host.runCheck = async () => { cancelled = true; return { code: 0, output: '' }; };
  await runJob(other, fake.host);
  assert.equal(other.stopReason, 'Cancelled');
  assert.equal(fake.calls.some(call => call.kind === 'review'), false);
});

test('different failures reach the maximum round count without a stall', async () => {
  const job = createJob('Work');
  const fake = scripted({
    turns: [draft([{ text: 'One' }, { text: 'Two' }]), ...Array(10).fill('Work')],
    reviews: Array.from({ length: 10 }, (_, index) => verdict([['C1', index % 2 === 1], ['C2', index % 2 === 0]])),
  });
  await runJob(job, fake.host);
  assert.equal(job.round, 10);
  assert.equal(job.phase, 'stopped');
  assert.equal(job.stopReason, 'Reached round 10 with 1 failing');
});

test('unbacked answers become numbered decisions and failing requirements', async () => {
  const job = createJob('Work');
  const fake = scripted({ turns: [draft(), 'Work', 'Fix'], reviews: [verdict([['C1', true]], ['Extra animation', 'Extra sound', 'Extra color']), verdict([['C1', true], ['C2', true], ['C3', true], ['C4', true]])], answers: [['Approve'], ['Keep it', 'Remove it', 'Use blue']] });
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.deepEqual(job.criteria.slice(1).map(item => [item.id, item.text, item.source]), [
    ['C2', 'Keep: Extra animation', 'answer:1'], ['C3', 'Remove: Extra sound', 'answer:2'], ['C4', 'Extra color: Use blue', 'answer:3'],
  ]);
  assert.deepEqual(job.failHistory[0], ['C2', 'C3', 'C4']);
});

test('unbacked questions are chunked by four and skipped items add no requirements', async () => {
  const job = createJob('Work');
  const fake = scripted({
    turns: [draft(), 'Work', 'Fix'],
    reviews: [verdict([['C1', true]], ['One', 'Two', 'Three', 'Four', 'Five']), verdict([['C1', true], ['C2', true]])],
    answers: [['Approve'], null, ['Keep it']],
  });
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.deepEqual(fake.calls.filter(call => call.kind === 'ask').map(call => call.questions.length), [1, 4, 1]);
  assert.equal(job.criteria[1].text, 'Keep: Five');
  assert.equal(job.criteria[1].source, 'answer:1');
});

test('invalid checklist and verdict JSON get one retry, then stop if still invalid', async () => {
  const job = createJob('Work');
  await runJob(job, scripted({ turns: ['bad', draft(), 'Work'], reviews: ['bad', verdict()] }).host);
  assert.equal(job.phase, 'done');
  const badDraft = createJob('Work');
  await runJob(badDraft, scripted({ turns: ['bad', 'bad'] }).host);
  assert.match(badDraft.stopReason, /The agent did not return a checklist:/);
  const badReview = createJob('Work');
  await runJob(badReview, scripted({ turns: [draft(), 'Work'], reviews: ['bad', 'bad'] }).host);
  assert.match(badReview.stopReason, /The reviewer did not return a verdict:/);
});

test('a message that ends a turn early is logged and the same step reruns with it', async () => {
  const job = createJob('Work');
  const fake = interruptedAt(scripted({ turns: [draft(), 'Work'], reviews: [verdict()] }), 'runTurn', 0, 'Use subagents');
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.deepEqual(job.decisions, [{ question: 'Message from you during the job', answer: 'Use subagents' }]);
  const turns = fake.calls.filter(call => call.kind === 'turn');
  assert.equal(turns[0].label, '/job · drafting checklist');
  assert.match(turns[0].prompt, /#1 Q: Message from you during the job A: Use subagents/);
  assert.match(turns[0].prompt, /numbered from #2/);
});

test('a message ending a review early reruns the review, and a repair rerun uses the full drafting prompt', async () => {
  const job = createJob('Work');
  const fake = interruptedAt(scripted({ turns: [draft(), 'Work'], reviews: [verdict()] }), 'review', 0, 'Check colors too');
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.match(fake.calls.filter(call => call.kind === 'review')[0].prompt, /A: Check colors too/);
  const repaired = createJob('Work');
  const other = interruptedAt(scripted({ turns: ['bad', draft(), 'Work'], reviews: [verdict()] }), 'runTurn', 1, 'Smaller scope');
  await runJob(repaired, other.host);
  assert.equal(repaired.phase, 'done');
  const retry = other.calls.filter(call => call.kind === 'turn')[1];
  assert.equal(retry.label, '/job · fixing checklist format');
  assert.match(retry.prompt, /drafting a job checklist[\s\S]*A: Smaller scope/);
});

test('queued messages join the next step, and a message instead of an approval revises the checklist', async () => {
  const job = createJob('Work');
  const fake = scripted({ turns: [draft(), 'Work'], reviews: [verdict()], notes: ['Before drafting'] });
  await runJob(job, fake.host);
  assert.equal(job.decisions[0].answer, 'Before drafting');
  assert.match(fake.calls[0].prompt, /A: Before drafting/);
  const revised = createJob('Work');
  const other = interruptedAt(scripted({ turns: [draft(), draft([{ text: 'Revised', source: 'answer:1' }]), 'Work'], answers: [['Approve']], reviews: [verdict()] }), 'ask', 0, 'Drop the export step');
  await runJob(revised, other.host);
  assert.equal(revised.phase, 'done');
  assert.deepEqual(revised.decisions, [{ question: 'Checklist feedback', answer: 'Drop the export step' }]);
  assert.equal(other.calls.filter(call => call.kind === 'turn')[1].label, '/job · revising checklist');
});

test('a message ending unbacked questions early is logged and the questions are asked again', async () => {
  const job = createJob('Work');
  const fake = interruptedAt(scripted({ turns: [draft(), 'Work', 'Fix'], reviews: [verdict([['C1', true]], ['Extra']), verdict([['C1', true], ['C2', true]])], answers: [['Approve'], ['Keep it']] }), 'ask', 1, 'Hold on');
  await runJob(job, fake.host);
  assert.equal(job.phase, 'done');
  assert.deepEqual(job.decisions.map(item => item.answer), ['Hold on', 'Keep it']);
  assert.equal(job.criteria[1].source, 'answer:2');
});

test('skipped approvals, explicit stops and host errors end the job without throwing', async () => {
  for (const [answer, reason] of [[null, 'Checklist not approved'], [['Stop job'], 'Stopped by you']]) {
    const job = createJob('Work');
    await runJob(job, scripted({ turns: [draft()], answers: [answer] }).host);
    assert.equal(job.stopReason, reason);
  }
  const job = createJob('Work');
  const fake = scripted();
  fake.host.runTurn = async () => { throw new Error('Host failed'); };
  fake.host.update = () => { throw new Error('Persistence failed'); };
  await assert.doesNotReject(runJob(job, fake.host));
  assert.equal(job.stopReason, 'Host failed');
});
