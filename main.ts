// mend, the patch CLI specified by SPEC.md (MIT).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { oldPath: string; newPath: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

interface LineFile {
  lines: string[];
  br: string;
  final: boolean;
}

function fileLines(text: string): LineFile {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fileText(file: LineFile): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

function spaces(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ' ') start += 1;
  while (end > start && s[end - 1] === ' ') end -= 1;
  return s.slice(start, end);
}

function indent(s: string): string {
  let end = 0;
  while (end < s.length && (s[end] === ' ' || s[end] === '\t')) end += 1;
  return s.slice(0, end);
}

function atTier(line: string, tier: number): string {
  if (tier === 0) return line;
  let start = 0;
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  if (tier === 2) while (start < end && (line[start] === ' ' || line[start] === '\t')) start += 1;
  return line.slice(start, end);
}

interface LineMatch {
  tier: number;
  positions: number[];
}

/** Non-empty old lines, with the cursor/EOF restriction applied before choosing a tier. */
function matchLines(lines: string[], old: string[], strict: boolean, start = 0, eof = false): LineMatch | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const pattern = old.map((l) => atTier(l, tier));
    // A prefix table keeps overlapping occurrences linear, even in repetitive files.
    const prefix = new Array<number>(pattern.length).fill(0);
    for (let i = 1, k = 0; i < pattern.length; i += 1) {
      while (k > 0 && pattern[i] !== pattern[k]) k = prefix[k - 1]!;
      if (pattern[i] === pattern[k]) k += 1;
      prefix[i] = k;
    }
    const positions: number[] = [];
    for (let i = start, k = 0; i < lines.length; i += 1) {
      const line = atTier(lines[i]!, tier);
      while (k > 0 && line !== pattern[k]) k = prefix[k - 1]!;
      if (line === pattern[k]) k += 1;
      if (k === pattern.length) {
        if (!eof || i + 1 === lines.length) positions.push(i + 1 - pattern.length);
        k = prefix[k - 1]!;
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NewLine {
  text: string;
  context?: number;
}
interface LineChange {
  old: string[];
  next: NewLine[];
}

function bodyChange(body: string[]): LineChange {
  const old: string[] = [];
  const next: NewLine[] = [];
  for (const line of body) {
    if (line === '' || line.startsWith(' ')) {
      next.push({ text: line.slice(1), context: old.length });
      old.push(line.slice(1));
    } else if (line.startsWith('-')) old.push(line.slice(1));
    else if (line.startsWith('+')) next.push({ text: line.slice(1) });
  }
  return { old, next };
}

function replaceLines(file: LineFile, change: LineChange, at: number, tier: number): number {
  const p = change.old.length === 0 ? '' : indent(change.old[0]!);
  const f = change.old.length === 0 ? '' : indent(file.lines[at]!);
  const written = change.next.map((line) => {
    if (line.context !== undefined) return file.lines[at + line.context]!;
    if (tier === 2 && !blank(line.text) && line.text.startsWith(p)) return f + line.text.slice(p.length);
    return line.text;
  });
  file.lines = file.lines.slice(0, at).concat(written, file.lines.slice(at + change.old.length));
  return written.length;
}

interface UnifiedHunk {
  start: bigint;
  change: LineChange;
  noFinal: boolean;
  added: string[];
  lastAddNoFinal: boolean | undefined;
}
interface UnifiedSection {
  gitOld: string;
  gitNew: string;
  pair: { oldPath: string; newPath: string } | null;
  renameOld?: string;
  renameNew?: string;
  create: boolean;
  remove: boolean;
  hunks: UnifiedHunk[];
}

function unifiedPath(line: string): string {
  const p = spaces(line.slice(4).split('\t')[0]!);
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldPath = section.pair?.oldPath ?? section.renameOld ?? section.gitOld;
  const newPath = section.pair?.newPath ?? section.renameNew ?? section.gitNew;
  const create = section.create || oldPath === '/dev/null';
  const remove = section.remove || newPath === '/dev/null';
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (create) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const lines: string[] = [];
      let final = true;
      for (const hunk of section.hunks) {
        for (const line of hunk.added) lines.push(line);
        if (hunk.lastAddNoFinal !== undefined) final = !hunk.lastAddNoFinal;
      }
      tree.now.set(newPath, fileText({ lines, br: '\n', final }));
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (remove) {
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const file = fileLines(before);
    let delta = 0;
    for (const hunk of section.hunks) {
      const change = hunk.change;
      let at: number;
      let tier = 0;
      if (change.old.length === 0) {
        const target = hunk.start + BigInt(delta);
        at = target <= 0n ? 0 : target >= BigInt(file.lines.length) ? file.lines.length : Number(target);
      } else {
        const match = matchLines(file.lines, change.old, strict);
        if (match === null) throw new Fail('no-match', oldPath);
        tier = match.tier;
        const target = hunk.start - 1n + BigInt(delta);
        const distance = (pos: number): bigint => {
          const diff = BigInt(pos) - target;
          return diff < 0n ? -diff : diff;
        };
        at = match.positions[0]!;
        let nearest = distance(at);
        for (const pos of match.positions) {
          const d = distance(pos);
          if (d < nearest) {
            at = pos;
            nearest = d;
          }
        }
      }
      const touchesEnd = at + change.old.length === file.lines.length;
      replaceLines(file, change, at, tier);
      if (touchesEnd) file.final = !hunk.noFinal;
      delta += change.next.length - change.old.length;
    }
    tree.now.set(newPath, fileText(file));
    if (oldPath !== newPath) {
      tree.now.set(oldPath, null);
      tree.moves.push({ oldPath, newPath });
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: UnifiedSection | null = null;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const finish = (): void => {
    if (section !== null) edits.push(unifiedEdit(section, strict));
    section = null;
  };
  const begin = (oldPath: string, newPath: string): UnifiedSection => ({
    gitOld: oldPath, gitNew: newPath, pair: null, create: false, remove: false, hunks: [],
  });
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/s.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      section = begin(m[1]!, m[2]!);
    } else if (pairAt(i)) {
      if (section === null || section.pair !== null || section.hunks.length > 0) {
        finish();
        section = begin('', '');
      }
      section.pair = { oldPath: unifiedPath(line), newPath: unifiedPath(lines[i + 1]!) };
      i += 1;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null || section === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.startsWith('diff --git ') || pairAt(i + 1)) break;
        if (next !== '' && ![' ', '-', '+', '\\'].includes(next[0]!)) break;
        body.push(next);
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let noFinal = false;
      const added: string[] = [];
      let lastAddNoFinal: boolean | undefined;
      body.forEach((l, j) => {
        const marked = (body[j + 1] ?? '').startsWith('\\');
        if (l === '' || l.startsWith(' ') || l.startsWith('+')) noFinal = marked;
        if (l.startsWith('+')) {
          added.push(l.slice(1));
          lastAddNoFinal = marked;
        }
      });
      section.hunks.push({ start: BigInt(m[1]!), change: bodyChange(body), noFinal, added, lastAddNoFinal });
    } else if (section !== null && section.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) section.renameOld = line.slice(12);
      else if (line.startsWith('rename to ')) section.renameNew = line.slice(10);
      else if (line === 'new file mode' || line.startsWith('new file mode ')) section.create = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) section.remove = true;
    }
  }
  finish();
  return edits;
}

function searchReplaceEdit(path: string, old: string[], next: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (old.length === 0) {
      if (before !== null) throw new Fail('exists', path);
      tree.now.set(path, fileText({ lines: next, br: '\n', final: true }));
      return;
    }
    if (before === null) throw new Fail('missing', path);
    const file = fileLines(before);
    const match = matchLines(file.lines, old, strict);
    if (match === null) throw new Fail('no-match', path);
    if (match.positions.length !== 1) throw new Fail('ambiguous', path);
    replaceLines(file, { old, next: next.map((text) => ({ text })) }, match.positions[0]!, match.tier);
    tree.now.set(path, fileText(file));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let candidatePath: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      if (!blank(line) && !line.trim().startsWith('```')) candidatePath = line.trim();
      continue;
    }
    const path = candidatePath ?? previousPath;
    if (path === undefined) throw new Exit2(`error: parse ${i + 1}`);
    let separator = i + 1;
    while (separator < lines.length && lines[separator]!.trimEnd() !== '=======') separator += 1;
    let end = separator + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (separator === lines.length || end >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, separator), lines.slice(separator + 1, end), strict));
    previousPath = path;
    candidatePath = undefined;
    i = end;
  }
  return edits;
}

interface V4AChunk {
  anchor: string;
  change: LineChange;
  eof: boolean;
}

function v4aUpdate(path: string, move: string | undefined, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (move !== undefined && !safe(move)) throw new Fail('unsafe', move);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (move !== undefined && tree.get(move) !== null) throw new Fail('exists', move);
    const file = fileLines(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        const anchor = matchLines(file.lines, [chunk.anchor], strict, cursor);
        if (anchor === null) throw new Fail('no-match', path);
        cursor = anchor.positions[0]! + 1;
      }
      let at = chunk.eof ? file.lines.length : cursor;
      let tier = 0;
      if (chunk.change.old.length > 0) {
        const match = matchLines(file.lines, chunk.change.old, strict, cursor, chunk.eof);
        if (match === null) throw new Fail('no-match', path);
        at = match.positions[0]!;
        tier = match.tier;
      }
      cursor = at + replaceLines(file, chunk.change, at, tier);
    }
    tree.now.set(move ?? path, fileText(file));
    if (move !== undefined) {
      tree.now.set(path, null);
      tree.moves.push({ oldPath: path, newPath: move });
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionAt = (i: number): RegExpExecArray | null => /^\*\*\* (Add|Delete|Update) File: (.*)$/s.exec(lines[i]!);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = sectionAt(i);
    if (header === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = spaces(header[2]!);
    const sectionLine = i + 1;
    const start = i + 1;
    let end = start;
    while (end < last && sectionAt(end) === null) end += 1;
    let bodyEnd = end;
    while (bodyEnd > start && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    if (header[1] === 'Add') {
      const added: string[] = [];
      for (let j = start; j < bodyEnd; j += 1) {
        const line = lines[j]!;
        if (line !== '' && !line.startsWith('+')) throw new Exit2(`error: parse ${j + 1}`);
        added.push(line.slice(1));
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileText({ lines: added, br: '\n', final: true }));
      });
    } else if (header[1] === 'Delete') {
      if (start < bodyEnd) throw new Exit2(`error: parse ${start + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let j = start;
      let move: string | undefined;
      if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) {
        move = spaces(lines[j]!.slice(13));
        j += 1;
      }
      const chunks: V4AChunk[] = [];
      let chunk: { anchor: string; body: string[]; eof: boolean } | null = null;
      const finish = (): void => {
        if (chunk !== null) chunks.push({ anchor: chunk.anchor, change: bodyChange(chunk.body), eof: chunk.eof });
        chunk = null;
      };
      for (; j < bodyEnd; j += 1) {
        const line = lines[j]!;
        if (line.startsWith('@@')) {
          finish();
          chunk = { anchor: spaces(line.slice(2)), body: [], eof: false };
        } else if (line === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${j + 1}`);
          chunk.eof = true;
          finish();
        } else if (line === '' || [' ', '-', '+'].includes(line[0]!)) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            chunk = { anchor: '', body: [], eof: false };
          }
          chunk.body.push(line);
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      finish();
      if (chunks.length === 0 && move === undefined) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(v4aUpdate(path, move, chunks, strict));
    }
    i = end;
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      const inserted = lines.slice(0, line).concat(add, lines.slice(line));
      tree.now.set(p, inserted.length === 0 ? '' : inserted.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)).sort(order);
  const rows = new Map<string, string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const { oldPath, newPath } of tree.moves) {
    if (rows.get(oldPath) === `D ${oldPath}` && rows.get(newPath) === `A ${newPath}`) {
      rows.delete(oldPath);
      rows.set(newPath, `R ${oldPath} -> ${newPath}`);
    }
  }
  if (!check) for (const p of changed) {
    const now = tree.now.get(p)!;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const output = [...rows.keys()].sort(order).map((p) => rows.get(p)!);
  return { code: 0, out: [...output, `ok: ${output.length} ${output.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
