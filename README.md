# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mhmdrizzzki/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mhmdrizzzki/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies the edits AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON editor calls — to a tree of text files, always all-or-nothing. One CLI, one file of Node 22 and its standard library, specified end to end by `SPEC.md`.

## Run it

```sh
node main.ts [options] [PATCH]   # apply an edit to the tree in the working directory
node check.ts ../kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
node check.ts extra-checks.json   # additional contract edge cases
```

`main.ts` is the tool; `runner.ts` hands a trial over to the env; `check.ts` runs the practice set; `SPEC.md` is the specification; `LICENSE` is MIT.

All four formats and all three matching tiers are implemented. Verification on Node 22.23.2: **100/100 practice
checks**, **112/112 additional contract cases**, and **10/10 generated stress, raw-byte and integrity checks**.
See [HARDENING.md](HARDENING.md) for the contract audit and results.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
