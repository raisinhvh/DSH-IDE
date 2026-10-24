import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DECIDER_HISTORY, deciderPrompt, MAX_RANKS, normalizeRanks, parseDecision, rankLabel } from '../dist/runtime/smartAuto.mjs';

test('ranked models keep their order and drop malformed entries', () => {
  assert.deepEqual(normalizeRanks([{ model: ' Opus ', effort: 'high', note: ' hard bugs ' }, { model: '' }, null, 'Opus', { model: 'Flash', effort: ' ', note: 7 }]),
    [{ model: 'Opus', effort: 'high', note: 'hard bugs' }, { model: 'Flash', effort: undefined, note: undefined }]);
  assert.equal(normalizeRanks([{ model: 'Opus', note: 'x'.repeat(900) }])[0].note.length, 500);
  assert.deepEqual(normalizeRanks(undefined), []);
  assert.equal(normalizeRanks(Array.from({ length: 20 }, (_, index) => ({ model: `M${index}` }))).length, MAX_RANKS);
  assert.equal(rankLabel({ model: 'Opus', effort: 'high' }), 'Opus (high)');
  assert.equal(rankLabel({ model: 'Flash' }), 'Flash');
});

test('the decider prompt numbers the ranking and carries recent context and the message', () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index}` }));
  const prompt = deciderPrompt([{ model: 'Opus', effort: 'high' }, { model: 'Flash' }], history, '  now fix it  ');
  assert.match(prompt, /smartest \(1\) to least smart \(2\)/);
  assert.match(prompt, /1\. Opus \(high\)\n2\. Flash/);
  assert.match(prompt, /Next user message:\nnow fix it/);
  assert.ok(prompt.includes(`turn ${10 - DECIDER_HISTORY}`));
  assert.ok(!prompt.includes(`turn ${9 - DECIDER_HISTORY}`));
  assert.doesNotMatch(deciderPrompt([{ model: 'Flash' }], [], 'hi'), /Recent conversation|notes/);
  const noted = deciderPrompt([{ model: 'Opus', note: 'UI work\nand CSS' }, { model: 'Flash' }], [], 'restyle the tabs');
  assert.match(noted, /Follow those notes first/);
  assert.match(noted, /1\. Opus \(user's note: UI work and CSS\)\n2\. Flash\n/);
});

test('reads the rank and reason from the first line of the reply', () => {
  assert.deepEqual(parseDecision('2 | Small edit in one file.', 3), { rank: 2, reason: 'Small edit in one file.' });
  assert.deepEqual(parseDecision('\n**1** - needs careful refactoring\nmore', 3), { rank: 1, reason: 'needs careful refactoring' });
  assert.deepEqual(parseDecision('Model 3', 3), { rank: 3, reason: undefined });
  assert.equal(parseDecision('4 | too high', 3), undefined);
  assert.equal(parseDecision('0', 3), undefined);
  assert.equal(parseDecision('The smartest one', 3), undefined);
  assert.equal(parseDecision('', 3), undefined);
});
