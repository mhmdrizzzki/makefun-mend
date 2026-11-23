// Second hardening pass for mend (SPEC.md version 1) — the second test suite.
//
// Unlike the kit's runner (runner.ts, which caps stdout, files and time) and check.ts (which compare against a
// committed expectation), this suite runs the real CLI in fresh directories and:
//   - compares exit code, stdout bytes and the complete resulting file tree byte for byte (uncapped runner);
//   - uses an independent, deliberately simple semantic oracle for seeded cases instead of the implementation;
//   - fuzzes all four edit formats, asserting success => exact expected content, failure => tree untouched and
//     the right error kind.
//
// Run: node test/harden2.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

const failures = [];
let passed = 0;
let total = 0;

function record(name, ok, detail) {
  total += 1;
  if (ok) passed += 1;
  else failures.push({ name, detail: String(detail) });
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- uncapped byte-level runner

function runMend(argv, stdin, files) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-h2-'));
  try {
    for (const [p, content] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], {
      cwd: dir,
      input: stdin === null ? '' : Buffer.from(stdin, 'utf8'),
      encoding: 'buffer',
      timeout: 30000,
    });
    const exit = r.error !== undefined || r.status === null ? -1 : r.status;
    const stdout = r.stdout ?? Buffer.alloc(0);
    const got = new Map();
    const walk = (d, prefix) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        const key = prefix === '' ? name : `${prefix}/${name}`;
        if (st.isDirectory()) walk(p, key);
        else if (st.isFile()) got.set(key, readFileSync(p));
      }
    };
    walk(dir, '');
    return { exit, stdout, got };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tfilesEqual(got, want) {
  const w = new Map(Object.entries(want));
  const why = [];
  const keys = new Set([...got.keys(), ...w.keys()]);
  for (const k of [...keys].sort()) {
    const g = got.get(k);
    const content = w.get(k) === undefined ? null : w.get(k);
    if (content === null) {
      if (g !== undefined) why.push(`${JSON.stringify(k)} should not exist`);
    } else if (g === undefined) {
      why.push(`${JSON.stringify(k)} is missing`);
    } else {
      const gb = g.toString('utf8');
      if (gb !== content) why.push(`${JSON.stringify(k)} differs: expected ${JSON.stringify(content)}, got ${JSON.stringify(gb)}`);
    }
  }
  return why;
}

function runCase(name, argv, stdin, files, expect) {
  const r = runMend(argv, stdin, files);
  const why = [];
  if (r.exit !== expect.exit) why.push(`exit ${r.exit}, expected ${expect.exit}`);
  if (expect.out !== null) {
    const want = Buffer.from(expect.out, 'utf8');
    if (!r.stdout.equals(want)) why.push(`stdout ${JSON.stringify(r.stdout.toString('utf8'))}, expected ${JSON.stringify(expect.out)}`);
  }
  const whyFiles = tfilesEqual(r.got, expect.files);
  if (whyFiles.length > 0) why.push(...whyFiles.map((w) => `  ${w}`));
  record(name, why.length === 0, why.join('\n'));
}

// ---------------------------------------------------------------- independent semantic oracle: JSON edits

function splitLines(s) {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function oracleJson(ops, initial) {
  const final = new Map(Object.entries(initial));
  const fails = [];
  for (const op of ops) {
    const path = op.path;
    const t = final.get(path);
    if (op.command === 'create') {
      if (t !== undefined) fails.push({ code: 'exists', path });
      else final.set(path, op.file_text);
    } else if (op.command === 'str_replace') {
      if (t === undefined) {
        fails.push({ code: 'missing', path });
        continue;
      }
      const oldStr = op.old_str;
      const newStr = op.new_str === undefined ? '' : op.new_str;
      let count = 0;
      let at = -1;
      if (oldStr !== '') {
        let k = t.indexOf(oldStr);
        while (k >= 0) {
          count += 1;
          at = k;
          k = t.indexOf(oldStr, k + 1);
        }
      }
      if (count === 0) fails.push({ code: 'no-match', path });
      else if (count > 1) fails.push({ code: 'ambiguous', path });
      else final.set(path, t.slice(0, at) + newStr + t.slice(at + oldStr.length));
    } else if (op.command === 'insert') {
      if (t === undefined) {
        fails.push({ code: 'missing', path });
        continue;
      }
      const ls = t === '' ? [] : splitLines(t);
      const line = op.insert_line;
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 0 || line > ls.length) {
        fails.push({ code: 'no-match', path });
        continue;
      }
      const add = op.new_str === undefined ? [] : splitLines(op.new_str);
      const ins = ls.slice(0, line).concat(add, ls.slice(line));
      final.set(path, ins.join('\n') + (t !== '' && t.endsWith('\n') ? '\n' : ''));
    }
  }
  return { fails, final };
}

function expectedJsonRun(ops, initial) {
  const res = oracleJson(ops, initial);
  const fails = res.fails;
  const fin = res.final;
  const outFiles = {};
  if (fails.length > 0) {
    for (const [p, c] of Object.entries(initial)) outFiles[p] = c;
  } else {
    for (const [p, c] of fin) outFiles[p] = c;
  }
  const lines = [];
  if (fails.length > 0) {
    for (const f of fails) lines.push(`error: ${f.code} ${f.path}`);
    lines.push(`failed: ${fails.length} of ${ops.length} edits`);
  } else {
    const paths = [...new Set([...fin.keys(), ...Object.keys(initial)])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const changed = [];
    for (const p of paths) {
      const was = Object.prototype.hasOwnProperty.call(initial, p) ? initial[p] : null;
      const now = fin.has(p) ? fin.get(p) : null;
      if (was === now) continue;
      changed.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    }
    for (const line of changed) lines.push(line);
    lines.push(`ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`);
  }
  const out = lines.join('\n') + '\n';
  return { exit: fails.length > 0 ? 1 : 0, out, files: outFiles };
}

// ---------------------------------------------------------------- independent oracle: SEARCH/REPLACE

function normLine(line, tier) {
  if (tier === 0) return line;
  let e = line.length;
  while (e > 0 && (line[e - 1] === ' ' || line[e - 1] === '\t')) e -= 1;
  let s = 0;
  if (tier === 2) {
    while (s < e && (line[s] === ' ' || line[s] === '\t')) s += 1;
  }
  return line.slice(s, e);
}

function occurrences(lines, old, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pat = old.map((l) => normLine(l, tier));
    const pos = [];
    const matches = (i) => {
      for (let k = 0; k < pat.length; k += 1) {
        if (normLine(lines[i + k], tier) !== pat[k]) return false;
      }
      return true;
    };
    for (let i = 0; i + pat.length <= lines.length; i += 1) {
      if (matches(i)) pos.push(i);
    }
    if (pos.length > 0) return [{ tier, pos }];
  }
  return null;
}

function oracleSr(old, next, fileTextIn, strict) {
  const lines = fileTextIn === '' ? [] : splitLines(fileTextIn);
  const finalBreak = fileTextIn !== '' && fileTextIn.endsWith('\n');
  const occ = occurrences(lines, old, strict);
  if (occ === null) return { fail: { code: 'no-match', path: 'f' } };
  const positions = occ[0].pos;
  if (positions.length !== 1) return { fail: { code: 'ambiguous', path: 'f' } };
  const at = positions[0];
  const out = lines.slice(0, at).concat(next, lines.slice(at + old.length));
  const text = out.length === 0 ? '' : out.join('\n') + (finalBreak ? '\n' : '');
  return { content: text };
}

// ---------------------------------------------------------------- the suite

function main() {
  // ---------------- CLI surface ----------------
  runCase('h2: cli usage unknown option', ['--bogus'], '', {}, { exit: 2, out: 'error: usage\n', files: {} });
  runCase('h2: cli usage two positionals', ['a', 'b'], '', {}, { exit: 2, out: 'error: usage\n', files: {} });
  runCase('h2: cli usage empty format value', ['--format='], '', {}, { exit: 2, out: 'error: usage\n', files: {} });
  runCase('h2: cli usage bad format value', ['--format=unified2'], '', {}, { exit: 2, out: 'error: usage\n', files: {} });
  runCase('h2: cli no-patch', ['nope.patch'], '', {}, { exit: 2, out: 'error: no-patch\n', files: {} });
  runCase('h2: cli format auto empty', [], '', {}, { exit: 2, out: 'error: format\n', files: {} });
  runCase('h2: cli check failed edit writes nothing', ['--check'], '--- f\n+++ f\n@@ -1 +1 @@\n-absent\n+new\n', { f: 'x\n' }, { exit: 1, out: 'error: no-match f\nfailed: 1 of 1 edits\n', files: { f: 'x\n' } });
  runCase('h2: cli dashdash makes option positional', ['--', '--strict'], null, { '--strict': '{"command":"create","path":"out","file_text":"ok"}' }, { exit: 0, out: 'A out\nok: 1 file\n', files: { '--strict': '{"command":"create","path":"out","file_text":"ok"}', out: 'ok' } });
  runCase('h2: cli options after positional', ['edit.patch', '--format=json', '--check'], null, { f: 'x', 'edit.patch': '{"command":"str_replace","path":"f","old_str":"x","new_str":"y"}' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: 'x', 'edit.patch': '{"command":"str_replace","path":"f","old_str":"x","new_str":"y"}' } });

  // ---------------- bytes: unusual content ----------------
  runCase('h2: bytes bom is ordinary content', ['--format=json'], '{"command":"str_replace","path":"f","old_str":"\\uFEFFa","new_str":"\\uFEFFb"}', { f: '\uFEFFa\n' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: '\uFEFFb\n' } });
  runCase('h2: bytes no final break kept on insert', ['--format=json'], '{"command":"insert","path":"f","insert_line":1,"new_str":"b\\n"}', { f: 'a' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: 'a\nb' } });
  runCase('h2: bytes crlf preserved through json replace', ['--format=json'], '{"command":"str_replace","path":"f","old_str":"a\\r\\nb","new_str":"x\\r\\ny"}', { f: 'a\r\nb' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: 'x\r\ny' } });
  runCase('h2: bytes very long line replaced', [], '--- f\n+++ f\n@@ -1 +1 @@\n-' + 'x'.repeat(100000) + '\n+' + 'y'.repeat(100000) + '\n', { f: 'x'.repeat(100000) + '\n' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: 'y'.repeat(100000) + '\n' } });
  runCase('h2: bytes empty file created empty', ['--format=json'], '{"command":"create","path":"e","file_text":""}', {}, { exit: 0, out: 'A e\nok: 1 file\n', files: { e: '' } });
  runCase('h2: bytes unicode content replaced', [], '--- f\n+++ f\n@@ -1,2 +1,2 @@\n héllo\n-wörld\n+mond\n', { f: 'héllo\nwörld\n' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: 'héllo\nmond\n' } });

  // ---------------- paths ----------------
  runCase('h2: paths unsafe unified move destination', [], '--- a/missing\n+++ b/../bad\n', {}, { exit: 1, out: 'error: unsafe ../bad\nfailed: 1 of 1 edits\n', files: {} });
  runCase('h2: paths unsafe json create', ['--format=json'], '[{"command":"create","path":"../bad","file_text":"x"}]', {}, { exit: 1, out: 'error: unsafe ../bad\nfailed: 1 of 1 edits\n', files: {} });
  runCase('h2: paths unsafe sr block', [], '../bad\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n', {}, { exit: 1, out: 'error: unsafe ../bad\nfailed: 1 of 1 edits\n', files: {} });
  runCase('h2: paths unsafe v4a add', ['--format=v4a'], '*** Begin Patch\n*** Add File: ../bad\n+x\n*** End Patch\n', {}, { exit: 1, out: 'error: unsafe ../bad\nfailed: 1 of 1 edits\n', files: {} });
  runCase('h2: paths nested create', ['--format=json'], '[{"command":"create","path":"a/b/c.txt","file_text":"hi\\n"}]', {}, { exit: 0, out: 'A a/b/c.txt\nok: 1 file\n', files: { 'a/b/c.txt': 'hi\n' } });

  // ---------------- order and atomicity ----------------
  runCase('h2: atomic rollback keeps earlier success out', [], '--- f\n+++ f\n@@ -1 +1 @@\n-x\n+y\n--- g\n+++ g\n@@ -1 +1 @@\n-absent\n+oops\n', { f: 'x\n', g: 'z\n' }, { exit: 1, out: 'error: no-match g\nfailed: 1 of 2 edits\n', files: { f: 'x\n', g: 'z\n' } });
  runCase('h2: multiple failures reported in patch order', ['--format=json'], '[{"command":"str_replace","path":"f","old_str":"absent"},{"command":"insert","path":"missing","insert_line":0,"new_str":"x"}]', { f: 'x\n' }, { exit: 1, out: 'error: no-match f\nerror: missing missing\nfailed: 2 of 2 edits\n', files: { f: 'x\n' } });

  // ---------------- sizes: uncapped runner ----------------
  {
    const big = Array.from({ length: 20000 }, (_, i) => `line-${i}`).join('\n') + '\n';
    runCase('h2: size large file replace', [], '--- f\n+++ f\n@@ -10000 +10000 @@\n-line-9999\n+changed\n', { f: big }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: big.replace('line-9999', 'changed') } });
  }
  {
    const ops = [];
    const want = {};
    const expectedLines = [];
    for (let i = 0; i < 70; i += 1) {
      const p = `d${i}/f${i}.txt`;
      ops.push({ command: 'create', path: p, file_text: `content ${i}\n` });
      want[p] = `content ${i}\n`;
    }
    for (const p of Object.keys(want).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) expectedLines.push(`A ${p}`);
    expectedLines.push('ok: 70 files');
    runCase('h2: size many files created', ['--format=json'], JSON.stringify(ops), {}, { exit: 0, out: expectedLines.join('\n') + '\n', files: want });
  }

  // ---------------- tier matching edges ----------------
  runCase('h2: tiers strict only tier0', ['--strict'], 'f\n<<<<<<< SEARCH\n x \n=======\ny\n>>>>>>> REPLACE\n', { f: 'x\n' }, { exit: 1, out: 'error: no-match f\nfailed: 1 of 1 edits\n', files: { f: 'x\n' } });
  runCase('h2: tiers tier2 reindent prefix', [], '--- f\n+++ f\n@@ -1,2 +1,2 @@\n ctx\n-  old\n+    new\n', { f: '\tctx\n\t  old\n' }, { exit: 0, out: 'M f\nok: 1 file\n', files: { f: '\tctx\n\t    new\n' } });

  // ---------------- seeded fuzz: JSON across all ops ----------------
  {
    const rnd = mulberry32(20261122);
    for (let i = 0; i < 60; i += 1) {
      const ops = [];
      const n = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j += 1) {
        const kind = Math.floor(rnd() * 3);
        if (kind === 0) ops.push({ command: 'create', path: `n${Math.floor(rnd() * 4)}`, file_text: rnd() < 0.5 ? '' : `t${j}\n` });
        else if (kind === 1) ops.push({ command: 'str_replace', path: 'f', old_str: rnd() < 0.5 ? 'x' : 'nope', new_str: rnd() < 0.5 ? 'y' : '' });
        else ops.push({ command: 'insert', path: 'f', insert_line: Math.floor(rnd() * 4), new_str: rnd() < 0.5 ? '' : `i${j}\n` });
      }
      const initial = { f: 'x\ny\n' };
      const expect = expectedJsonRun(ops, initial);
      runCase(`h2: fuzz json #${i}`, ['--format=json'], JSON.stringify(ops), initial, expect);
    }
  }

  // ---------------- seeded fuzz: SEARCH/REPLACE ----------------
  {
    const rnd = mulberry32(777);
    const pool = ['a', 'b', 'x', 'y', ' z'];
    for (let i = 0; i < 40; i += 1) {
      const old = [pool[Math.floor(rnd() * pool.length)]];
      const next = [pool[Math.floor(rnd() * pool.length)], pool[Math.floor(rnd() * pool.length)]];
      const fileText = [pool[Math.floor(rnd() * pool.length)], pool[Math.floor(rnd() * pool.length)]].join('\n') + '\n';
      const patchText = `f\n<<<<<<< SEARCH\n${old.join('\n')}\n=======\n${next.join('\n')}\n>>>>>>> REPLACE\n`;
      const res = oracleSr(old, next, fileText, false);
      const changed = res.content !== fileText;
      const expect = res.fail
        ? { exit: 1, out: `error: ${res.fail.code} f\nfailed: 1 of 1 edits\n`, files: { f: fileText } }
        : { exit: changed ? 0 : 0, out: changed ? 'M f\nok: 1 file\n' : 'ok: 0 files\n', files: { f: res.content } };
      runCase(`h2: fuzz search-replace #${i}`, [], patchText, { f: fileText }, expect);
    }
  }

  // ---------------- seeded fuzz: V4A add + delete ----------------
  for (let i = 0; i < 20; i += 1) {
    const addPath = `add${i}.txt`;
    const addLine = `v${i}`;
    const delPath = `gone${i}.txt`;
    const filesIn = { [delPath]: 'bye\n' };
    const patchText = `*** Begin Patch\n*** Add File: ${addPath}\n+${addLine}\n*** Delete File: ${delPath}\n*** End Patch\n`;
    const expectFiles = { [addPath]: `${addLine}\n` };
    runCase(`h2: fuzz v4a #${i}`, ['--format=v4a'], patchText, filesIn, { exit: 0, out: `A ${addPath}\nD ${delPath}\nok: 2 files\n`, files: expectFiles });
  }

  // ---------------- seeded fuzz: unified single-hunk change ----------------
  {
    const rnd = mulberry32(4242);
    const pool = ['a', 'b', 'c', 'x'];
    for (let i = 0; i < 20; i += 1) {
      const oldL = pool[Math.floor(rnd() * pool.length)];
      const nextL = pool[Math.floor(rnd() * pool.length)];
      const second = pool[Math.floor(rnd() * pool.length)];
      const fileText = `${oldL}\n${second}\n`;
      const patchText = `--- f\n+++ f\n@@ -1 +1 @@\n-${oldL}\n+${nextL}\n`;
      const changed = nextL !== oldL;
      runCase(`h2: fuzz unified #${i}`, [], patchText, { f: fileText }, { exit: 0, out: changed ? 'M f\nok: 1 file\n' : 'ok: 0 files\n', files: { f: `${nextL}\n${second}\n` } });
    }
  }

  // ---------------- report ----------------
  process.stdout.write(`harden2: ${passed} of ${total} passed${failures.length === 0 ? '' : `: ${failures.length} FAILED`}\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stdout.write(`FAIL ${f.name}\n  ${f.detail}\n`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
