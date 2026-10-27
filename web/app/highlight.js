// Syntax highlighting for chat code blocks. A hand-written scanner rather
// than regular expressions, so long scripts stay linear. The fence language
// picks the rules; without one a conservative guess is made, and when the
// guess is unsure only strings, numbers and comments are coloured.
// Packages/MumbleCore/Sources/MumbleProtocol/ChatHighlighter.swift is the same
// highlighter for iOS; both are checked against web/test/fixtures/highlight.json.

const MAX_LENGTH = 200_000;
const DETECT_LINES = 200;

const C_TYPES = 'void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE';
const C_KEYWORDS = 'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while NULL true false';
const JS_KEYWORDS = 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined NaN Infinity';
const TS_KEYWORDS = `${JS_KEYWORDS} abstract as declare enum implements interface keyof namespace private protected public readonly satisfies type`;
const JS_TYPES = 'string number boolean any unknown never object symbol bigint';

// Each language is a set of switches for the one scanner. Keyword and type
// lists are space-separated; caseless languages list them in lowercase.
const LANGUAGES = {
  bash: {
    keywords: 'if then else elif fi case esac for select while until do done in function time return exit break continue local export readonly declare unset shift source alias set trap eval exec true false',
    types: 'echo printf read cd pwd test',
    lineComments: ['#'], hashNeedsSpace: true, variables: true, identExtra: '-',
    strings: [{ open: '"', close: '"', escape: true, multiline: true }, { open: "'", close: "'", multiline: true }, { open: '`', close: '`', escape: true, multiline: true }],
  },
  python: {
    keywords: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case None True False self',
    types: 'int float str bool bytes list dict set tuple object type len print range open super isinstance Exception',
    lineComments: ['#'], capitalTypes: true,
    strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: "'''", close: "'''", escape: true, multiline: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  },
  javascript: {
    keywords: JS_KEYWORDS,
    types: 'console window document globalThis Array Object String Number Boolean Promise Map Set JSON Math Date Error RegExp Symbol',
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }, { open: '`', close: '`', escape: true, multiline: true }],
  },
  typescript: {
    keywords: TS_KEYWORDS,
    types: `${JS_TYPES} console window document globalThis Array Object String Number Boolean Promise Map Set Record Partial JSON Math Date Error RegExp Symbol`,
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }, { open: '`', close: '`', escape: true, multiline: true }],
  },
  json: {
    keywords: 'true false null',
    lineComments: ['//'], blockComments: [['/*', '*/']], keys: true,
    strings: [{ open: '"', close: '"', escape: true }],
  },
  swift: {
    keywords: 'actor associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nil nonisolated open operator override private protocol public repeat rethrows return self Self some any static struct subscript super switch throw throws true false try typealias var weak where while',
    types: 'Int Double Float Bool String Character Void Array Dictionary Set Optional',
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: '"', close: '"', escape: true }],
  },
  kotlin: {
    keywords: 'abstract as break by catch class companion const constructor continue data do else enum false final finally for fun if import in init inner interface internal is lateinit null object open operator out override package private protected public return sealed super suspend this throw true try typealias val var when where while',
    types: 'Int Long Short Byte Double Float Boolean Char String Unit Any Nothing List Map Set Array',
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"""', close: '"""', multiline: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  java: {
    keywords: 'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var volatile while record yield true false null',
    types: 'void boolean byte char short int long float double String Object Integer Long Double Boolean List Map',
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  c: {
    keywords: C_KEYWORDS,
    types: C_TYPES,
    lineComments: ['//'], blockComments: [['/*', '*/']], preprocessor: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  cpp: {
    keywords: `${C_KEYWORDS} alignas alignof catch class constexpr consteval co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept nullptr operator override private protected public static_cast dynamic_cast reinterpret_cast const_cast template this throw try typename using virtual final concept requires`,
    types: `${C_TYPES} auto wchar_t char8_t char16_t char32_t std string vector map unique_ptr shared_ptr`,
    lineComments: ['//'], blockComments: [['/*', '*/']], preprocessor: true, capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  csharp: {
    keywords: 'abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern false finally fixed for foreach get goto if implicit in init interface internal is lock namespace new null operator out override params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this throw true try typeof unchecked unsafe using var virtual void volatile when where while yield',
    types: 'bool byte sbyte char decimal double float int uint long ulong short ushort object string dynamic nint nuint',
    lineComments: ['//'], blockComments: [['/*', '*/']], preprocessor: true, capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  go: {
    keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota',
    types: 'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any append cap close copy delete len make new panic print println recover',
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: '`', close: '`', multiline: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  rust: {
    keywords: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Some None Ok Err',
    lineComments: ['//'], blockComments: [['/*', '*/']], capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true, multiline: true }, { open: "'", close: "'", escape: true, char: true }],
  },
  ruby: {
    keywords: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor attr_reader puts',
    lineComments: ['#'], capitalTypes: true,
    strings: [{ open: '"', close: '"', escape: true, multiline: true }, { open: "'", close: "'", escape: true, multiline: true }],
  },
  php: {
    keywords: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null',
    types: 'int float bool string void mixed object iterable self parent',
    lineComments: ['//', '#'], blockComments: [['/*', '*/']], variables: true, capitalTypes: true, caseless: true,
    strings: [{ open: '"', close: '"', escape: true, multiline: true }, { open: "'", close: "'", escape: true, multiline: true }],
  },
  sql: {
    keywords: 'add all alter and any as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction truncate union unique update using values view when where with true false',
    types: 'int integer bigint smallint serial decimal numeric real float double boolean bool char varchar text date time timestamp timestamptz json jsonb uuid blob count sum avg min max coalesce now',
    lineComments: ['--'], blockComments: [['/*', '*/']], caseless: true,
    strings: [{ open: "'", close: "'", multiline: true }, { open: '"', close: '"' }, { open: '`', close: '`' }],
  },
  yaml: {
    keywords: 'true false null yes no on off',
    lineComments: ['#'], hashNeedsSpace: true, keyBefore: ':',
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'" }],
  },
  toml: {
    keywords: 'true false',
    lineComments: ['#'], keyBefore: '=', sections: true,
    strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: "'''", close: "'''", multiline: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'" }],
  },
  ini: {
    keywords: 'true false yes no on off',
    lineComments: [';', '#'], commentAtLineStart: true, keyBefore: '=', sections: true,
    strings: [{ open: '"', close: '"', escape: true }],
  },
  html: { markup: true },
  xml: { markup: true },
  css: {
    blockComments: [['/*', '*/']], identExtra: '-', atRules: true, cssProperties: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  },
  lua: {
    keywords: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while',
    types: 'print pairs ipairs require table string math tostring tonumber type setmetatable getmetatable pcall error',
    lineComments: ['--'], blockComments: [['--[[', ']]']],
    strings: [{ open: '[[', close: ']]', multiline: true }, { open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
  },
  powershell: {
    keywords: 'begin break catch class continue data default do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while -and -or -not -eq -ne -gt -ge -lt -le -like -match -contains -in',
    lineComments: ['#'], blockComments: [['<#', '#>']], variables: true, identExtra: '-', caseless: true, capitalTypes: true,
    strings: [{ open: '"', close: '"', multiline: true }, { open: "'", close: "'", multiline: true }],
  },
  dockerfile: {
    keywords: 'from run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell maintainer',
    lineComments: ['#'], commentAtLineStart: true, variables: true, caseless: true, leadingKeywords: true,
    strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'" }],
  },
  diff: { diff: true },
  text: { plain: true },
};

// Only strings, numbers and comments, for code nobody named. Single quotes
// are left alone: in prose they are apostrophes.
const GENERIC = {
  lineComments: ['#', '//'], commentAtLineStart: true,
  strings: [{ open: '"', close: '"', escape: true }],
};

const ALIASES = {
  sh: 'bash', shell: 'bash', zsh: 'bash', ksh: 'bash', console: 'bash', terminal: 'bash',
  py: 'python', python3: 'python', py3: 'python',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  jsonc: 'json', json5: 'json',
  kt: 'kotlin', kts: 'kotlin',
  h: 'c', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
  golang: 'go', rs: 'rust', rb: 'ruby',
  mysql: 'sql', postgres: 'sql', postgresql: 'sql', psql: 'sql', sqlite: 'sql', plsql: 'sql',
  yml: 'yaml', cfg: 'ini', conf: 'ini', properties: 'ini',
  htm: 'html', xhtml: 'html', vue: 'html', svg: 'xml', plist: 'xml', xsd: 'xml',
  scss: 'css', less: 'css',
  ps1: 'powershell', ps: 'powershell', pwsh: 'powershell', psm1: 'powershell',
  patch: 'diff', docker: 'dockerfile',
  txt: 'text', plain: 'text', plaintext: 'text',
};

const compiled = new Map();

function compile(name) {
  let language = compiled.get(name);
  if (!language) {
    const spec = name ? LANGUAGES[name] : GENERIC;
    const words = (list) => new Set((list ?? '').split(' ').filter(Boolean));
    language = { ...spec, keywords: words(spec.keywords), types: words(spec.types), strings: spec.strings ?? [], lineComments: spec.lineComments ?? [], blockComments: spec.blockComments ?? [], identExtra: spec.identExtra ?? '' };
    compiled.set(name, language);
  }
  return language;
}

export function languageName(given) {
  if (!given) return null;
  return Object.hasOwn(LANGUAGES, given) ? given : Object.hasOwn(ALIASES, given) ? ALIASES[given] : null;
}

// Code and an optional fence language in; the label to show, whether it was
// guessed, and [kind, text] runs out, where kind is null for plain text.
export function highlight(code, given = null) {
  let name = languageName(given);
  let label = name ?? given ?? null;
  let detected = false;
  if (!given) {
    name = detect(code);
    label = name;
    detected = name !== null;
  }
  if (code.length > MAX_LENGTH || (name && LANGUAGES[name].plain)) {
    return { language: label, detected, tokens: code ? [[null, code]] : [] };
  }
  const language = compile(name);
  const tokens = language.markup ? scanMarkup(code) : language.diff ? scanDiff(code) : scan(code, language);
  return { language: label, detected, tokens };
}

class Runs {
  constructor(code) {
    this.code = code;
    this.tokens = [];
  }

  push(kind, start, end) {
    if (end <= start) return;
    const last = this.tokens.at(-1);
    if (last && last[0] === kind) {
      last[1] += this.code.slice(start, end);
    } else {
      this.tokens.push([kind, this.code.slice(start, end)]);
    }
  }
}

const isDigit = (unit) => unit >= 48 && unit <= 57;
const isLetter = (unit) => (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122);
const isSpace = (unit) => unit === 32 || unit === 9 || unit === 13;
// Anything outside ASCII counts as part of a word, so a run of it is never
// split and both platforms cut the text in the same places.
const isWordStart = (unit) => isLetter(unit) || unit === 95 || unit >= 128;
const isHex = (unit) => isDigit(unit) || (unit >= 65 && unit <= 70) || (unit >= 97 && unit <= 102);

// Only ASCII changes case, so no letter elsewhere can turn into a keyword.
const asciiLower = (text) => text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
const asciiUpper = (text) => text.replace(/[a-z]+/g, (lower) => lower.toUpperCase());

function lineEnd(code, index) {
  const end = code.indexOf('\n', index);
  return end === -1 ? code.length : end;
}

function findInLine(code, unit, from) {
  for (let at = from; at < code.length && code.charCodeAt(at) !== 10; at++) {
    if (code.charCodeAt(at) === unit) return at;
  }
  return -1;
}

function scan(code, language) {
  const runs = new Runs(code);
  const n = code.length;
  const isWord = (unit) => isWordStart(unit) || isDigit(unit) || (unit < 128 && language.identExtra.includes(String.fromCharCode(unit)));
  // Where each kind of string last failed to close: a later opening before
  // that point cannot close either, which keeps stray quotes linear.
  const failedUntil = new Array(language.strings.length).fill(-1);
  let lineStart = true;
  let depth = 0;
  let index = 0;
  outer: while (index < n) {
    const unit = code.charCodeAt(index);
    if (unit === 10) {
      runs.push(null, index, index + 1);
      index++;
      lineStart = true;
      continue;
    }
    if (isSpace(unit)) {
      runs.push(null, index, index + 1);
      index++;
      continue;
    }
    const atLineStart = lineStart;
    lineStart = false;
    for (const [open, close] of language.blockComments) {
      if (code.startsWith(open, index)) {
        const found = code.indexOf(close, index + open.length);
        const end = found === -1 ? n : found + close.length;
        runs.push('comment', index, end);
        index = end;
        continue outer;
      }
    }
    for (const mark of language.lineComments) {
      if (!code.startsWith(mark, index)) continue;
      if (language.commentAtLineStart && !atLineStart) continue;
      if (mark === '#' && language.hashNeedsSpace && index > 0 && !isSpace(code.charCodeAt(index - 1)) && code.charCodeAt(index - 1) !== 10) continue;
      const end = lineEnd(code, index);
      runs.push('comment', index, end);
      index = end;
      continue outer;
    }
    if (language.preprocessor && atLineStart && unit === 35) {
      let end = index + 1;
      while (end < n && isLetter(code.charCodeAt(end))) end++;
      if (end > index + 1) {
        runs.push('keyword', index, end);
        // The header in #include <stdio.h> reads as a string.
        const word = code.slice(index, end);
        let path = end;
        while (path < n && isSpace(code.charCodeAt(path))) path++;
        const close = (word === '#include' || word === '#import') && code.charCodeAt(path) === 60 ? findInLine(code, 62, path) : -1;
        if (close !== -1) {
          runs.push(null, end, path);
          runs.push('string', path, close + 1);
          end = close + 1;
        }
        index = end;
        continue;
      }
    }
    if (language.sections && atLineStart && unit === 91) {
      const close = findInLine(code, 93, index);
      if (close !== -1) {
        // [[tables]] close with two brackets.
        const end = code.charCodeAt(close + 1) === 93 ? close + 2 : close + 1;
        runs.push('keyword', index, end);
        index = end;
        continue;
      }
    }
    if (language.keyBefore && atLineStart) {
      if (language.keyBefore === ':' && unit === 45 && isSpace(code.charCodeAt(index + 1))) {
        // A YAML list item: its key, if any, follows the dash.
        runs.push(null, index, index + 1);
        index++;
        lineStart = true;
        continue;
      }
      let end = index;
      while (end < n && (isWord(code.charCodeAt(end)) || code.charCodeAt(end) === 45 || code.charCodeAt(end) === 46)) end++;
      let after = end;
      while (after < n && isSpace(code.charCodeAt(after))) after++;
      const separator = language.keyBefore.charCodeAt(0);
      const ends = language.keyBefore === '=' || after + 1 >= n || isSpace(code.charCodeAt(after + 1)) || code.charCodeAt(after + 1) === 10;
      if (end > index && code.charCodeAt(after) === separator && ends) {
        runs.push('property', index, end);
        index = end;
        continue;
      }
    }
    for (let which = 0; which < language.strings.length; which++) {
      const string = language.strings[which];
      if (!code.startsWith(string.open, index) || index < failedUntil[which]) continue;
      const end = stringEnd(code, index, string);
      if (end === -1) {
        failedUntil[which] = string.multiline ? n : lineEnd(code, index);
        continue;
      }
      if (end === -2) continue;
      let kind = 'string';
      if (language.keys) {
        let after = end;
        while (after < n && isSpace(code.charCodeAt(after))) after++;
        if (code.charCodeAt(after) === 58) kind = 'property';
      }
      runs.push(kind, index, end);
      index = end;
      continue outer;
    }
    if (language.variables && unit === 36) {
      const end = variableEnd(code, index);
      if (end > index + 1) {
        runs.push('variable', index, end);
        index = end;
        continue;
      }
    }
    if (language.atRules && unit === 64) {
      let end = index + 1;
      while (end < n && isWord(code.charCodeAt(end))) end++;
      if (end > index + 1) {
        runs.push('keyword', index, end);
        index = end;
        continue;
      }
    }
    if (language.cssProperties) {
      if (unit === 123) depth++;
      if (unit === 125 && depth > 0) depth--;
      if (unit === 35 && depth > 0 && isHex(code.charCodeAt(index + 1))) {
        let end = index + 1;
        while (end < n && isWord(code.charCodeAt(end))) end++;
        runs.push('number', index, end);
        index = end;
        continue;
      }
      if (unit === 33 && code.startsWith('!important', index)) {
        runs.push('keyword', index, index + 10);
        index += 10;
        continue;
      }
    }
    const previous = index > 0 ? code.charCodeAt(index - 1) : 32;
    if ((isDigit(unit) || (unit === 46 && isDigit(code.charCodeAt(index + 1)))) && !isWord(previous) && previous !== 46) {
      const end = numberEnd(code, index, isWord, language.cssProperties);
      runs.push('number', index, end);
      index = end;
      continue;
    }
    // PowerShell operators such as -eq are words that start with a dash.
    const dashWord = unit === 45 && language.caseless && language.identExtra && isLetter(code.charCodeAt(index + 1)) && !isWord(previous);
    if (isWordStart(unit) || dashWord) {
      let end = index + 1;
      while (end < n && isWord(code.charCodeAt(end))) end++;
      const word = code.slice(index, end);
      // After a dash it is a command-line flag (-exec), not a keyword.
      let kind = previous === 45 && language.identExtra.includes('-') && !dashWord ? null : wordKind(word, language, atLineStart);
      if (!kind && language.cssProperties && depth > 0 && declarationStart(code, index)) {
        let after = end;
        while (after < n && isSpace(code.charCodeAt(after))) after++;
        if (code.charCodeAt(after) === 58) kind = 'property';
      }
      runs.push(kind, index, end);
      index = end;
      continue;
    }
    runs.push(null, index, index + 1);
    index++;
  }
  return runs.tokens;
}

// Whether a CSS word begins a declaration rather than a nested selector.
function declarationStart(code, index) {
  let before = index - 1;
  while (before >= 0 && (isSpace(code.charCodeAt(before)) || code.charCodeAt(before) === 10)) before--;
  return before >= 0 && (code.charCodeAt(before) === 123 || code.charCodeAt(before) === 59);
}

function wordKind(word, language, atLineStart) {
  const key = language.caseless ? asciiLower(word) : word;
  if (language.keywords.has(key) && (!language.leadingKeywords || atLineStart)) return 'keyword';
  if (language.types.has(key)) return 'type';
  if (language.capitalTypes) {
    const first = word.charCodeAt(0);
    if (first >= 65 && first <= 90 && /[a-z]/.test(word)) return 'type';
  }
  return null;
}

// The end of a string that opens at index; -1 when it never closes (so the
// quote is just a character), -2 when it is not a character literal after
// all, such as a Rust lifetime.
function stringEnd(code, index, string) {
  const n = code.length;
  if (string.char && code.charCodeAt(index + 1) !== 92) {
    const width = code.charCodeAt(index + 1) >= 0xd800 && code.charCodeAt(index + 1) < 0xdc00 ? 2 : 1;
    return index + 1 + width < n && code.startsWith(string.close, index + 1 + width) ? index + 2 + width : -2;
  }
  let at = index + string.open.length;
  while (at < n) {
    if (string.char && at - index > 12) return -2;
    const unit = code.charCodeAt(at);
    if (string.escape && unit === 92) {
      at += 2;
      continue;
    }
    if (code.startsWith(string.close, at)) return at + string.close.length;
    if (unit === 10 && !string.multiline) return string.char ? -2 : -1;
    at++;
  }
  return string.char ? -2 : -1;
}

function variableEnd(code, index) {
  const n = code.length;
  const next = code.charCodeAt(index + 1);
  if (next === 123) {
    const close = findInLine(code, 125, index);
    return close !== -1 ? close + 1 : index;
  }
  if (isWordStart(next) || isDigit(next)) {
    let end = index + 1;
    while (end < n && (isWordStart(code.charCodeAt(end)) || isDigit(code.charCodeAt(end)))) end++;
    return end;
  }
  return index + 1 < n && '@*#?$!'.includes(code[index + 1]) ? index + 2 : index;
}

function numberEnd(code, index, isWord, css) {
  const n = code.length;
  let end = index;
  const second = code.charCodeAt(index + 1);
  if (code.charCodeAt(index) === 48 && (second === 120 || second === 88 || second === 98 || second === 66 || second === 111 || second === 79)) {
    end += 2;
    while (end < n && (isHex(code.charCodeAt(end)) || code.charCodeAt(end) === 95)) end++;
  } else {
    while (end < n && (isDigit(code.charCodeAt(end)) || code.charCodeAt(end) === 95)) end++;
    if (code.charCodeAt(end) === 46 && isDigit(code.charCodeAt(end + 1))) {
      end++;
      while (end < n && (isDigit(code.charCodeAt(end)) || code.charCodeAt(end) === 95)) end++;
    }
    const exponent = code.charCodeAt(end);
    if (exponent === 101 || exponent === 69) {
      const sign = code.charCodeAt(end + 1);
      if (isDigit(sign)) end += 1;
      else if ((sign === 43 || sign === 45) && isDigit(code.charCodeAt(end + 2))) end += 2;
      while (end < n && isDigit(code.charCodeAt(end))) end++;
    }
  }
  // Suffixes and units: 10u, 2.5f, 12px, 50%.
  while (end < n && (isWord(code.charCodeAt(end)) || (css && code.charCodeAt(end) === 37))) end++;
  return end;
}

function scanMarkup(code) {
  const runs = new Runs(code);
  const n = code.length;
  let inTag = false;
  // A quote with no partner anywhere after it never will have one.
  const unclosed = new Set();
  let index = 0;
  while (index < n) {
    const unit = code.charCodeAt(index);
    if (!inTag && code.startsWith('<!--', index)) {
      const found = code.indexOf('-->', index + 4);
      const end = found === -1 ? n : found + 3;
      runs.push('comment', index, end);
      index = end;
      continue;
    }
    if (!inTag && unit === 60) {
      let start = index + 1;
      const next = code.charCodeAt(start);
      if (next === 47 || next === 33 || next === 63) start++;
      let end = start;
      while (end < n && (isWordStart(code.charCodeAt(end)) || isDigit(code.charCodeAt(end)) || ':-.'.includes(code[end]))) end++;
      if (end > start && isWordStart(code.charCodeAt(start))) {
        runs.push(null, index, start);
        runs.push('keyword', start, end);
        index = end;
        inTag = true;
        continue;
      }
    }
    if (inTag) {
      if (unit === 62) {
        inTag = false;
      } else if ((unit === 34 || unit === 39) && !unclosed.has(unit)) {
        const close = code.indexOf(code[index], index + 1);
        if (close !== -1) {
          runs.push('string', index, close + 1);
          index = close + 1;
          continue;
        }
        unclosed.add(unit);
      } else if (isWordStart(unit)) {
        let end = index + 1;
        while (end < n && (isWordStart(code.charCodeAt(end)) || isDigit(code.charCodeAt(end)) || ':-.'.includes(code[end]))) end++;
        runs.push('type', index, end);
        index = end;
        continue;
      }
    }
    runs.push(null, index, index + 1);
    index++;
  }
  return runs.tokens;
}

function scanDiff(code) {
  const runs = new Runs(code);
  let index = 0;
  while (index < code.length) {
    const end = lineEnd(code, index);
    const line = code.slice(index, end);
    let kind = null;
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ')) kind = 'keyword';
    else if (line.startsWith('@@')) kind = 'type';
    else if (line.startsWith('+')) kind = 'inserted';
    else if (line.startsWith('-')) kind = 'deleted';
    runs.push(kind, index, end);
    runs.push(null, end, Math.min(end + 1, code.length));
    index = end + 1;
  }
  return runs.tokens;
}

const SHELL_COMMANDS = new Set('sudo apt apt-get brew npm npx yarn pnpm git cd echo export curl wget docker kubectl pip pip3 make ssh scp ls mkdir rm cp mv chmod chown systemctl journalctl pacman yay dnf tar cat grep sed awk'.split(' '));
const SQL_STARTS = { SELECT: ['FROM'], INSERT: ['INTO'], UPDATE: ['SET'], DELETE: ['FROM'], CREATE: ['TABLE', 'INDEX', 'VIEW', 'DATABASE'], ALTER: ['TABLE'], DROP: ['TABLE', 'INDEX', 'VIEW', 'DATABASE'], WITH: ['SELECT'] };
const SWIFT_IMPORTS = ['import Foundation', 'import SwiftUI', 'import UIKit', 'import AppKit', 'import Combine'];

// A guess at the language of an unlabelled block. Each rule needs something
// only that language writes; anything less certain returns null.
export function detect(code) {
  const lines = [];
  let start = 0;
  while (start <= code.length && lines.length < DETECT_LINES) {
    const end = lineEnd(code, start);
    lines.push(code.slice(start, end).replace(/[ \t\r]+$/, ''));
    start = end + 1;
  }
  const trimmed = lines.map((line) => line.replace(/^[ \t]+/, '')).filter((line) => line);
  if (trimmed.length === 0) return null;
  const first = trimmed[0];
  const starts = (...prefixes) => trimmed.some((line) => prefixes.some((prefix) => line.startsWith(prefix)));
  if (first.startsWith('#!')) return shebang(first);
  if (first.startsWith('<?php')) return 'php';
  if (first.startsWith('<?xml')) return 'xml';
  if (asciiLower(first).startsWith('<!doctype html') || first.startsWith('<html')) return 'html';
  if ((first[0] === '{' || first[0] === '[') && code.length <= 100_000) {
    try {
      const value = JSON.parse(code);
      if (value !== null && typeof value === 'object') return 'json';
    } catch {
      // Not JSON after all.
    }
  }
  if (first.startsWith('diff --git') || (starts('@@ -') && starts('--- ', '+++ '))) return 'diff';
  if (starts('#include <', '#include "')) return code.includes('std::') || code.includes('iostream') || starts('namespace ', 'class ', 'template<', 'template <') ? 'cpp' : 'c';
  const firstWord = first.split(/[ \t(;]/)[0];
  if (Object.hasOwn(SQL_STARTS, asciiUpper(firstWord))) {
    const words = new Set(asciiUpper(code.slice(0, 4000)).split(/[^A-Z_]+/));
    if (SQL_STARTS[asciiUpper(firstWord)].some((word) => words.has(word))) return 'sql';
  }
  if (firstWord === 'FROM' && starts('RUN ', 'COPY ', 'CMD ', 'ENTRYPOINT ')) return 'dockerfile';
  if (starts('package ') && starts('func ')) return 'go';
  if (trimmed.some((line) => SWIFT_IMPORTS.includes(line)) || starts('guard let ', 'if let ', '@State ', '@Published ')) return 'swift';
  if (starts('fn ', 'pub fn ', 'impl ', 'use std::', 'let mut ') || code.includes('println!(')) return 'rust';
  if (starts('fun ')) return 'kotlin';
  if (starts('public class ', 'public static void main')) return 'java';
  if (starts('using System')) return 'csharp';
  if (starts('if __name__ ==') || trimmed.some((line) => /^from [\w.]+ import /.test(line))) return 'python';
  if (starts('def ', 'class ', 'import ') && colonBlock(lines)) return 'python';
  if (starts('def ') && trimmed.includes('end')) return 'ruby';
  if (starts('const ', 'let ', 'function ', 'export ', 'async function ', 'import {') || code.includes('=>') || code.includes('console.log(') || code.includes('require(')) {
    return starts('interface ', 'type ', 'export interface ') || code.includes(': string') || code.includes(': number') ? 'typescript' : 'javascript';
  }
  if (first.startsWith('$ ') || SHELL_COMMANDS.has(firstWord)) return 'bash';
  return null;
}

function shebang(line) {
  const parts = line.slice(2).replace(/^[ \t]+/, '').split(/[ \t]+/);
  let program = parts[0].split('/').at(-1);
  if (program === 'env') program = parts.slice(1).find((part) => !part.startsWith('-')) ?? '';
  if (['bash', 'sh', 'zsh', 'ksh', 'dash', 'fish'].includes(program)) return 'bash';
  if (program.startsWith('python')) return 'python';
  if (['node', 'deno', 'bun'].includes(program)) return 'javascript';
  if (['ruby', 'php', 'lua'].includes(program)) return program;
  if (program === 'pwsh') return 'powershell';
  return null;
}

// A line ending in a colon followed by a more indented line, as Python blocks are.
function colonBlock(lines) {
  const indent = (line) => line.length - line.replace(/^[ \t]+/, '').length;
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].endsWith(':')) continue;
    const next = lines.slice(index + 1).find((line) => indent(line) < line.length);
    if (next && indent(next) > indent(lines[index])) return true;
  }
  return false;
}
