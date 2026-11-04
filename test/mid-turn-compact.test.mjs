import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CHECKPOINT_MARKER, chatCompactRequest, compactStep, PAUSED_NOTE, sendCompactRequest, subagentCheckpoint, subagentCompactRequest, subagentResumeTask, takeFollowUp, URGE_AFTER_TOKENS } from '../dist/runtime/midTurnCompact.mjs';

test('compaction asks once past the threshold, then urges once', () => {
  const watch = { threshold: 70000 };
  assert.equal(compactStep(watch, 69000), undefined);
  assert.equal(compactStep(watch, 71000), 'ask');
  assert.equal(compactStep(watch, 80000), undefined);
  assert.equal(compactStep(watch, 71000 + URGE_AFTER_TOKENS), 'urge');
  assert.equal(compactStep(watch, 200000), undefined);
});

test('requests name the size and how the agent saves its checkpoint', () => {
  assert.match(chatCompactRequest(84000, false), /about 84k tokens[\s\S]*call checkpoint/);
  assert.match(chatCompactRequest(120000, true), /Call checkpoint now/);
  assert.match(subagentCompactRequest(90000, false), new RegExp(`"${CHECKPOINT_MARKER}"`));
});

test('a subagent checkpoint is the text after the last marker', () => {
  assert.equal(subagentCheckpoint('Fixed the hand pose.\n\nAll done: report here.'), undefined);
  assert.equal(subagentCheckpoint(`Working…\n${CHECKPOINT_MARKER}\n`), undefined);
  assert.equal(subagentCheckpoint(`Working…\n**${CHECKPOINT_MARKER}**\n- Done: poses A, B\n- Next: bake C`), '- Done: poses A, B\n- Next: bake C');
  const resumed = subagentResumeTask('Animate the oil fill.', '- Next: bake C', 1);
  assert.match(resumed, /^Animate the oil fill\./);
  assert.match(resumed, /part 1[\s\S]*- Next: bake C/);
});

test('a turn that takes messages gets the request directly', () => {
  const said = [];
  const watch = { threshold: 70000 };
  assert.equal(sendCompactRequest(watch, { say: text => { said.push(text); return true; } }, 'checkpoint please'), true);
  assert.deepEqual(said, ['checkpoint please']);
  assert.equal(takeFollowUp(watch), undefined);
  assert.equal(sendCompactRequest(watch, { say: () => false }, 'too late'), false);
});

test('an ACP prompt is stopped and the request waits to be the next prompt', () => {
  const watch = { threshold: 70000 };
  assert.equal(sendCompactRequest(watch, { interrupt: () => false }, 'too late'), false);
  assert.equal(takeFollowUp(watch), undefined);
  assert.equal(sendCompactRequest(watch, { interrupt: () => true }, 'checkpoint please'), true);
  assert.equal(takeFollowUp(watch), PAUSED_NOTE + 'checkpoint please');
  assert.equal(takeFollowUp(watch), undefined);
  assert.equal(takeFollowUp(undefined), undefined);
});
