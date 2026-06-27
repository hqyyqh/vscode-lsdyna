'use strict';

const vscode = require('vscode');

const LOCALES = {
    'zh-cn': {
        openFileFirst: '请先打开一个 LS-DYNA 文件。（诊断信息：{0}）',
        indexingKeywords: '正在扫描关键字…',
        manualDirNotConfigured: '尚未设置手册目录。设置后，悬停在关键字上即可快速查看 PDF 手册书签页。',
        configureFolder: '⚙️ 设置手册目录',
        howToConfigureManual: '📖 查看 PDF 手册配置说明',
        modifyManualPath: '修改手册目录',
        hasManualPackReady: '是否已经准备好 LS-DYNA 手册和 SumatraPDF 整合包或文件夹？',
        btnYesSelectFolder: '已准备好，选择目录',
        btnDownloadPack: '下载免配置整合包',
        btnCancel: '取消',
        page: '第 {0} 页',
        openNewTab: '在新标签页中打开',
        openSplit: '在侧边打开',
        openFolder: '打开所在文件夹',
        selectFolder: '设置 LS-DYNA 手册目录',
        manualDirSetTo: 'LS-DYNA 手册目录已设置为：{0}',
        failedToSaveGlobalConfig: '无法保存全局手册目录设置：{0}',
        sumatraNotFound: '未在所选手册目录中找到 SumatraPDF.exe。在 Windows 系统上，请将 SumatraPDF.exe 复制到该目录，以启用精确页码跳转。',
        notFound: '未找到',
        loadingFieldData: '正在加载字段数据...',
        
        // Tree Providers Extra
        missing: '缺失',
        circular: '循环引用',
        scanFailed: '扫描失败',
        scanningIncludes: '正在扫描引用文件树…',
        openEditor: '打开编辑器',
        openToSide: '在侧边打开',
        folder: '文件夹',
        path: '路径',
        size: '大小',
        subIncludes: '子级引用',
        status: '状态',
        circularDependency: '⚠️ *循环引用*',
        scanFailedStatus: '❌ *扫描失败*',
        error: '错误',
        indexingKeywordsProgress: '正在索引关键字…',
        filesFound: '已找到 {0} 个文件',
        includeTreeTitle: '引用文件树',
        keywordIndexTitle: '关键字索引',
        openFile: '打开文件',
        revealInExplorer: '在资源管理器中显示',
        includeFile: '引用文件',
        keywordLabel: '关键字',
        keywordOccurrence: '关键字引用位置',
        file: '文件',
        line: '行',
        linePrefix: '：第 {0} 行',
        lineLabel: '第 {0} 行',
        aggregatedUsages: '汇总引用',
        totalUsages: '引用总数',
        firstOccurrence: '首次出现位置',
        cardDataPreview: '卡片数据预览',
        usageSingular: '1 次引用',
        usagesPlural: '{0} 次引用',
        goToKeyword: '跳转到关键字',
        fieldCompletionLabel: '{0}（第 {1}-{2} 列）',
        rowTemplateLabel: '✨ 生成第 {0} 张卡片的整行模板',
        fieldDetail: '卡片字段（{0}）- {1}',
        rowTemplateDetail: 'LS-DYNA 字段对齐模板',
        chooseKeywordOptions: '选择关键字选项',
        keywordOptionsCodeLens: '$(gear) 选项',
        keywordOptionsCodeLensWithSummary: '$(gear) 选项：{0}',
        formatKeywordCodeLens: '$(wand) 格式化',
        selectKeywordCodeLens: '$(symbol-keyword) 选中',
        noKeywordAtCursor: '当前光标位置没有 LS-DYNA 关键字。',
        noKeywordOptionsAvailable: '此关键字没有可用的 LS-DYNA 关键字选项。',
        chooseKeywordTitleOptions: '选择关键字标题选项',
        chooseConsecutiveOptionalCards: '选择连续可选卡片',
        keywordOptionNone: '无',
        removeNonEmptyOptionLinesWarning: '更改 LS-DYNA 关键字选项会删除非空的选项卡片行。',
        removeLines: '删除行',
        documentationAndCardColumns: '📘 字段手册说明与卡片列',
        valuesAndChildIdsTable: '📊 数值与子项 ID 表（{0} 行）',
        scannedFilesProgress: '已扫描 {0} 个文件...',
        cardColumns: '卡片列',
        referenceLabel: '{0} 引用',
        rawValue: '原始值：`{0}`。',
        parameterReferenceSingular: '1 处引用',
        parameterReferencesPlural: '{0} 处引用',
        negativeSwitchStripped: '$(info) 已去除负号开关后进行查找。',
        noMatchingDefinition: '$(warning) 未找到 ID `{0}` 对应的曲线/表格定义。',
        runScanIncludeTreeForDefinitions: '运行 **扫描引用文件树** 以索引跨文件曲线/表格定义。',
        matchingDefinitionsFound: '$(warning) 找到 {0} 个匹配定义。请先检查是否存在重复或歧义，再参考预览结果。',
        moreDefinitionsOmitted: '悬停提示中已省略 {0} 个定义。',
        openDefinition: '打开定义',
        openChildDefinition: '打开子级{0}',
        curvePreviewAlt: '曲线预览',
        table3dPreviewAlt: '3D 表格预览',
        valueColumn: '值',
        curveIdColumn: '曲线 ID',
        tableIdColumn: '表格 ID',
        curveDefinitionKind: '曲线',
        tableDefinitionKind: '表格',
        definitionIdLabel: '（ID：{0}）',
        moreRows: '另有 {0} 行',
        definitionLocation: '**{0}** 位于 `{1}`',
        lineExceeds80Characters: '当前行超过 80 个字符（{0}）；LS-DYNA 可能会截断。',
        cannotRenameSymbol: '无法重命名此符号。',
        notOnAnyKeyword: '当前位置不在任何关键字块内。',
        keywordHasNoFilenameCard: '此关键字没有文件名卡片。',
        keywordNotSupported: '此关键字不支持该操作。',
        noFileToJumpTo: '当前光标处没有可跳转的引用文件。',
        fileNotFound: '{0} 未找到。',
        noMoreKeywordsFound: '未找到后续关键字。',
        noPreviousKeywordsFound: '未找到前一个关键字。',
        failedToOpenFile: '打开文件失败：{0}',
        failedToSplitOpenFile: '在侧边打开文件失败：{0}',
        failedToRevealFolder: '显示文件夹失败：{0}',
        fieldCommentCompletionDetail: '插入 LS-DYNA 字段注释行',
        fieldCommentCompletionTitle: '插入字段注释行',
        fieldCommentCompletionInsertHint: '按 Tab 插入：',
        rowTemplateDocumentation: '插入一整行预对齐的数据卡片模板。',
        includedFileNotFound: '未找到引用文件“{0}”。',
        circularIncludeDependency: '检测到循环引用依赖：{0}',
        
        // Keyword Validation
        invalidKeywordFormat: '无效的关键字格式：LS-DYNA 关键字只能以单个 \'*\' 开头。',
        keywordLowercase: '关键字 \'*{0}\' 包含小写字母。LS-DYNA 关键字应为大写。',
        unknownKeyword: '未知或无效的关键字：*{0}',
        includePathTooLong: '引用路径长度为 {0} 个字符，超过 LS-DYNA 三行上限 {1}；未自动修改。'
    },
    'en': {
        openFileFirst: 'Please open an LS-DYNA file first. (Details: {0})',
        indexingKeywords: 'Scanning keywords…',
        manualDirNotConfigured: 'No manuals directory is configured. Set one to open matching PDF manual bookmarks from hover.',
        configureFolder: '⚙️ Set Manuals Directory',
        howToConfigureManual: '📖 View PDF manual setup guide',
        modifyManualPath: 'Change manuals directory',
        hasManualPackReady: 'Do you already have the LS-DYNA manuals and SumatraPDF pack or folder ready?',
        btnYesSelectFolder: 'Ready, choose directory',
        btnDownloadPack: 'Download ready-to-use pack',
        btnCancel: 'Cancel',
        page: 'Page {0}',
        openNewTab: 'Open in new tab',
        openSplit: 'Open to side',
        openFolder: 'Open containing folder',
        selectFolder: 'Select LS-DYNA Manuals Directory',
        manualDirSetTo: 'LS-DYNA manuals directory set to: {0}',
        failedToSaveGlobalConfig: 'Could not save the manuals directory to global settings: {0}',
        sumatraNotFound: 'SumatraPDF.exe not found in the selected folder. On Windows, please copy SumatraPDF.exe into this folder for precise page navigation.',
        notFound: 'not found',
        loadingFieldData: 'Loading keyword field definitions...',
        
        // Tree Providers Extra
        missing: 'missing',
        circular: 'circular reference',
        scanFailed: 'scan failed',
        scanningIncludes: 'Scanning includes…',
        openEditor: 'Open Editor',
        openToSide: 'Open to Side',
        folder: 'Folder',
        path: 'Path',
        size: 'Size',
        subIncludes: 'Sub-includes',
        status: 'Status',
        circularDependency: '⚠️ *Circular dependency*',
        scanFailedStatus: '❌ *Scan failed*',
        error: 'Error',
        indexingKeywordsProgress: 'Indexing keywords…',
        filesFound: '{0} files found',
        includeTreeTitle: 'Include Tree',
        keywordIndexTitle: 'Keyword Index',
        openFile: 'Open File',
        revealInExplorer: 'Reveal in Explorer',
        includeFile: 'Include File',
        keywordLabel: 'Keyword',
        keywordOccurrence: 'Keyword Occurrence',
        file: 'File',
        line: 'Line',
        linePrefix: ':line {0}',
        lineLabel: 'Line {0}',
        aggregatedUsages: 'Aggregated Usages',
        totalUsages: 'Total Usages',
        firstOccurrence: 'First Occurrence',
        cardDataPreview: 'Card Data Preview',
        usageSingular: '1 usage',
        usagesPlural: '{0} usages',
        goToKeyword: 'Go to Keyword',
        fieldCompletionLabel: '{0} (Col {1}-{2})',
        rowTemplateLabel: '✨ Generate full card row template (card {0})',
        fieldDetail: 'Card field ({0}) - {1}',
        rowTemplateDetail: 'LS-DYNA aligned card template',
        chooseKeywordOptions: 'Choose keyword options',
        keywordOptionsCodeLens: '$(gear) Options',
        keywordOptionsCodeLensWithSummary: '$(gear) Options: {0}',
        formatKeywordCodeLens: '$(wand) Format',
        selectKeywordCodeLens: '$(symbol-keyword) Select',
        noKeywordAtCursor: 'No LS-DYNA keyword found at the current cursor.',
        noKeywordOptionsAvailable: 'No LS-DYNA keyword options are available for this keyword.',
        chooseKeywordTitleOptions: 'Choose keyword title options',
        chooseConsecutiveOptionalCards: 'Choose consecutive optional card rows',
        keywordOptionNone: 'None',
        removeNonEmptyOptionLinesWarning: 'Changing LS-DYNA keyword options will remove non-empty optional card rows.',
        removeLines: 'Remove lines',
        documentationAndCardColumns: '📘 Field Documentation & Card Columns',
        valuesAndChildIdsTable: '📊 Values and Child IDs Table ({0} rows)',
        scannedFilesProgress: 'Scanned {0} files...',
        cardColumns: 'Card Columns',
        referenceLabel: '{0} reference',
        rawValue: 'Raw value: `{0}`.',
        parameterReferenceSingular: '1 reference',
        parameterReferencesPlural: '{0} references',
        negativeSwitchStripped: '$(info) Negative switch stripped for lookup.',
        noMatchingDefinition: '$(warning) No matching curve/table definition found for ID `{0}`.',
        runScanIncludeTreeForDefinitions: 'Run **Scan Include Tree** to index cross-file curve/table definitions.',
        matchingDefinitionsFound: '$(warning) {0} matching definitions found. Review duplicates or ambiguity before trusting the preview.',
        moreDefinitionsOmitted: '{0} additional definitions omitted from this hover.',
        openDefinition: 'Open definition',
        openChildDefinition: 'Open child {0}',
        curvePreviewAlt: 'curve preview',
        table3dPreviewAlt: '3D table preview',
        valueColumn: 'value',
        curveIdColumn: 'curve ID',
        tableIdColumn: 'table ID',
        curveDefinitionKind: 'curve',
        tableDefinitionKind: 'table',
        definitionIdLabel: ' (ID: {0})',
        moreRows: '{0} more rows',
        definitionLocation: '**{0}** in `{1}`',
        lineExceeds80Characters: 'Line exceeds 80 characters ({0}); LS-DYNA may truncate it.',
        cannotRenameSymbol: 'Cannot rename this symbol.',
        notOnAnyKeyword: 'The cursor is not inside a keyword block.',
        keywordHasNoFilenameCard: 'This keyword does not have a filename card.',
        keywordNotSupported: 'This keyword is not supported.',
        noFileToJumpTo: 'No include file is available at the current cursor.',
        fileNotFound: '{0} not found.',
        noMoreKeywordsFound: 'No next keyword found.',
        noPreviousKeywordsFound: 'No previous keyword found.',
        failedToOpenFile: 'Failed to open file: {0}',
        failedToSplitOpenFile: 'Failed to split open file: {0}',
        failedToRevealFolder: 'Failed to reveal folder: {0}',
        fieldCommentCompletionDetail: 'Insert LS-DYNA field comment line',
        fieldCommentCompletionTitle: 'Insert field comment line',
        fieldCommentCompletionInsertHint: 'Press Tab to insert:',
        rowTemplateDocumentation: 'Insert a pre-aligned full data card row.',
        includedFileNotFound: 'Included file "{0}" not found.',
        circularIncludeDependency: 'Circular include dependency detected: {0}',
        
        // Keyword Validation
        invalidKeywordFormat: 'Invalid keyword format: LS-DYNA keywords should start with a single \'*\'.',
        keywordLowercase: 'Keyword \'*{0}\' contains lowercase letters. LS-DYNA keywords should be uppercase.',
        unknownKeyword: 'Unknown or invalid keyword: *{0}',
        includePathTooLong: 'Include path is {0} characters, exceeding the LS-DYNA three-line limit of {1}; no automatic edit was applied.'
    }
};

let currentLanguage = 'zh-cn';

function resolveAutoLanguage() {
    const vscodeLanguage = typeof vscode !== 'undefined' && vscode.env && vscode.env.language
        ? String(vscode.env.language).toLowerCase()
        : '';
    return vscodeLanguage.startsWith('zh') ? 'zh-cn' : 'en';
}

function updateLanguage() {
    if (typeof vscode !== 'undefined' && vscode.workspace) {
        const config = vscode.workspace.getConfiguration('lsdyna');
        const configuredLanguage = config && typeof config.get === 'function'
            ? config.get('language') || 'auto'
            : 'auto';
        currentLanguage = configuredLanguage === 'auto'
            ? resolveAutoLanguage()
            : configuredLanguage;
    }
}

// 首次加载初始化
updateLanguage();

function get(key, ...args) {
    const lang = LOCALES[currentLanguage] || LOCALES['zh-cn'];
    let text = lang[key] || LOCALES['zh-cn'][key] || key;
    if (args.length > 0) {
        args.forEach((val, idx) => {
            text = text.replace(`{${idx}}`, val);
        });
    }
    return text;
}

module.exports = {
    updateLanguage,
    get,
    getLanguage: () => currentLanguage
};

export {};
