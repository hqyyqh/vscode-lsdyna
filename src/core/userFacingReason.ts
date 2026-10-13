/** Present internal diagnostics without exposing data-source names or implementation codes. */
export function userFacingReason(reason: unknown, locale = 'en'): string {
    const zh = locale === 'zh' || locale === 'zh-cn';
    const raw = String(reason || '');
    if (raw === 'document-readonly') return zh ? '当前文件不可写。' : 'The current file is not writable.';
    if (raw === 'field-geometry-unsupported') return zh
        ? '管理器暂不支持编辑此字段布局。'
        : 'The manager cannot edit this field layout yet.';
    if (/^(input-format-|native-.*write-unverified$|conditional-comma-write-unverified$)/.test(raw)) return zh
        ? '管理器暂不支持写入当前记录格式。'
        : 'The manager cannot write this record format yet.';
    const message = /link-code-target-noncanonical/i.test(raw)
        ? (zh ? '引用目标类型尚未确认，结果可能不完整。' : 'The reference target type is not confirmed. Results may be incomplete.')
        : /link-code-target-unresolved/i.test(raw)
            ? (zh ? '部分引用目标尚未解析，结果可能不完整。' : 'Some reference targets could not be resolved. Results may be incomplete.')
            : (zh ? '部分信息尚未确认，请核对相关文件内容。' : 'Some information could not be confirmed. Check the relevant file contents.');
    const count = raw.match(/\((\d+) occurrences?\)\s*$/)?.[1];
    return count ? `${message} ${zh ? `（${count} 处）` : `(${count} ${count === '1' ? 'occurrence' : 'occurrences'})`}` : message;
}
