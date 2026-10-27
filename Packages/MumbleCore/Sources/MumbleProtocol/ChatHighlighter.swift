import Foundation

/// Syntax highlighting for chat code blocks. A hand-written scanner rather
/// than regular expressions, so long scripts stay linear. The fence language
/// picks the rules; without one a conservative guess is made, and when the
/// guess is unsure only strings, numbers and comments are coloured.
/// web/app/highlight.js is the same highlighter for the browser; both are
/// checked against web/test/fixtures/highlight.json. The scanner works on
/// UTF-16 units, as JavaScript strings do, so both cut text in the same places.
public enum ChatHighlighter {
    public enum Kind: String, Sendable {
        case keyword, string, number, comment, type, property, variable, inserted, deleted
    }

    public struct Token: Hashable, Sendable {
        public var kind: Kind?
        public var text: String
    }

    public struct Highlight: Hashable, Sendable {
        /// The label to show: the language's name, the fence word when it is
        /// not one we know, or nil for unlabelled code that matched nothing.
        public var language: String?
        /// Whether the language was guessed rather than given.
        public var detected: Bool
        public var tokens: [Token]
    }

    private static let maxLength = 200_000
    private static let detectLines = 200

    public static func languageName(_ given: String?) -> String? {
        guard let given else { return nil }
        if languages[given] != nil { return given }
        return aliases[given]
    }

    public static func highlight(_ code: String, language given: String? = nil) -> Highlight {
        var name = languageName(given)
        var label = name ?? given
        var detected = false
        if given == nil || given?.isEmpty == true {
            name = detect(code)
            label = name
            detected = name != nil
        }
        let units = Array(code.utf16)
        let language = name.flatMap { languages[$0] } ?? generic
        if units.count > maxLength || language.plain {
            return Highlight(language: label, detected: detected, tokens: code.isEmpty ? [] : [Token(kind: nil, text: code)])
        }
        let runs: Runs
        if language.markup {
            runs = scanMarkup(units)
        } else if language.diff {
            runs = scanDiff(units)
        } else {
            runs = scan(units, language)
        }
        return Highlight(language: label, detected: detected, tokens: runs.tokens(units))
    }

    // MARK: - Languages

    struct StringRule: Sendable {
        let open: [UInt16]
        let close: [UInt16]
        let escape: Bool
        let multiline: Bool
        let char: Bool

        init(_ open: String, _ close: String, escape: Bool = false, multiline: Bool = false, char: Bool = false) {
            self.open = Array(open.utf16)
            self.close = Array(close.utf16)
            self.escape = escape
            self.multiline = multiline
            self.char = char
        }
    }

    /// Each language is a set of switches for the one scanner. Keyword and
    /// type lists are space-separated; caseless languages list them in lowercase.
    struct Language: Sendable {
        let keywords: Set<String>
        let types: Set<String>
        let lineComments: [[UInt16]]
        let blockComments: [(open: [UInt16], close: [UInt16])]
        let strings: [StringRule]
        let hashNeedsSpace, commentAtLineStart, variables, capitalTypes, caseless, preprocessor: Bool
        let keys, sections, atRules, cssProperties, leadingKeywords, markup, diff, plain: Bool
        let identExtra: Set<UInt16>
        let keyBefore: UInt16?

        init(
            keywords: String = "", types: String = "", lineComments: [String] = [], blockComments: [(String, String)] = [], strings: [StringRule] = [],
            hashNeedsSpace: Bool = false, commentAtLineStart: Bool = false, variables: Bool = false, capitalTypes: Bool = false, caseless: Bool = false,
            preprocessor: Bool = false, keys: Bool = false, sections: Bool = false, atRules: Bool = false, cssProperties: Bool = false,
            leadingKeywords: Bool = false, markup: Bool = false, diff: Bool = false, plain: Bool = false, identExtra: String = "", keyBefore: String? = nil
        ) {
            self.keywords = Set(keywords.split(separator: " ").map(String.init))
            self.types = Set(types.split(separator: " ").map(String.init))
            self.lineComments = lineComments.map { Array($0.utf16) }
            self.blockComments = blockComments.map { (Array($0.0.utf16), Array($0.1.utf16)) }
            self.strings = strings
            self.hashNeedsSpace = hashNeedsSpace
            self.commentAtLineStart = commentAtLineStart
            self.variables = variables
            self.capitalTypes = capitalTypes
            self.caseless = caseless
            self.preprocessor = preprocessor
            self.keys = keys
            self.sections = sections
            self.atRules = atRules
            self.cssProperties = cssProperties
            self.leadingKeywords = leadingKeywords
            self.markup = markup
            self.diff = diff
            self.plain = plain
            self.identExtra = Set(identExtra.utf16)
            self.keyBefore = keyBefore?.utf16.first
        }
    }

    // Generated from the tables in web/app/highlight.js; keep them in step.
    static let languages: [String: Language] = [
        "bash": Language(keywords: "if then else elif fi case esac for select while until do done in function time return exit break continue local export readonly declare unset shift source alias set trap eval exec true false", types: "echo printf read cd pwd test", lineComments: ["#"], strings: [.init("\"", "\"", escape: true, multiline: true), .init("'", "'", multiline: true), .init("`", "`", escape: true, multiline: true)], hashNeedsSpace: true, variables: true, identExtra: "-"),
        "python": Language(keywords: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case None True False self", types: "int float str bool bytes list dict set tuple object type len print range open super isinstance Exception", lineComments: ["#"], strings: [.init("\"\"\"", "\"\"\"", escape: true, multiline: true), .init("'''", "'''", escape: true, multiline: true), .init("\"", "\"", escape: true), .init("'", "'", escape: true)], capitalTypes: true),
        "javascript": Language(keywords: "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined NaN Infinity", types: "console window document globalThis Array Object String Number Boolean Promise Map Set JSON Math Date Error RegExp Symbol", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("'", "'", escape: true), .init("`", "`", escape: true, multiline: true)], capitalTypes: true),
        "typescript": Language(keywords: "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined NaN Infinity abstract as declare enum implements interface keyof namespace private protected public readonly satisfies type", types: "string number boolean any unknown never object symbol bigint console window document globalThis Array Object String Number Boolean Promise Map Set Record Partial JSON Math Date Error RegExp Symbol", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("'", "'", escape: true), .init("`", "`", escape: true, multiline: true)], capitalTypes: true),
        "json": Language(keywords: "true false null", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true)], keys: true),
        "swift": Language(keywords: "actor associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nil nonisolated open operator override private protocol public repeat rethrows return self Self some any static struct subscript super switch throw throws true false try typealias var weak where while", types: "Int Double Float Bool String Character Void Array Dictionary Set Optional", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"\"\"", "\"\"\"", escape: true, multiline: true), .init("\"", "\"", escape: true)], capitalTypes: true),
        "kotlin": Language(keywords: "abstract as break by catch class companion const constructor continue data do else enum false final finally for fun if import in init inner interface internal is lateinit null object open operator out override package private protected public return sealed super suspend this throw true try typealias val var when where while", types: "Int Long Short Byte Double Float Boolean Char String Unit Any Nothing List Map Set Array", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"\"\"", "\"\"\"", multiline: true), .init("\"", "\"", escape: true), .init("'", "'", escape: true, char: true)], capitalTypes: true),
        "java": Language(keywords: "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var volatile while record yield true false null", types: "void boolean byte char short int long float double String Object Integer Long Double Boolean List Map", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"\"\"", "\"\"\"", escape: true, multiline: true), .init("\"", "\"", escape: true), .init("'", "'", escape: true, char: true)], capitalTypes: true),
        "c": Language(keywords: "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while NULL true false", types: "void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("'", "'", escape: true, char: true)], preprocessor: true),
        "cpp": Language(keywords: "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while NULL true false alignas alignof catch class constexpr consteval co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept nullptr operator override private protected public static_cast dynamic_cast reinterpret_cast const_cast template this throw try typename using virtual final concept requires", types: "void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE auto wchar_t char8_t char16_t char32_t std string vector map unique_ptr shared_ptr", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("'", "'", escape: true, char: true)], capitalTypes: true, preprocessor: true),
        "csharp": Language(keywords: "abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern false finally fixed for foreach get goto if implicit in init interface internal is lock namespace new null operator out override params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this throw true try typeof unchecked unsafe using var virtual void volatile when where while yield", types: "bool byte sbyte char decimal double float int uint long ulong short ushort object string dynamic nint nuint", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("'", "'", escape: true, char: true)], capitalTypes: true, preprocessor: true),
        "go": Language(keywords: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota", types: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any append cap close copy delete len make new panic print println recover", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("`", "`", multiline: true), .init("'", "'", escape: true, char: true)], capitalTypes: true),
        "rust": Language(keywords: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while", types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Some None Ok Err", lineComments: ["//"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true, multiline: true), .init("'", "'", escape: true, char: true)], capitalTypes: true),
        "ruby": Language(keywords: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor attr_reader puts", lineComments: ["#"], strings: [.init("\"", "\"", escape: true, multiline: true), .init("'", "'", escape: true, multiline: true)], capitalTypes: true),
        "php": Language(keywords: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null", types: "int float bool string void mixed object iterable self parent", lineComments: ["//", "#"], blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true, multiline: true), .init("'", "'", escape: true, multiline: true)], variables: true, capitalTypes: true, caseless: true),
        "sql": Language(keywords: "add all alter and any as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction truncate union unique update using values view when where with true false", types: "int integer bigint smallint serial decimal numeric real float double boolean bool char varchar text date time timestamp timestamptz json jsonb uuid blob count sum avg min max coalesce now", lineComments: ["--"], blockComments: [("/*", "*/")], strings: [.init("'", "'", multiline: true), .init("\"", "\""), .init("`", "`")], caseless: true),
        "yaml": Language(keywords: "true false null yes no on off", lineComments: ["#"], strings: [.init("\"", "\"", escape: true), .init("'", "'")], hashNeedsSpace: true, keyBefore: ":"),
        "toml": Language(keywords: "true false", lineComments: ["#"], strings: [.init("\"\"\"", "\"\"\"", escape: true, multiline: true), .init("'''", "'''", multiline: true), .init("\"", "\"", escape: true), .init("'", "'")], sections: true, keyBefore: "="),
        "ini": Language(keywords: "true false yes no on off", lineComments: [";", "#"], strings: [.init("\"", "\"", escape: true)], commentAtLineStart: true, sections: true, keyBefore: "="),
        "html": Language(markup: true),
        "xml": Language(markup: true),
        "css": Language(blockComments: [("/*", "*/")], strings: [.init("\"", "\"", escape: true), .init("'", "'", escape: true)], atRules: true, cssProperties: true, identExtra: "-"),
        "lua": Language(keywords: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while", types: "print pairs ipairs require table string math tostring tonumber type setmetatable getmetatable pcall error", lineComments: ["--"], blockComments: [("--[[", "]]")], strings: [.init("[[", "]]", multiline: true), .init("\"", "\"", escape: true), .init("'", "'", escape: true)]),
        "powershell": Language(keywords: "begin break catch class continue data default do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while -and -or -not -eq -ne -gt -ge -lt -le -like -match -contains -in", lineComments: ["#"], blockComments: [("<#", "#>")], strings: [.init("\"", "\"", multiline: true), .init("'", "'", multiline: true)], variables: true, capitalTypes: true, caseless: true, identExtra: "-"),
        "dockerfile": Language(keywords: "from run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell maintainer", lineComments: ["#"], strings: [.init("\"", "\"", escape: true), .init("'", "'")], commentAtLineStart: true, variables: true, caseless: true, leadingKeywords: true),
        "diff": Language(diff: true),
        "text": Language(plain: true),
    ]

    static let generic = Language(lineComments: ["#", "//"], strings: [.init("\"", "\"", escape: true)], commentAtLineStart: true)

    static let aliases: [String: String] = [
        "sh": "bash", "shell": "bash", "zsh": "bash", "ksh": "bash", "console": "bash", "terminal": "bash",
        "py": "python", "python3": "python", "py3": "python", "js": "javascript", "jsx": "javascript", "mjs": "javascript",
        "cjs": "javascript", "node": "javascript", "ts": "typescript", "tsx": "typescript", "mts": "typescript", "jsonc": "json",
        "json5": "json", "kt": "kotlin", "kts": "kotlin", "h": "c", "c++": "cpp", "cc": "cpp",
        "cxx": "cpp", "hpp": "cpp", "hh": "cpp", "cs": "csharp", "c#": "csharp", "golang": "go",
        "rs": "rust", "rb": "ruby", "mysql": "sql", "postgres": "sql", "postgresql": "sql", "psql": "sql",
        "sqlite": "sql", "plsql": "sql", "yml": "yaml", "cfg": "ini", "conf": "ini", "properties": "ini",
        "htm": "html", "xhtml": "html", "vue": "html", "svg": "xml", "plist": "xml", "xsd": "xml",
        "scss": "css", "less": "css", "ps1": "powershell", "ps": "powershell", "pwsh": "powershell", "psm1": "powershell",
        "patch": "diff", "docker": "dockerfile", "txt": "text", "plain": "text", "plaintext": "text",
    ]

    // MARK: - Scanning

    /// Runs of one kind, kept as ranges and only turned into text at the
    /// end, so a run never splits a character.
    struct Runs {
        var ranges: [(kind: Kind?, start: Int, end: Int)] = []

        mutating func push(_ kind: Kind?, _ start: Int, _ end: Int) {
            guard end > start else { return }
            if let last = ranges.last, last.kind == kind {
                ranges[ranges.count - 1].end = end
            } else {
                ranges.append((kind, start, end))
            }
        }

        func tokens(_ units: [UInt16]) -> [Token] {
            ranges.map { Token(kind: $0.kind, text: String(decoding: units[$0.start..<$0.end], as: UTF16.self)) }
        }
    }

    private static func isDigit(_ unit: UInt16) -> Bool { unit >= 48 && unit <= 57 }
    private static func isLetter(_ unit: UInt16) -> Bool { (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) }
    private static func isSpace(_ unit: UInt16) -> Bool { unit == 32 || unit == 9 || unit == 13 }
    /// Anything outside ASCII counts as part of a word, so a run of it is
    /// never split.
    private static func isWordStart(_ unit: UInt16) -> Bool { isLetter(unit) || unit == 95 || unit >= 128 }
    private static func isHex(_ unit: UInt16) -> Bool { isDigit(unit) || (unit >= 65 && unit <= 70) || (unit >= 97 && unit <= 102) }

    /// The unit at an index, or 0 past either end, where JavaScript's
    /// charCodeAt gives NaN; neither matches anything the scanner looks for.
    private static func at(_ units: [UInt16], _ index: Int) -> UInt16 {
        index >= 0 && index < units.count ? units[index] : 0
    }

    private static func starts(_ units: [UInt16], _ prefix: [UInt16], at index: Int) -> Bool {
        guard index >= 0, index + prefix.count <= units.count else { return false }
        for offset in 0..<prefix.count where units[index + offset] != prefix[offset] { return false }
        return true
    }

    private static func find(_ units: [UInt16], _ needle: [UInt16], from start: Int) -> Int? {
        var index = start
        while index + needle.count <= units.count {
            if starts(units, needle, at: index) { return index }
            index += 1
        }
        return nil
    }

    private static func lineEnd(_ units: [UInt16], _ index: Int) -> Int {
        var end = index
        while end < units.count, units[end] != 10 { end += 1 }
        return end
    }

    private static func findInLine(_ units: [UInt16], _ unit: UInt16, from start: Int) -> Int? {
        var index = start
        while index < units.count, units[index] != 10 {
            if units[index] == unit { return index }
            index += 1
        }
        return nil
    }

    private static func text(_ units: [UInt16], _ start: Int, _ end: Int) -> String {
        String(decoding: units[start..<end], as: UTF16.self)
    }

    /// Only ASCII changes case, so no letter elsewhere can turn into a keyword.
    private static func asciiLower(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: units.map { $0 >= 65 && $0 <= 90 ? $0 + 32 : $0 }, as: UTF16.self)
    }

    private static func asciiUpper(_ units: ArraySlice<UInt16>) -> [UInt16] {
        units.map { $0 >= 97 && $0 <= 122 ? $0 - 32 : $0 }
    }

    private static let important = Array("!important".utf16)

    private static func scan(_ code: [UInt16], _ language: Language) -> Runs {
        var runs = Runs()
        let n = code.count
        func isWord(_ unit: UInt16) -> Bool {
            isWordStart(unit) || isDigit(unit) || (unit < 128 && language.identExtra.contains(unit))
        }
        // Where each kind of string last failed to close: a later opening
        // before that point cannot close either, which keeps stray quotes linear.
        var failedUntil = Array(repeating: -1, count: language.strings.count)
        var lineStart = true
        var depth = 0
        var index = 0
        outer: while index < n {
            let unit = code[index]
            if unit == 10 {
                runs.push(nil, index, index + 1)
                index += 1
                lineStart = true
                continue
            }
            if isSpace(unit) {
                runs.push(nil, index, index + 1)
                index += 1
                continue
            }
            let atLineStart = lineStart
            lineStart = false
            for (open, close) in language.blockComments where starts(code, open, at: index) {
                let end = find(code, close, from: index + open.count).map { $0 + close.count } ?? n
                runs.push(.comment, index, end)
                index = end
                continue outer
            }
            for mark in language.lineComments where starts(code, mark, at: index) {
                if language.commentAtLineStart && !atLineStart { continue }
                if mark == [35], language.hashNeedsSpace, index > 0, !isSpace(code[index - 1]), code[index - 1] != 10 { continue }
                let end = lineEnd(code, index)
                runs.push(.comment, index, end)
                index = end
                continue outer
            }
            if language.preprocessor && atLineStart && unit == 35 {
                var end = index + 1
                while end < n, isLetter(code[end]) { end += 1 }
                if end > index + 1 {
                    runs.push(.keyword, index, end)
                    // The header in #include <stdio.h> reads as a string.
                    let word = text(code, index, end)
                    var path = end
                    while path < n, isSpace(code[path]) { path += 1 }
                    if word == "#include" || word == "#import", at(code, path) == 60, let close = findInLine(code, 62, from: path) {
                        runs.push(nil, end, path)
                        runs.push(.string, path, close + 1)
                        end = close + 1
                    }
                    index = end
                    continue
                }
            }
            if language.sections && atLineStart && unit == 91, let close = findInLine(code, 93, from: index) {
                // [[tables]] close with two brackets.
                let end = at(code, close + 1) == 93 ? close + 2 : close + 1
                runs.push(.keyword, index, end)
                index = end
                continue
            }
            if let separator = language.keyBefore, atLineStart {
                if separator == 58 && unit == 45 && isSpace(at(code, index + 1)) {
                    // A YAML list item: its key, if any, follows the dash.
                    runs.push(nil, index, index + 1)
                    index += 1
                    lineStart = true
                    continue
                }
                var end = index
                while end < n, isWord(code[end]) || code[end] == 45 || code[end] == 46 { end += 1 }
                var after = end
                while after < n, isSpace(code[after]) { after += 1 }
                let ends = separator == 61 || after + 1 >= n || isSpace(at(code, after + 1)) || at(code, after + 1) == 10
                if end > index && at(code, after) == separator && ends {
                    runs.push(.property, index, end)
                    index = end
                    continue
                }
            }
            for (which, string) in language.strings.enumerated() {
                guard starts(code, string.open, at: index), index >= failedUntil[which] else { continue }
                let end = stringEnd(code, index, string)
                if end == -1 {
                    failedUntil[which] = string.multiline ? n : lineEnd(code, index)
                    continue
                }
                if end == -2 { continue }
                var kind = Kind.string
                if language.keys {
                    var after = end
                    while after < n, isSpace(code[after]) { after += 1 }
                    if at(code, after) == 58 { kind = .property }
                }
                runs.push(kind, index, end)
                index = end
                continue outer
            }
            if language.variables && unit == 36 {
                let end = variableEnd(code, index)
                if end > index + 1 {
                    runs.push(.variable, index, end)
                    index = end
                    continue
                }
            }
            if language.atRules && unit == 64 {
                var end = index + 1
                while end < n, isWord(code[end]) { end += 1 }
                if end > index + 1 {
                    runs.push(.keyword, index, end)
                    index = end
                    continue
                }
            }
            if language.cssProperties {
                if unit == 123 { depth += 1 }
                if unit == 125 && depth > 0 { depth -= 1 }
                if unit == 35 && depth > 0 && isHex(at(code, index + 1)) {
                    var end = index + 1
                    while end < n, isWord(code[end]) { end += 1 }
                    runs.push(.number, index, end)
                    index = end
                    continue
                }
                if unit == 33 && starts(code, important, at: index) {
                    runs.push(.keyword, index, index + important.count)
                    index += important.count
                    continue
                }
            }
            let previous: UInt16 = index > 0 ? code[index - 1] : 32
            if (isDigit(unit) || (unit == 46 && isDigit(at(code, index + 1)))) && !isWord(previous) && previous != 46 {
                let end = numberEnd(code, index, isWord, css: language.cssProperties)
                runs.push(.number, index, end)
                index = end
                continue
            }
            // PowerShell operators such as -eq are words that start with a dash.
            let dashWord = unit == 45 && language.caseless && !language.identExtra.isEmpty && isLetter(at(code, index + 1)) && !isWord(previous)
            if isWordStart(unit) || dashWord {
                var end = index + 1
                while end < n, isWord(code[end]) { end += 1 }
                // After a dash it is a command-line flag (-exec), not a keyword.
                var kind = previous == 45 && language.identExtra.contains(45) && !dashWord ? nil : wordKind(code[index..<end], language, atLineStart: atLineStart)
                if kind == nil && language.cssProperties && depth > 0 && declarationStart(code, index) {
                    var after = end
                    while after < n, isSpace(code[after]) { after += 1 }
                    if at(code, after) == 58 { kind = .property }
                }
                runs.push(kind, index, end)
                index = end
                continue
            }
            runs.push(nil, index, index + 1)
            index += 1
        }
        return runs
    }

    /// Whether a CSS word begins a declaration rather than a nested selector.
    private static func declarationStart(_ code: [UInt16], _ index: Int) -> Bool {
        var before = index - 1
        while before >= 0, isSpace(code[before]) || code[before] == 10 { before -= 1 }
        return before >= 0 && (code[before] == 123 || code[before] == 59)
    }

    private static func wordKind(_ word: ArraySlice<UInt16>, _ language: Language, atLineStart: Bool) -> Kind? {
        let key = language.caseless ? asciiLower(word) : String(decoding: word, as: UTF16.self)
        if language.keywords.contains(key) && (!language.leadingKeywords || atLineStart) { return .keyword }
        if language.types.contains(key) { return .type }
        if language.capitalTypes, let first = word.first, first >= 65 && first <= 90, word.contains(where: { $0 >= 97 && $0 <= 122 }) {
            return .type
        }
        return nil
    }

    /// The end of a string that opens at index; -1 when it never closes (so
    /// the quote is just a character), -2 when it is not a character literal
    /// after all, such as a Rust lifetime.
    private static func stringEnd(_ code: [UInt16], _ index: Int, _ string: StringRule) -> Int {
        let n = code.count
        if string.char && at(code, index + 1) != 92 {
            let width = at(code, index + 1) >= 0xD800 && at(code, index + 1) < 0xDC00 ? 2 : 1
            return index + 1 + width < n && starts(code, string.close, at: index + 1 + width) ? index + 2 + width : -2
        }
        var position = index + string.open.count
        while position < n {
            if string.char && position - index > 12 { return -2 }
            let unit = code[position]
            if string.escape && unit == 92 {
                position += 2
                continue
            }
            if starts(code, string.close, at: position) { return position + string.close.count }
            if unit == 10 && !string.multiline { return string.char ? -2 : -1 }
            position += 1
        }
        return string.char ? -2 : -1
    }

    private static func variableEnd(_ code: [UInt16], _ index: Int) -> Int {
        let n = code.count
        let next = at(code, index + 1)
        if next == 123 {
            return findInLine(code, 125, from: index).map { $0 + 1 } ?? index
        }
        if isWordStart(next) || isDigit(next) {
            var end = index + 1
            while end < n, isWordStart(code[end]) || isDigit(code[end]) { end += 1 }
            return end
        }
        return index + 1 < n && Array("@*#?$!".utf16).contains(next) ? index + 2 : index
    }

    private static func numberEnd(_ code: [UInt16], _ index: Int, _ isWord: (UInt16) -> Bool, css: Bool) -> Int {
        let n = code.count
        var end = index
        let second = at(code, index + 1)
        if code[index] == 48 && [120, 88, 98, 66, 111, 79].contains(second) {
            end += 2
            while end < n, isHex(code[end]) || code[end] == 95 { end += 1 }
        } else {
            while end < n, isDigit(code[end]) || code[end] == 95 { end += 1 }
            if at(code, end) == 46 && isDigit(at(code, end + 1)) {
                end += 1
                while end < n, isDigit(code[end]) || code[end] == 95 { end += 1 }
            }
            let exponent = at(code, end)
            if exponent == 101 || exponent == 69 {
                let sign = at(code, end + 1)
                if isDigit(sign) {
                    end += 1
                } else if (sign == 43 || sign == 45) && isDigit(at(code, end + 2)) {
                    end += 2
                }
                while end < n, isDigit(code[end]) { end += 1 }
            }
        }
        // Suffixes and units: 10u, 2.5f, 12px, 50%.
        while end < n, isWord(code[end]) || (css && code[end] == 37) { end += 1 }
        return end
    }

    private static let commentOpen = Array("<!--".utf16)
    private static let commentClose = Array("-->".utf16)

    private static func scanMarkup(_ code: [UInt16]) -> Runs {
        var runs = Runs()
        let n = code.count
        func isName(_ unit: UInt16) -> Bool { isWordStart(unit) || isDigit(unit) || unit == 58 || unit == 45 || unit == 46 }
        var inTag = false
        // A quote with no partner anywhere after it never will have one.
        var unclosed = Set<UInt16>()
        var index = 0
        while index < n {
            let unit = code[index]
            if !inTag && starts(code, commentOpen, at: index) {
                let end = find(code, commentClose, from: index + 4).map { $0 + 3 } ?? n
                runs.push(.comment, index, end)
                index = end
                continue
            }
            if !inTag && unit == 60 {
                var start = index + 1
                let next = at(code, start)
                if next == 47 || next == 33 || next == 63 { start += 1 }
                var end = start
                while end < n, isName(code[end]) { end += 1 }
                if end > start && isWordStart(code[start]) {
                    runs.push(nil, index, start)
                    runs.push(.keyword, start, end)
                    index = end
                    inTag = true
                    continue
                }
            }
            if inTag {
                if unit == 62 {
                    inTag = false
                } else if (unit == 34 || unit == 39) && !unclosed.contains(unit) {
                    if let close = find(code, [unit], from: index + 1) {
                        runs.push(.string, index, close + 1)
                        index = close + 1
                        continue
                    }
                    unclosed.insert(unit)
                } else if isWordStart(unit) {
                    var end = index + 1
                    while end < n, isName(code[end]) { end += 1 }
                    runs.push(.type, index, end)
                    index = end
                    continue
                }
            }
            runs.push(nil, index, index + 1)
            index += 1
        }
        return runs
    }

    private static func scanDiff(_ code: [UInt16]) -> Runs {
        var runs = Runs()
        var index = 0
        while index < code.count {
            let end = lineEnd(code, index)
            let line = Array(code[index..<end])
            var kind: Kind?
            if ["+++ ", "--- ", "diff ", "index "].contains(where: { hasPrefix(line, $0) }) {
                kind = .keyword
            } else if hasPrefix(line, "@@") {
                kind = .type
            } else if hasPrefix(line, "+") {
                kind = .inserted
            } else if hasPrefix(line, "-") {
                kind = .deleted
            }
            runs.push(kind, index, end)
            runs.push(nil, end, min(end + 1, code.count))
            index = end + 1
        }
        return runs
    }

    // MARK: - Detection

    private static let shellCommands = Set("sudo apt apt-get brew npm npx yarn pnpm git cd echo export curl wget docker kubectl pip pip3 make ssh scp ls mkdir rm cp mv chmod chown systemctl journalctl pacman yay dnf tar cat grep sed awk".split(separator: " ").map(String.init))
    private static let sqlStarts: [String: [String]] = ["SELECT": ["FROM"], "INSERT": ["INTO"], "UPDATE": ["SET"], "DELETE": ["FROM"], "CREATE": ["TABLE", "INDEX", "VIEW", "DATABASE"], "ALTER": ["TABLE"], "DROP": ["TABLE", "INDEX", "VIEW", "DATABASE"], "WITH": ["SELECT"]]
    private static let swiftImports = ["import Foundation", "import SwiftUI", "import UIKit", "import AppKit", "import Combine"].map { Array($0.utf16) }

    private static func hasPrefix(_ line: [UInt16], _ prefix: String) -> Bool {
        starts(line, Array(prefix.utf16), at: 0)
    }

    private static func contains(_ units: [UInt16], _ needle: String) -> Bool {
        find(units, Array(needle.utf16), from: 0) != nil
    }

    private static func leadingBlanks(_ line: [UInt16]) -> Int {
        line.prefix { $0 == 32 || $0 == 9 }.count
    }

    /// A guess at the language of an unlabelled block. Each rule needs
    /// something only that language writes; anything less certain returns nil.
    public static func detect(_ source: String) -> String? {
        let code = Array(source.utf16)
        var lines: [[UInt16]] = []
        var start = 0
        while start <= code.count && lines.count < detectLines {
            let end = lineEnd(code, start)
            var line = Array(code[start..<end])
            while let last = line.last, last == 32 || last == 9 || last == 13 { line.removeLast() }
            lines.append(line)
            start = end + 1
        }
        let trimmed = lines.map { Array($0.dropFirst(leadingBlanks($0))) }.filter { !$0.isEmpty }
        guard let first = trimmed.first else { return nil }
        func starts(_ prefixes: String...) -> Bool {
            trimmed.contains { line in prefixes.contains { hasPrefix(line, $0) } }
        }
        if hasPrefix(first, "#!") { return shebang(first) }
        if hasPrefix(first, "<?php") { return "php" }
        if hasPrefix(first, "<?xml") { return "xml" }
        if asciiLower(first[...]).utf16.starts(with: "<!doctype html".utf16) || hasPrefix(first, "<html") { return "html" }
        if (first[0] == 123 || first[0] == 91) && code.count <= 100_000,
           let value = try? JSONSerialization.jsonObject(with: Data(source.utf8)), value is [Any] || value is [String: Any] {
            return "json"
        }
        if hasPrefix(first, "diff --git") || (starts("@@ -") && starts("--- ", "+++ ")) { return "diff" }
        if starts("#include <", "#include \"") {
            return contains(code, "std::") || contains(code, "iostream") || starts("namespace ", "class ", "template<", "template <") ? "cpp" : "c"
        }
        let firstWordUnits = Array(first.prefix { $0 != 32 && $0 != 9 && $0 != 40 && $0 != 59 })
        let firstWord = String(decoding: firstWordUnits, as: UTF16.self)
        let upperFirst = String(decoding: asciiUpper(firstWordUnits[...]), as: UTF16.self)
        if let companions = sqlStarts[upperFirst] {
            let upper = asciiUpper(code.prefix(4000))
            let words = Set(upper.split { !(($0 >= 65 && $0 <= 90) || $0 == 95) }.map { String(decoding: $0, as: UTF16.self) })
            if companions.contains(where: words.contains) { return "sql" }
        }
        if firstWord == "FROM" && starts("RUN ", "COPY ", "CMD ", "ENTRYPOINT ") { return "dockerfile" }
        if starts("package ") && starts("func ") { return "go" }
        if trimmed.contains(where: swiftImports.contains) || starts("guard let ", "if let ", "@State ", "@Published ") { return "swift" }
        if starts("fn ", "pub fn ", "impl ", "use std::", "let mut ") || contains(code, "println!(") { return "rust" }
        if starts("fun ") { return "kotlin" }
        if starts("public class ", "public static void main") { return "java" }
        if starts("using System") { return "csharp" }
        if starts("if __name__ ==") || trimmed.contains(where: pythonFromImport) { return "python" }
        if starts("def ", "class ", "import ") && colonBlock(lines) { return "python" }
        if starts("def ") && trimmed.contains(Array("end".utf16)) { return "ruby" }
        if starts("const ", "let ", "function ", "export ", "async function ", "import {") || contains(code, "=>") || contains(code, "console.log(") || contains(code, "require(") {
            return starts("interface ", "type ", "export interface ") || contains(code, ": string") || contains(code, ": number") ? "typescript" : "javascript"
        }
        if hasPrefix(first, "$ ") || shellCommands.contains(firstWord) { return "bash" }
        return nil
    }

    /// `from package.module import name`, which only Python writes.
    private static func pythonFromImport(_ line: [UInt16]) -> Bool {
        guard hasPrefix(line, "from ") else { return false }
        var index = 5
        while index < line.count, isLetter(line[index]) || isDigit(line[index]) || line[index] == 95 || line[index] == 46 { index += 1 }
        return index > 5 && starts(line, Array(" import ".utf16), at: index)
    }

    private static func shebang(_ line: [UInt16]) -> String? {
        let rest = line.dropFirst(2).drop { $0 == 32 || $0 == 9 }
        let parts = rest.split(omittingEmptySubsequences: false) { $0 == 32 || $0 == 9 }.filter { !$0.isEmpty }.map { String(decoding: $0, as: UTF16.self) }
        guard let command = parts.first else { return nil }
        var program = command.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if program == "env" { program = parts.dropFirst().first { !$0.hasPrefix("-") } ?? "" }
        if ["bash", "sh", "zsh", "ksh", "dash", "fish"].contains(program) { return "bash" }
        if program.hasPrefix("python") { return "python" }
        if ["node", "deno", "bun"].contains(program) { return "javascript" }
        if ["ruby", "php", "lua"].contains(program) { return program }
        if program == "pwsh" { return "powershell" }
        return nil
    }

    /// A line ending in a colon followed by a more indented line, as Python
    /// blocks are.
    private static func colonBlock(_ lines: [[UInt16]]) -> Bool {
        for index in lines.indices.dropLast() where lines[index].last == 58 {
            guard let next = lines[(index + 1)...].first(where: { leadingBlanks($0) < $0.count }) else { continue }
            if leadingBlanks(next) > leadingBlanks(lines[index]) { return true }
        }
        return false
    }
}
