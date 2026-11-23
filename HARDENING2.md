# Second hardening pass

This is the second audit of **SPEC.md version 1**. The first pass and its 112 regression cases are recorded in
[HARDENING.md](HARDENING.md). The checklist below records every normative clause, including the grammar and examples;
implementation references are function names so they remain useful after edits.

## Verification

Baseline on Node **22.23.2**: **100/100** public practice checks and **112/112** first-pass checks. Second-pass results
and confirmed fixes are recorded here after running `test/harden2.mjs`.

The second suite runs the actual CLI in fresh directories and compares its exit status, exact stdout bytes and the
complete resulting file tree. It has no runner file-count or stdout truncation. Failed and check-only invocations
also compare the directory inventory. Seeded cases use an independent, deliberately simple semantic oracle rather
than importing the implementation or duplicating its patch readers.

## Normative checklist

All clauses below were checked against the named implementation. The `cli`, `bytes`, `paths`, `matching`, `order`,
`sizes` and `fuzz` groups in the second suite supplement the public and first-pass checks.

### Scope — SPEC lines 3–10

Checked in `run`, the four format readers and the staged `Tree`.

- G01. Apply model-written edits to a tree of text files.
- G02. Read unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON editor calls according to their own sections.
- G03. Change every file in a successful patch, or change none when the patch fails.
- G04. Invoke the CLI once in a fresh working directory; observable results are exit code, all stdout, and all file
  paths and bytes afterwards. Stderr is not compared.
- G05. Every sentence of the specification is normative, including sentences without MUST/SHOULD wording.

### 1. Invocation — SPEC lines 14–26

Checked in `run`.

- I01. Accept `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
- I02. The working directory is the tree root; edit paths are relative to it.
- I03. PATCH names a patch file relative to that directory.
- I04. An absent PATCH or the positional argument `-` selects stdin.
- I05. Explicit formats are `unified`, `search-replace`, `v4a` and `json`; `auto` is the default and uses section 4.
- I06. Check mode computes the same output and exit status, but creates, changes and deletes no file.
- I07. Strict mode restricts line matching to tier 0.
- I08. Options and PATCH may occur in any order.
- I09. `--` ends option processing; every later argument is positional, even if it resembles an option.
- I10. Before `--`, an unrecognized argument starting with `-`, other than the literal `-`, is a usage fault.
- I11. Giving any option twice is a usage fault, including two different format values.
- I12. Any format value outside the five named values is a usage fault.
- I13. More than one positional argument is a usage fault.

### 2. Output and exit codes — SPEC lines 30–67

Checked in `run`, `Fail`, `Exit2` and the final stdout write.

- O01. Stdout consists only of lines terminated with LF.
- O02. Usage, unreadable PATCH, failed auto-detection and parsing faults exit 2, write no files, and print exactly
  one error line.
- O03. Usage faults print `error: usage`.
- O04. An unreadable named PATCH prints `error: no-patch`.
- O05. Auto-detection finding no format prints `error: format`.
- O06. A reader fault prints `error: parse N`, with a 1-based patch line chosen by that format's section.
- O07. A reader finding no edits prints `error: parse 1`.
- O08. Error precedence is usage, then unreadable PATCH, then detection, then parsing.
- O09. Parse validation precedes all edited-file lookup.
- O10. Edit failures exit 1, write nothing, and print one `error: code path` line for each failed edit in patch order,
  followed by `failed: k of n edits`.
- O11. `no-match` means the replaced lines or text were not found.
- O12. `ambiguous` means multiple occurrences exist and the format supplies no selection rule.
- O13. `missing` concerns a nonexistent source of a change, delete or move.
- O14. `exists` concerns an existing creation or move destination.
- O15. `unsafe` concerns an unsafe edit path; report its patch spelling after any section-6 prefix removal.
- O16. Error paths identify the missing file, existing destination or file with the failed match, respectively.
- O17. Success exits 0 and writes the resulting tree, except in check mode.
- O18. Report changed paths in UTF-8 byte order, then `ok: n files`, with singular `ok: 1 file`.
- O19. Report `A path` for an absent-before/present-after file, `D path` for the reverse, and `M path` for an
  existing file with different bytes.
- O20. A successful section-6/8 move reports `R old -> new` only when old existed before and is absent afterwards,
  and new was absent before and exists afterwards; replace that pair's D/A rows and sort by new.
- O21. Omit byte-identical files, including edits undone by later edits. A net-zero patch prints only `ok: 0 files`.

### 3. Files, lines and paths — SPEC lines 71–83

Checked in `safe`, `patchLines`, `fileLines`, `fileText`, the JSON operations and disk-write loop.

- F01. Files and patches are UTF-8 text.
- F02. A safe path is nonempty, is not absolute with a leading `/`, contains no backslash, and has no empty, `.` or
  `..` slash-separated segment. No additional spelling restriction is stated.
- F03. Create directories as files need them.
- F04. Choose CRLF iff the first LF is immediately preceded by CR; otherwise choose LF.
- F05. Split a file at its chosen break; it has a final break iff its text ends with that break.
- F06. Exclude the last empty split piece when the file has a final break.
- F07. An empty file has zero lines and no final break; zero lines serialize to the empty file.
- F08. Line-oriented changes use the file's own break and retain its original final-break state, except for the
  unified-hunk rule.
- F09. Created line-oriented files use LF and have a final break unless their format specifies otherwise.
- F10. A JSON create writes `file_text` byte for byte.
- F11. Patch lines split at LF, remove exactly one trailing CR per line and omit the final empty piece after LF.
- F12. Patch line numbers start at 1 and count those normalized patch lines.

### 4. Detection — SPEC lines 87–96

Checked in `detect` and `run`.

- D01. Detection is ordered; choose the first applicable rule.
- D02. A blank detection line is empty or whitespace-only.
- D03. A first nonblank line equal to `*** Begin Patch` after surrounding-whitespace removal selects V4A.
- D04. Otherwise, a first non-whitespace character `[` or `{` on the first nonblank line selects JSON.
- D05. Otherwise, any line equal to `<<<<<<< SEARCH` after trailing-whitespace removal selects SEARCH/REPLACE.
- D06. Otherwise, a line beginning `diff --git `, or adjacent lines beginning `--- ` and `+++ `, selects unified.
- D07. No rule means `error: format`; an explicit format bypasses detection regardless of the text's contents.

### 5. Line matching — SPEC lines 100–115

Checked in `matchLines`, `atTier`, `bodyChange` and `replaceLines`.

- M01. Nonempty old lines match the file's current lines at the first tier containing an occurrence.
- M02. Tier 0 compares every line exactly.
- M03. Tier 1 removes trailing spaces and tabs from both sides before comparing.
- M04. Tier 2 removes leading and trailing spaces and tabs from both sides before comparing.
- M05. Strict mode tries only tier 0; absence at every permitted tier is `no-match`.
- M06. An occurrence matches consecutive lines at a position; occurrences may overlap. Selection among them is
  format-specific.
- M07. New lines replace the matched old-line count.
- M08. A unified/V4A context line is copied from its matched file line, never from the patch.
- M09. At tier 2, let F/P be the leading spaces/tabs of the first file/old matched lines. Each nonempty,
  non-whitespace-only, non-context new line starting with P replaces that literal prefix with F; other lines stay
  as written. This is prefix substitution, not an indentation-width adjustment.
- M10. At tiers 0 and 1, non-context new lines are written as supplied.

### 6. Unified diffs — SPEC lines 119–162

Checked in `unifiedEdits`, `unifiedPath`, `unifiedEdit`, `bodyChange` and `replaceLines`.

- U01. Start a section at `diff --git a/X b/Y`, or at a `--- `/`+++ ` pair not already belonging to a section header.
- U02. Before the first hunk, a header pair names old/new paths: take text after four characters, stop at the first
  tab, remove surrounding spaces and remove one leading `a/` or `b/` from either path.
- U03. `/dev/null` denotes no file.
- U04. Without a header pair, `rename from` and `rename to` name old/new paths.
- U05. `new file mode` marks creation; `deleted file mode` marks deletion.
- U06. Use git-header paths when no other header names the respective path.
- U07. Ignore index, mode, similarity/dissimilarity, Index and all other unrecognized header lines.
- U08. An unpaired `--- ` inside a section header faults at the following patch line.
- U09. A malformed git header faults at its own line.
- U10. Hunk headers have `@@ -A[,B] +C[,D] @@` and may have following text; ignore B and D.
- U11. Any other line beginning `@@`, or a hunk before a section, faults at its own line.
- U12. Hunk bodies admit space-context, minus-old, plus-new, backslash-marker and empty-context lines.
- U13. A body ends at another kind of line, a git header, a new header pair, or patch EOF.
- U14. Trim empty lines at the body's end; ignore outside-body prose and fences.
- U15. A section is exactly one edit, regardless of its number of hunks.
- U16. Creation is selected by no old file or creation metadata; the new path must be absent or fail `exists`.
- U17. Creation concatenates only the plus lines of all hunks, in order.
- U18. Deletion is selected by no new file or deletion metadata; the old path must exist or fail `missing`.
- U19. Deletion removes the old file without matching or applying its hunk bodies.
- U20. Different old/new paths select a move: old must exist, new must not, with missing source checked before
  existing destination after safety checks.
- U21. A move applies its hunks to the old file, writes new and deletes old.
- U22. Otherwise change the single existing path, or fail `missing`.
- U23. Apply hunks in order to previous hunks' results.
- U24. O is context/minus lines and N is context/plus lines, each in body order.
- U25. Delta is the sum of new-minus-old line counts of earlier applied hunks in this section.
- U26. For nonempty O, choose the occurrence at the selected tier nearest `A - 1 + delta`, breaking equal distances
  toward the earlier position.
- U27. For empty O, insert N after `A + delta` lines, clamped to EOF when the file is shorter.
- U28. A backslash body line refers to the preceding body line, regardless of its marker text.
- U29. An EOF-touching hunk (including an EOF insertion) leaves a final break unless a marker follows its last
  context/plus line; a non-EOF hunk preserves the previous final-break state.
- U30. A creation has a final break unless a marker follows its last plus line.
- U31. Any hunk failure fails the entire section with that hunk's code and changes nothing for the section.

### 7. SEARCH/REPLACE — SPEC lines 166–187

Checked in `searchReplaceEdits` and `searchReplaceEdit`.

- B01. A block has a path, SEARCH marker, old lines, separator, new lines and REPLACE marker, in that order.
- B02. Match all three markers after removing trailing whitespace only.
- B03. Choose the nearest preceding nonblank, non-fence line since the previous block (or patch start); fence lines
  are those whose trimmed text starts with three backticks. Trim the selected path's surrounding whitespace.
- B04. Without an eligible path line, reuse the previous block's path.
- B05. The first pathless block faults at its SEARCH line.
- B06. A block lacking a separator followed by a REPLACE marker faults at its SEARCH line.
- B07. Otherwise ignore text outside blocks.
- B08. Each block is one edit, applied in order.
- B09. Empty old lines mean creation; an existing path fails `exists`.
- B10. Nonempty old lines require an existing file or fail `missing`.
- B11. At the first matching tier there must be exactly one occurrence, or fail `ambiguous`; replace it with the
  new lines. No occurrence is `no-match` under section 5.

### 8. V4A — SPEC lines 191–229

Checked in `v4aEdits`, `v4aUpdate` and the shared line helpers.

- V01. The first nonblank line must be Begin Patch after surrounding-whitespace removal; otherwise fault at that
  line, or line 1 for no nonblank line.
- V02. The last nonblank line must be End Patch after the same removal; otherwise fault at patch-line-count + 1.
- V03. Drop blank lines at a section's end, before another section or End Patch.
- V04. Sections begin with the literal Add/Delete/Update File prefixes; the rest is the path, with surrounding
  spaces removed.
- V05. Ignore blank lines between sections; any other non-section line faults at its own line.
- V06. Add bodies accept plus-prefixed lines (remove plus) and empty lines (empty file lines); reject other lines.
- V07. Delete sections have no body lines.
- V08. An Update may have Move to as its first body line only; trim surrounding spaces from the destination.
- V09. Explicit chunks begin at any line starting `@@`; trim surrounding spaces from the remaining anchor text.
  Empty anchor text means no anchor.
- V10. Only the first chunk may begin implicitly at a body line.
- V11. Body lines are space-context, minus-old, plus-new or empty-context lines.
- V12. End of File ends a chunk and restricts it to EOF; later chunks need explicit headers.
- V13. An Update with neither a chunk nor Move to faults at its Update header line.
- V14. Each section is one edit, applied in order.
- V15. Add requires absence or fails `exists`, writes its lines with a final break, subject to the zero-lines rule.
- V16. Delete requires existence or fails `missing`, and deletes the file.
- V17. Update requires existence or fails `missing`; a Move to destination must be absent or fail `exists`.
- V18. The chunk cursor starts at line 0; chunks apply in order.
- V19. An anchor takes the first matching line at/after the cursor, at the first permitted tier, or fails
  `no-match`; advance the cursor past it.
- V20. O is context/minus lines and N is context/plus lines in body order.
- V21. Take the first O occurrence at/after the cursor at the first tier with one; an EOF chunk admits only an
  occurrence ending at the file's last line. Apply these restrictions before choosing a tier.
- V22. Empty O inserts at the cursor, or at EOF for an EOF chunk.
- V23. Advance the cursor to just after the written lines, not the old lines.
- V24. With Move to, write the result to the destination and delete the source.

### 9. JSON — SPEC lines 233–250

Checked in `jsonEdits`, `jsonEdit`, `patchLines` and the per-command closures.

- J01. Accept either one JSON array of edit objects or JSON Lines with one edit object per nonblank line.
- J02. Any array-form fault reports the line where the array starts.
- J03. A JSON Lines fault reports the line that does not contain one valid edit object; ignore blank lines.
- J04. An edit object has a string path and a recognized command; ignore unrelated keys.
- J05. Create requires string `file_text`, fails `exists` if the file exists, and writes its bytes unchanged.
- J06. Str-replace requires nonempty string `old_str`; `new_str` is a string or is absent, which means empty.
- J07. Str-replace requires the existing file, or fails `missing`.
- J08. In a CRLF file, normalize every CRLF to LF in the file and both strings, then write the result with CRLF.
- J09. Count overlapping exact substring occurrences; zero is `no-match`, multiple is `ambiguous`, exactly one is
  replaced. Whitespace tiers do not apply.
- J10. Insert requires an integer `insert_line` and string `new_str`, and an existing file or fails `missing`.
- J11. Insert bounds are inclusive 0 through the file's line count; otherwise fail `no-match`.
- J12. Split inserted text at LF, strip one trailing CR per line, drop the final empty split piece; empty new text
  contributes zero lines.
- J13. Insert after the indicated line count, with 0 denoting the top, and preserve the original final break.
- J14. Wrong commands and missing/mistyped required keys are parse faults.

### 10. Order and atomicity — SPEC lines 254–257

Checked in `run`, `Tree`, all edit closures and the final disk-write loop.

- T01. Apply edits in patch order to the tree left by earlier successful edits.
- T02. Later edits observe earlier creates, changes, moves and deletes.
- T03. Check every path an edit names for safety before existence, matching or any other edit condition.
- T04. A failed edit leaves the staged tree unchanged, including every earlier hunk/chunk of that edit and its move.
- T05. Continue after failures and report every failed edit in order.
- T06. Any failed edit prevents all disk writes and produces exit 1.
- T07. With no failures, write every final change and exit 0; check mode computes the same result and writes none.

## Unspecified inputs

The specification guarantees UTF-8 text without prescribing invalid-UTF-8 rejection, an error code for such
rejection, or wording for errors outside its listed cases. Existing Node decoding and existing error behavior are
retained. BOMs inside text are ordinary content; only the explicitly stated whitespace-removal rules apply.
Filesystem failures and non-text-tree inputs are not assigned a new error policy by this pass.
