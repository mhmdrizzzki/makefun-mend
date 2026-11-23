# Contract audit and verification

Runtime verified: Node **22.23.2**. The implementation and tests use the standard library only.

## Results

| Suite | Result |
| --- | --- |
| Kit practice checks | **100 / 100**, practice score **1000** |
| Committed contract edge cases (`extra-checks.json`) | **112 / 112** |
| Generated stress, raw-byte and integrity checks | **10 / 10** |

Commands, from the repository root:

```sh
node --check main.ts
node check.ts ../kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
node check.ts extra-checks.json
```

The generated/byte checks used the local script
`/home/ubuntu/.hermes/cache/scratch/opencode/mend-stress.ts`, run with `node` from the repository root. It is a local
verification script; the entry's implementation is entirely in `main.ts`. All generated checks use a 10-second
timeout, as the kit's runner does.

## Sentence-by-sentence audit

`SPEC.md` was read in full twice before implementation and again alongside the completed implementation. The
following records the requirements checked in each section; the practice checks and additional cases cover both
successful edits and failures, comparing exit code, exact stdout and the complete resulting file tree.

| SPEC section | Requirements checked |
| --- | --- |
| 1: Invocation | stdin, `-` and named patch files; format names and detection; option ordering; `--`; duplicate options and positionals; usage precedence; strict and check modes. |
| 2: Output | One LF-terminated line per result; exit 2 precedence and parse line numbers; all five exit 1 codes in patch order; failed edit counts; UTF-8 byte sorting; A/D/M/R rows; rename sorting by destination; byte-identical and net-zero edits omitted. |
| 3: Files and paths | Every listed unsafe segment and prefix; safety before existence/matching; nested paths, spaces, tabs and Unicode; first-LF CRLF detection; mixed breaks; empty files and single empty lines; one trailing CR removed from patch lines; original final breaks retained; LF creation and JSON byte-exact creation. |
| 4: Detection | V4A before JSON before SEARCH/REPLACE before unified; surrounding/trailing whitespace rules; unknown format; explicit format overriding detection. |
| 5: Matching | Exact, trailing space/tab removal, then leading/trailing space/tab removal; no internal whitespace or Unicode whitespace normalization; tier precedence before position selection; overlapping candidates; strict mode; original context bytes; literal P-to-F indentation substitution; empty/whitespace-only new lines. |
| 6: Unified | Git and bare section boundaries; header-pair, rename and git-path precedence; timestamps and one prefix removal; mode flags and ignored metadata/prose; malformed diff and hunk headers and missing `+++` line numbers; ignored hunk counts; bare versus prefixed empty context; body termination; create/delete/move/change; ordered hunks, cumulative deltas, nearest positions and earlier ties; empty-old insertion; final-newline markers; section rollback. |
| 7: SEARCH/REPLACE | Trailing-whitespace markers; nearest eligible path, fences and path reuse; SEARCH-line parse errors; ignored outside text; empty-old creation; exactly one occurrence at the selected tier; deletion to an empty file; original breaks; ordered blocks. |
| 8: V4A | First/last nonblank wrappers and line-number errors; strict section prefixes; trailing section blanks; Add/Delete body rules; first-line-only Move to; implicit first chunks, explicit later chunks and empty chunks; End of File chunk termination; empty-update parse errors; anchor and old-line tier searches scoped to the cursor; EOF filtering before tier selection; empty-old insertion; cursor advancement by written lines; moves and original final breaks. |
| 9: JSON | Array versus JSON Lines parsing; array-start versus object-line faults; required types and ignored keys; byte-exact create; exact overlapping substring matching; optional replacement string; CRLF normalization of both strings; insert bounds, patch-line splitting and unchanged final breaks; no matching tiers. |
| 10: Order and atomicity | Later edits see successful earlier creates/changes/deletes/moves; all edit paths are checked first; a failed section leaves its source and destination unchanged; later edits still run; every failure is reported; any failure prevents every disk write; check mode reports the same result without writes. |

The additional cases explicitly test rename endpoint conditions: a chain `a -> b -> c` does not invent a move edit
`a -> c`; a destination that existed before the patch produces M rather than R. Parsing validates unified hunk
headers before file lookup, while deletion application does not match or otherwise apply their old lines.

## Hardening fixes verified by regression cases

- Git and V4A path readers accept Unicode line/paragraph separators, which are not patch line feeds.
- Mode-like prose such as `new file model` is ignored rather than treated as `new file mode` metadata.
- Space/tab trimming uses linear scans. A 160,000-space indentation case exposed the former regex's timeout and
  now passes at tier 2 with the required indentation.
- Overlapping line matching uses a prefix table. A 100,000-line repetitive file with a 30,001-line nonmatching
  search completes within the runner timeout.
- JSON insertion concatenates arrays instead of spreading lines into a function call. Both JSON and unified
  insertions of 150,000 lines pass, including exact output bytes and final breaks.
- `runner.ts` and the `const trialEnv = ...` hand-over suffix of `main.ts` were compared byte for byte with the kit.

## Input outside the stated contract

SPEC section 3 guarantees UTF-8 text but assigns no rejection policy or error code to invalid UTF-8 bytes. The
starter's Node UTF-8 decoding is retained. Five raw-byte smoke checks verified format/parse errors for invalid
stdin, byte preservation under check mode and no-op edits, and starter-compatible replacement of decoded text.
