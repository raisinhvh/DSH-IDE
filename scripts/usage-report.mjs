import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/usage-report.mjs <usage-log.jsonl>');
  process.exit(1);
}
const groups = { chat: new Map(), kind: new Map() };
for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
  if (!line.trim()) continue;
  let item;
  try { item = JSON.parse(line); } catch { continue; }
  for (const [group, key] of [[groups.chat, item.chatId || '(unknown)'], [groups.kind, item.kind || '(unknown)']]) {
    const total = group.get(key) || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 };
    for (const field of ['input', 'cacheRead', 'cacheWrite', 'output']) total[field] += Number(item[field]) || 0;
    total.turns++;
    group.set(key, total);
  }
}
for (const [name, group] of Object.entries(groups)) {
  console.log(`\nPer ${name}`);
  console.table(Object.fromEntries(group));
}
