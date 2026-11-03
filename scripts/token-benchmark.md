# Token benchmark

Use the same sample repository, model, settings, and starting revision for each run. Clear or archive the extension global storage `usage-log.jsonl` before each run. Start a fresh chat for each task and complete them by hand:

1. Rename a public function and update its callers and tests.
2. Fix a reproducible bug and verify the fix.
3. Ask “Where is the user request handled?” and request file and line references.
4. Implement a feature spanning multiple files and verify it.
5. Have a 15-turn chat about a single feature, including follow-up changes and questions.

Record the prompts and resulting revision so the comparison uses the same work. Do not run unrelated chats during the benchmark. Save each run's log, then run `node scripts/usage-report.mjs <path-to-log>` for each. Compare input, cache reads, cache writes, output and turn counts by chat and kind; note any differences in completed work or verification alongside the totals.
