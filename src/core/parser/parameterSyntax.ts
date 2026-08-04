export type ParameterValueType = 'R' | 'I' | 'C';
export type ParameterCardFormat = 'fixed' | 'long-fixed' | 'comma' | 'whitespace';
export type ParameterReferenceSyntax = 'ampersand' | 'bare';

export type ParameterDefinitionOptions = {
    local: boolean;
    mutable: boolean;
    noecho: boolean;
};

export type ParameterKeywordClassification = {
    kind: 'definition' | 'duplication' | 'parameter-type' | 'scope-control';
    keyword: string;
    expression: boolean;
    options: ParameterDefinitionOptions;
    longFormat: boolean;
};

export interface ParsedParameterDefinition {
    lineIndex: number;
    startChar: number;
    length: number;
    name: string;
    normalizedName: string;
    parameterType: ParameterValueType;
    value: string;
    valueStartChar: number;
    valueLength: number;
    expression: boolean;
    keyword: string;
    options: ParameterDefinitionOptions;
    format: ParameterCardFormat;
    sequence: number;
    parameterUsageType?: string;
}

export interface ParameterExpressionSegment {
    lineIndex: number;
    text: string;
    startChar: number;
    length: number;
}

export interface ParsedParameterReference {
    name: string;
    lineIndex: number;
    startChar: number;
    length: number;
    nameStartChar: number;
    nameLength: number;
    syntax: ParameterReferenceSyntax;
    negated?: boolean;
}

export type ParsedParameterLine = {
    definitions: ParsedParameterDefinition[];
    expressionSegments: ParameterExpressionSegment[];
    isContinuation: boolean;
};

type TextRange = {
    text: string;
    start: number;
    end: number;
};

type ParsedDescriptor = {
    name: string;
    normalizedName: string;
    parameterType: ParameterValueType;
    nameStart: number;
    nameLength: number;
};

const EMPTY_OPTIONS: ParameterDefinitionOptions = {
    local: false,
    mutable: false,
    noecho: false,
};

const PARAMETER_OPTIONS = new Set(['LOCAL', 'MUTABLE', 'NOECHO']);

/** Appendix U names whose spelling can also satisfy PARAMETER's identifier grammar. */
const RESERVED_PARAMETER_NAMES = new Set(`
    ACCM ACCX ACCY ACCZ AKISPL ARYVAL AX AY AZ BEAM BISTOP BUSH CHEBY CUBSPL
    CURVE CVCV CX CY CZ DIF DIF1 DM DMRB DX DXRB DY DYRB DZ DZRB ELHIST FIELD
    FM FORCOS FORSIN FX FY FZ GFORCE HAVSIN IF IMPACT JOINT JPRIM MOTION NFORCE
    PHI PINVAL PITCH POLY POUVAL PSI PTCV RCFORC ROLL RX RY RZ SENSOR SFORCE SHF
    SPDP STEP STEPL TEMP THETA TM TX TY TZ VARVAL VFORCE VM VR VTORQ VX VY VZ
    WDTM WDTX WDTY WDTZ WM WX WY WZ YAW

    CHAR CSTRING DOUBLE FLOAT GENERIC INT POINTER

    DTOR MODE NULL PI RTOD

    ABORT ARGC ARGV ATOF ATOI CEIL CHARARRAY CLEARERR CROSS DATACOPY DIE EOR EXIT
    FCLOSE FDPRINT FEOF FERROR FGETC FGETS FILE FLOOR FOPEN FPRINTF FPUTS FREAD
    FREE FSEEK FWRITE GETENV INV ISALNUM ISALPHA ISASCII ISCNTRL ISDEFINED ISDIGIT
    ISGRAPH ISLOWER ISPRINT ISPUNCT ISSPACE ISUPPER ISXDIGIT LENGTH LOGOUTPUT
    MALLOC MEMCPY MEMMOVE MEMSET NEW NEWARRAY NOTIFY OUT PRINT PRINTF PRINTSP PUTENV
    REWIND ROT RX RY RZ SEEK_CUR SEEK_END SEEK_SET SETDEBUG SIZEOF SLEEP SPRINT
    SPRINTF STDERR STDIN STDOUT STRCAT STRCMP STRCPY STRDUP STRDUPF STRING STRLEN
    STRNCAT STRNCMP STRNCPY STRRCHR STRTOK TR REMOVE UNLINK WHATIS

    E2BIG EACCES EAGAIN EALREADY EBADF EBADMSG EBUSY ECANCELED ECHILD EDEADLK EDOM
    EDQUOT EEXIST EFAULT EFBIG EIDRM EILSEQ EINTR EINVAL EIO EISCONN EISDIR ELOOP
    EMFILE EMLINK EMSGSIZE EMULTIHOP ENETDOWN ENETRESET ENFILE ENOBUFS ENODATA
    ENODEV ENOENT ENOEXEC ENOLCK ENOLINK ENOMEM ENOMSG ENOSPC ENOSR ENOSTR ENOSYS
    ENOTCONN ENOTDIR ENOTEMPTY ENOTSOCK ENOTSUP ENOTTY ENXIO EOK EOVERFLOW EPERM
    EPIPE EPROTO ERANGE EROFS ESPIPE ESTALE ETIME ETXTBSY EXDEV GETERROR GETERRSTR
    PERROR SETERROR STRERROR SYS_ERR

    CHOMP GSUBST RESEARCH SEARCH SUBST

    ACCESS CLOSE F_OK FILECLEAR FTRUNCATE LSEEK MAX_FD MSG_PEEK O_APPEND O_CREAT
    O_EXCL O_RDONLY O_RDWR O_TRUNC O_WRONLY OPEN R_OK READ READLINE STAT TRUNCATE
    W_OK WRITE X_OK

    CHDIR CHMOD CTIME EXECUTE FGETPID GETCWD GETPID KILL MKDIR SIG_DFL SIG_IGN
    SIGABRT SIGALRM SIGBUS SIGCHLD SIGCONT SIGFPE SIGHUP SIGILL SIGINT SIGIO SIGKILL
    SIGPIPE SIGPWR SIGQUIT SIGSEGV SIGSTOP SIGSYS SIGTRAP SIGTSTP SIGTTIN SIGTTOU
    SIGURG SIGUSR1 SIGUSR2 SIGWINCH RENAME SIGNAL SYSTEM TIME TOUCH WAIT WHICH

    ACCEPT DRAIN FD_SET FDSET FDUNSET FDZERO HOSTENT IPSOCKET ISSET LOCALADDR
    LOCALPORT MONITOR READTEST SELECT TCPSERVER TCPSOCKET TIMEVAL

    XDR_BUF XDR_BYTES XDR_DATA XDR_DATA1 XDR_FLOAT XDR_INT XDRFREE XDRGETINT
    XDRPUTINT XDRSAVE XDRSEND

    FTP FTPCHDIR FTPDEBUG FTPGET FTPLIST FTPMKDIR FTPMODE FTPPWD FTPPUT FTPQUIT
    FTPREPLY FTPRMDIR FTPUNLINK LINKBEGIN LINKCLOSE LINKEND LINKINFO LINKINPUT
    LINKOPEN LINKREAD LINKWRITE RACCESS RCOPYFILE REXECUTE RFSTAT ROPEN
    RREMOVE RRENAME RSTAT RSYSTEM RUNLINK TELNET
`.trim().split(/\s+/));

function normalizeKeywordToken(value: string): { keyword: string; longFormat: boolean } {
    let token = String(value || '').trim().toUpperCase().split(/[\s,$]/)[0];
    if (!token.startsWith('*')) token = `*${token}`;
    const longFormat = token.endsWith('+');
    if (longFormat) token = token.slice(0, -1);
    return { keyword: token, longFormat };
}

export function classifyParameterKeyword(value: string): ParameterKeywordClassification | null {
    const { keyword, longFormat } = normalizeKeywordToken(value);
    if (keyword === '*PARAMETER_DUPLICATION') {
        return {
            kind: 'duplication', keyword, expression: false,
            options: { ...EMPTY_OPTIONS }, longFormat,
        };
    }
    if (keyword === '*PARAMETER_TYPE') {
        return {
            kind: 'parameter-type', keyword, expression: false,
            options: { ...EMPTY_OPTIONS }, longFormat,
        };
    }
    if (keyword === '*PARAMETER_PUSH' || keyword === '*PARAMETER_POP') {
        return {
            kind: 'scope-control', keyword, expression: false,
            options: { ...EMPTY_OPTIONS }, longFormat,
        };
    }

    const parts = keyword.slice(1).split('_');
    if (parts[0] !== 'PARAMETER') return null;
    let optionStart = 1;
    let expression = false;
    if (parts[1] === 'EXPRESSION') {
        expression = true;
        optionStart = 2;
    }
    const optionNames = parts.slice(optionStart);
    if (optionNames.some(option => !PARAMETER_OPTIONS.has(option))) return null;
    if (new Set(optionNames).size !== optionNames.length) return null;

    return {
        kind: 'definition',
        keyword,
        expression,
        options: {
            local: optionNames.includes('LOCAL'),
            mutable: optionNames.includes('MUTABLE'),
            noecho: optionNames.includes('NOECHO'),
        },
        longFormat,
    };
}

export function isReservedParameterName(name: string): boolean {
    const upperName = String(name || '').toUpperCase();
    return RESERVED_PARAMETER_NAMES.has(upperName) ||
        /^VECTOR[1-9][0-9]{0,2}$/.test(upperName) ||
        /^MATRIX[1-9]X[1-9]$/.test(upperName);
}

export function isValidParameterName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]{0,8}$/.test(String(name || '')) &&
        !isReservedParameterName(name);
}

function trimRange(text: string, start: number, end: number): TextRange {
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const normalizedStart = start + leading;
    return {
        text: raw.trim(),
        start: normalizedStart,
        end: Math.max(normalizedStart, end - trailing),
    };
}

function commaFields(line: string): TextRange[] {
    const fields: TextRange[] = [];
    let start = 0;
    for (let index = 0; index <= line.length; index++) {
        if (index !== line.length && line[index] !== ',') continue;
        fields.push(trimRange(line, start, index));
        start = index + 1;
    }
    return fields;
}

function whitespaceTokens(line: string): TextRange[] {
    const tokens: TextRange[] = [];
    const pattern = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
        tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
    return tokens;
}

function parseDescriptorText(
    text: string,
    absoluteStart: number,
    allowedTypes: ReadonlySet<ParameterValueType>,
): ParsedDescriptor | null {
    const match = text.match(/^\s*([RICric])\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (!match) return null;
    const parameterType = match[1].toUpperCase() as ParameterValueType;
    const name = match[2];
    if (!allowedTypes.has(parameterType) || !isValidParameterName(name)) return null;
    const nameOffset = text.indexOf(name, text.indexOf(match[1]) + 1);
    return {
        name,
        normalizedName: name.toUpperCase(),
        parameterType,
        nameStart: absoluteStart + nameOffset,
        nameLength: name.length,
    };
}

function makeDefinition(
    descriptor: ParsedDescriptor,
    value: TextRange,
    lineIndex: number,
    keyword: ParameterKeywordClassification,
    format: ParameterCardFormat,
    sequence: number,
    parameterUsageType?: string,
): ParsedParameterDefinition {
    return {
        lineIndex,
        startChar: descriptor.nameStart,
        length: descriptor.nameLength,
        name: descriptor.name,
        normalizedName: descriptor.normalizedName,
        parameterType: descriptor.parameterType,
        value: value.text,
        valueStartChar: value.start,
        valueLength: value.end - value.start,
        expression: keyword.expression,
        keyword: keyword.keyword,
        options: { ...keyword.options },
        format,
        sequence,
        ...(parameterUsageType ? { parameterUsageType } : {}),
    };
}

function parseFixedDefinitions(
    line: string,
    lineIndex: number,
    keyword: ParameterKeywordClassification,
    longFormat: boolean,
): ParsedParameterDefinition[] {
    const width = longFormat ? 20 : 10;
    const format: ParameterCardFormat = longFormat ? 'long-fixed' : 'fixed';
    const definitions: ParsedParameterDefinition[] = [];
    const groupCount = keyword.kind === 'parameter-type' ? 1 : 4;
    const allowedTypes = keyword.kind === 'parameter-type'
        ? new Set<ParameterValueType>(['I'])
        : new Set<ParameterValueType>(['R', 'I', 'C']);

    if (keyword.expression) {
        const descriptor = parseDescriptorText(line.slice(0, width), 0, allowedTypes);
        const value = trimRange(line, width, line.length);
        return descriptor && value.text
            ? [makeDefinition(descriptor, value, lineIndex, keyword, format, 0)]
            : [];
    }

    for (let group = 0; group < groupCount; group++) {
        const descriptorStart = group * width * 2;
        if (descriptorStart >= line.length) break;
        const descriptor = parseDescriptorText(
            line.slice(descriptorStart, descriptorStart + width),
            descriptorStart,
            allowedTypes,
        );
        const valueStart = descriptorStart + width;
        const value = trimRange(line, valueStart, Math.min(line.length, valueStart + width));
        if (!descriptor || !value.text) {
            if (group === 0) return [];
            continue;
        }
        const usage = keyword.kind === 'parameter-type'
            ? trimRange(line, valueStart + width, Math.min(line.length, valueStart + width * 2)).text
            : undefined;
        definitions.push(makeDefinition(
            descriptor, value, lineIndex, keyword, format, group, usage,
        ));
    }
    return definitions;
}

function parseCommaDefinitions(
    line: string,
    lineIndex: number,
    keyword: ParameterKeywordClassification,
): ParsedParameterDefinition[] {
    const fields = commaFields(line);
    const definitions: ParsedParameterDefinition[] = [];
    const allowedTypes = keyword.kind === 'parameter-type'
        ? new Set<ParameterValueType>(['I'])
        : new Set<ParameterValueType>(['R', 'I', 'C']);

    if (keyword.expression) {
        const descriptor = fields[0] && parseDescriptorText(fields[0].text, fields[0].start, allowedTypes);
        if (!descriptor || fields.length < 2) return [];
        const value = trimRange(line, fields[1].start, line.length);
        return value.text ? [makeDefinition(descriptor, value, lineIndex, keyword, 'comma', 0)] : [];
    }
    if (keyword.kind === 'parameter-type') {
        const descriptor = fields[0] && parseDescriptorText(fields[0].text, fields[0].start, allowedTypes);
        if (!descriptor || !fields[1]?.text) return [];
        return [makeDefinition(
            descriptor, fields[1], lineIndex, keyword, 'comma', 0, fields[2]?.text,
        )];
    }

    for (let index = 0; index + 1 < fields.length && definitions.length < 4; index += 2) {
        const descriptor = parseDescriptorText(fields[index].text, fields[index].start, allowedTypes);
        if (!descriptor || !fields[index + 1].text) continue;
        definitions.push(makeDefinition(
            descriptor, fields[index + 1], lineIndex, keyword, 'comma', index / 2,
        ));
    }
    return definitions;
}

function descriptorFromTokens(
    tokens: TextRange[],
    index: number,
    allowedTypes: ReadonlySet<ParameterValueType>,
): { descriptor: ParsedDescriptor; nextIndex: number } | null {
    const attached = parseDescriptorText(tokens[index]?.text || '', tokens[index]?.start || 0, allowedTypes);
    if (attached) return { descriptor: attached, nextIndex: index + 1 };
    const type = tokens[index]?.text;
    const name = tokens[index + 1];
    if (!type || !name || !/^[RIC]$/i.test(type)) return null;
    const combined = `${type}${name.text}`;
    const descriptor = parseDescriptorText(combined, tokens[index].start, allowedTypes);
    if (!descriptor) return null;
    descriptor.nameStart = name.start;
    return { descriptor, nextIndex: index + 2 };
}

function parseWhitespaceDefinitions(
    line: string,
    lineIndex: number,
    keyword: ParameterKeywordClassification,
): ParsedParameterDefinition[] {
    const tokens = whitespaceTokens(line);
    const definitions: ParsedParameterDefinition[] = [];
    const allowedTypes = keyword.kind === 'parameter-type'
        ? new Set<ParameterValueType>(['I'])
        : new Set<ParameterValueType>(['R', 'I', 'C']);
    let tokenIndex = 0;

    if (keyword.expression) {
        const parsed = descriptorFromTokens(tokens, 0, allowedTypes);
        if (!parsed || !tokens[parsed.nextIndex]) return [];
        const value = trimRange(line, tokens[parsed.nextIndex].start, line.length);
        return [makeDefinition(parsed.descriptor, value, lineIndex, keyword, 'whitespace', 0)];
    }
    if (keyword.kind === 'parameter-type') {
        const parsed = descriptorFromTokens(tokens, 0, allowedTypes);
        const value = parsed && tokens[parsed.nextIndex];
        if (!parsed || !value) return [];
        return [makeDefinition(
            parsed.descriptor,
            value,
            lineIndex,
            keyword,
            'whitespace',
            0,
            tokens[parsed.nextIndex + 1]?.text,
        )];
    }

    while (definitions.length < 4) {
        const parsed = descriptorFromTokens(tokens, tokenIndex, allowedTypes);
        if (!parsed || !tokens[parsed.nextIndex]) break;
        const nextValueIndex = parsed.nextIndex;
        let nextDescriptorIndex = -1;
        for (let candidate = nextValueIndex + 1; candidate < tokens.length; candidate++) {
            if (descriptorFromTokens(tokens, candidate, allowedTypes)) {
                nextDescriptorIndex = candidate;
                break;
            }
        }
        const value = trimRange(
            line,
            tokens[nextValueIndex].start,
            nextDescriptorIndex >= 0 ? tokens[nextDescriptorIndex].start : line.length,
        );
        definitions.push(makeDefinition(
            parsed.descriptor, value, lineIndex, keyword, 'whitespace', definitions.length,
        ));
        if (nextDescriptorIndex < 0) break;
        tokenIndex = nextDescriptorIndex;
    }
    return definitions;
}

export function parseParameterDataLine(
    line: string,
    lineIndex: number,
    keyword: ParameterKeywordClassification,
    globalLongFormat = false,
): ParsedParameterLine {
    const longFormat = keyword.longFormat || globalLongFormat;
    const expressionWidth = longFormat ? 20 : 10;
    if (keyword.expression && line.slice(0, expressionWidth).trim() === '' && line.slice(expressionWidth).trim()) {
        const segment = trimRange(line, expressionWidth, line.length);
        return {
            definitions: [],
            expressionSegments: [{
                lineIndex,
                text: segment.text,
                startChar: segment.start,
                length: segment.end - segment.start,
            }],
            isContinuation: true,
        };
    }

    let definitions: ParsedParameterDefinition[];
    if (line.includes(',')) {
        definitions = parseCommaDefinitions(line, lineIndex, keyword);
    } else {
        definitions = parseFixedDefinitions(line, lineIndex, keyword, longFormat);
        if (definitions.length === 0) {
            definitions = parseWhitespaceDefinitions(line, lineIndex, keyword);
        }
    }
    const expressionSegments = keyword.expression && definitions[0]
        ? [{
            lineIndex,
            text: definitions[0].value,
            startChar: definitions[0].valueStartChar,
            length: definitions[0].valueLength,
        }]
        : [];
    return { definitions, expressionSegments, isContinuation: false };
}

export function scanAmpersandParameterReferences(
    text: string,
    lineIndex: number,
): ParsedParameterReference[] {
    const references: ParsedParameterReference[] = [];
    const pattern = /(-)?&([A-Za-z_][A-Za-z0-9_]{0,8})(?![A-Za-z0-9_])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        references.push({
            name: match[2].toUpperCase(),
            lineIndex,
            startChar: match.index,
            length: match[0].length,
            nameStartChar: match.index + (match[1] ? 2 : 1),
            nameLength: match[2].length,
            syntax: 'ampersand',
            ...(match[1] ? { negated: true } : {}),
        });
    }
    return references;
}

export function scanBareParameterReferences(
    segment: ParameterExpressionSegment,
    definedNames: ReadonlySet<string>,
): ParsedParameterReference[] {
    const references: ParsedParameterReference[] = [];
    const pattern = /\b([A-Za-z_][A-Za-z0-9_]{0,8})\b/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment.text)) !== null) {
        const absoluteStart = segment.startChar + match.index;
        if (absoluteStart > 0 && segment.text[match.index - 1] === '&') continue;
        const name = match[1].toUpperCase();
        if (!definedNames.has(name)) continue;
        references.push({
            name,
            lineIndex: segment.lineIndex,
            startChar: absoluteStart,
            length: match[1].length,
            nameStartChar: absoluteStart,
            nameLength: match[1].length,
            syntax: 'bare',
        });
    }
    return references;
}

export function inlineExpressionSegments(text: string, lineIndex: number): ParameterExpressionSegment[] {
    if (!text.includes(',')) return [];
    const segments: ParameterExpressionSegment[] = [];
    const pattern = /<([^<>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const startChar = match.index + 1;
        segments.push({
            lineIndex,
            text: match[1],
            startChar,
            length: match[1].length,
        });
    }
    return segments;
}
