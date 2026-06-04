'use strict';

const vscode = require('vscode');

const LOCALES = {
    'zh-cn': {
        openFileFirst: '请先打开一个 LS-DYNA 文件。 (Debug: {0})',
        indexingKeywords: '正在扫描关键字…',
        manualDirNotConfigured: '未设置手册路径。配置后可在悬停时快速阅读 PDF 原文书签页。',
        configureFolder: '⚙️ 设置手册文件夹 (Configure Folder)',
        modifyManualPath: '修改手册路径',
        page: '第 {0} 页',
        openNewTab: '在新标签打开链接',
        openSplit: '分栏打开',
        openFolder: '打开文件所在路径',
        selectFolder: '设置 LS-DYNA 手册目录',
        manualDirSetTo: 'LS-DYNA 手册目录已设置为: {0}',
        failedToSaveGlobalConfig: '无法将手册路径保存到全局配置：{0}',
        sumatraNotFound: '未在所选手册文件夹中找到 SumatraPDF.exe。在 Windows 系统上，请将 SumatraPDF.exe 复制到该目录下以启用精确页码跳转。',
        notFound: '未找到',
        loadingFieldData: '加载 field data 文件...',
        
        // Tree Providers Extra
        missing: '缺失',
        circular: '循环',
        scanFailed: '扫描失败',
        scanningIncludes: '正在扫描引用文件树…',
        openEditor: '打开编辑器',
        openToSide: '并在侧边打开',
        folder: '文件夹',
        path: '路径',
        size: '大小',
        subIncludes: '子级 Include',
        status: '状态',
        circularDependency: '⚠️ *循环依赖*',
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
        linePrefix: ':第 {0} 行',
        lineLabel: '第 {0} 行',
        aggregatedUsages: '聚合引用',
        totalUsages: '总引用次数',
        firstOccurrence: '首次引用位置',
        cardDataPreview: '卡片数据预览',
        usageSingular: '1 次引用',
        usagesPlural: '{0} 次引用',
        goToKeyword: '跳转到关键字',
        fieldCompletionLabel: '{0} (第 {1}-{2} 列)',
        rowTemplateLabel: '✨ 生成整行卡片模板 (Card {0})',
        fieldDetail: '卡片字段 ({0}) - {1}',
        rowTemplateDetail: 'LS-DYNA 字段对齐模板',
        
        // Keyword Validation
        invalidKeywordFormat: '无效的关键字格式：LS-DYNA 关键字只能以单个 \'*\' 开头。',
        keywordLowercase: '关键字 \'*{0}\' 包含小写字母。LS-DYNA 关键字应为大写。',
        unknownKeyword: '未知或无效的关键字：*{0}'
    },
    'en': {
        openFileFirst: 'Please open an LS-DYNA file first. (Debug: {0})',
        indexingKeywords: 'Scanning keywords…',
        manualDirNotConfigured: 'Manuals directory is not configured. Configure it to quickly view PDF manual bookmarks on hover.',
        configureFolder: '⚙️ Configure Manuals Folder',
        modifyManualPath: 'Modify manuals directory',
        page: 'Page {0}',
        openNewTab: 'Open link in new tab',
        openSplit: 'Open link in split editor',
        openFolder: 'Open containing folder',
        selectFolder: 'Configure LS-DYNA Manuals Directory',
        manualDirSetTo: 'LS-DYNA manuals directory set to: {0}',
        failedToSaveGlobalConfig: 'Failed to save manuals directory globally: {0}',
        sumatraNotFound: 'SumatraPDF.exe not found in the selected folder. On Windows, please copy SumatraPDF.exe into this folder for precise page navigation.',
        notFound: 'not found',
        loadingFieldData: 'Loading field data file...',
        
        // Tree Providers Extra
        missing: 'missing',
        circular: 'circular',
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
        filesFound: '{0} file(s) found',
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
        rowTemplateLabel: '✨ Generate Row Card Template (Card {0})',
        fieldDetail: 'Card Field ({0}) - {1}',
        rowTemplateDetail: 'LS-DYNA Column-Aligned Template',
        
        // Keyword Validation
        invalidKeywordFormat: 'Invalid keyword format: LS-DYNA keywords should start with a single \'*\'.',
        keywordLowercase: 'Keyword \'*{0}\' contains lowercase letters. LS-DYNA keywords should be uppercase.',
        unknownKeyword: 'Unknown or invalid keyword: *{0}'
    }
};

let currentLanguage = 'zh-cn';

function updateLanguage() {
    if (typeof vscode !== 'undefined' && vscode.workspace) {
        const config = vscode.workspace.getConfiguration('lsdyna');
        currentLanguage = config && typeof config.get === 'function'
            ? config.get('language') || 'zh-cn'
            : 'zh-cn';
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
