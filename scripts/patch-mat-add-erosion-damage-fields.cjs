'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const englishPath = path.join(repoRoot, 'keywords', 'field_data.json');
const localizedPath = path.join(repoRoot, 'keywords', 'field_data_zh.json');

const TARGET_KEYWORDS = [
    'MAT_ADD_EROSION',
    'MAT_ADD_EROSION_TITLE',
];

const ENGLISH_FIELDS = [
    {
        n: 'DMGTYP',
        t: 'integer',
        h: [
            'For GISSMO damage type the following applies.',
            '',
            'DMGTYP is interpreted digit-wise as follows:',
            'DMGTYP = [NM] = M + 10 x N',
            '',
            'M.EQ.0: Damage is accumulated, no coupling to flow stress, no failure.',
            'M.EQ.1: Damage is accumulated, element failure occurs for D = 1. Coupling of damage to flow stress depending on parameters, see remarks below.',
            'N.EQ.0: Equivalent plastic strain is the driving quantity for the damage. To be more precise, it is the history variable that LS-PrePost labels as plastic strain. What this history variable actually represents depends on the material model.',
            'N.GT.0: The Nth additional history variable is the driving quantity for damage. These additional history variables are the same ones flagged by the *DATABASE_EXTENT_BINARY keyword NEIPS and NEIPH fields. For example, for solid elements with *MAT_187, setting N = 6 chooses volumetric plastic strain as the driving quantity for the GISSMO damage.',
            '',
            'For IDAM.LT.0 the following applies.',
            'EQ.0: No action is taken.',
            'EQ.1: Damage history is initiated based on values of initial plastic strains and initial strain tensor; this is to be used in multistage analyses.',
        ].join('\n'),
    },
    {
        n: 'LCSDG',
        t: 'integer',
        h: 'Load curve ID or Table ID. Load curve defines equivalent plastic strain to failure vs. triaxiality. Table defines for each Lode parameter value (between -1 and 1) a load curve ID giving the equivalent plastic strain to failure vs. triaxiality for that Lode parameter value.',
    },
    {
        n: 'ECRIT',
        t: 'real',
        h: [
            'Critical plastic strain (material instability), see below.',
            '',
            'LT.0.0: |ECRIT| is either a load curve ID defining critical equivalent plastic strain versus triaxiality or a table ID defining critical equivalent plastic strain as a function of triaxiality and Lode parameter (as in LCSDG).',
            'EQ.0.0: Fixed value DCRIT defining critical damage is read (see below).',
            'GT.0.0: Fixed value for stress-state independent critical equivalent plastic strain.',
        ].join('\n'),
    },
    {
        n: 'DMGEXP',
        t: 'real',
        h: 'Exponent for nonlinear damage accumulation, see remarks.',
    },
    {
        n: 'DCRIT',
        t: 'real',
        h: 'Damage threshold value (critical damage). If a Load curve of critical plastic strain or fixed value is given by ECRIT, input is ignored.',
    },
    {
        n: 'FADEXP',
        t: 'real',
        h: [
            'Exponent for damage-related stress fadeout.',
            '',
            'LT.0.0: |FADEXP| is load curve ID defining element-size dependent fading exponent.',
            'GT.0.0: Constant fading exponent.',
        ].join('\n'),
    },
];

const CHINESE_FIELDS = [
    {
        n: 'DMGTYP',
        h: [
            '对于 GISSMO 损伤类型，适用以下规则。',
            '',
            'DMGTYP 按位解释如下：',
            'DMGTYP = [NM] = M + 10 x N',
            '',
            'M.EQ.0: 累积损伤，不耦合到流动应力，不发生失效。',
            'M.EQ.1: 累积损伤，当 D = 1 时单元失效。损伤到流动应力的耦合取决于相关参数，见下方备注。',
            'N.EQ.0: 等效塑性应变是损伤的驱动量。更准确地说，它是 LS-PrePost 直接标记为“塑性应变”的历史变量。该历史变量实际代表什么取决于材料模型。',
            'N.GT.0: 第 N 个附加历史变量是损伤的驱动量。这些附加历史变量与 *DATABASE_EXTENT_BINARY 关键字的 NEIPS 和 NEIPH 字段标记的变量相同。例如，对于使用 *MAT_187 的实体单元，设置 N = 6 会选择体积塑性应变作为 GISSMO 损伤的驱动量。',
            '',
            '对于 IDAM.LT.0，适用以下规则。',
            'EQ.0: 不执行操作。',
            'EQ.1: 根据初始塑性应变和初始应变张量的值初始化损伤历史；用于多阶段分析。',
        ].join('\n'),
    },
    {
        n: 'LCSDG',
        h: '载荷曲线 ID 或表 ID。载荷曲线定义失效等效塑性应变随三轴度的关系。表针对每个 Lode 参数值（介于 -1 和 1 之间）定义一条载荷曲线 ID，该曲线给出该 Lode 参数值下失效等效塑性应变随三轴度的关系。',
    },
    {
        n: 'ECRIT',
        h: [
            '临界塑性应变（材料不稳定性），见下文。',
            '',
            'LT.0.0: |ECRIT| 是定义临界等效塑性应变随三轴度变化的载荷曲线 ID，或是定义临界等效塑性应变作为三轴度和 Lode 参数函数的表 ID（同 LCSDG）。',
            'EQ.0.0: 读取定义临界损伤的固定值 DCRIT（见下文）。',
            'GT.0.0: 与应力状态无关的临界等效塑性应变固定值。',
        ].join('\n'),
    },
    {
        n: 'DMGEXP',
        h: '非线性损伤累积指数，见备注。',
    },
    {
        n: 'DCRIT',
        h: '损伤阈值（临界损伤）。如果 ECRIT 给出了临界塑性应变的载荷曲线或固定值，则忽略该输入。',
    },
    {
        n: 'FADEXP',
        h: [
            '损伤相关应力渐隐指数。',
            '',
            'LT.0.0: |FADEXP| 是定义单元尺寸相关渐隐指数的载荷曲线 ID。',
            'GT.0.0: 常数渐隐指数。',
        ].join('\n'),
    },
];

function localizedFields() {
    return ENGLISH_FIELDS.map((field, index) => ({
        ...field,
        h: `${field.h}\n${CHINESE_FIELDS[index].h}`,
    }));
}

function fieldDefinitionsForLocale(locale) {
    return locale === 'zh' ? localizedFields() : ENGLISH_FIELDS;
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function findDamageCard(entry, keyword) {
    if (!entry || !Array.isArray(entry.c)) {
        throw new Error(`${keyword} is missing cards`);
    }
    const card = entry.c.find(candidate =>
        Array.isArray(candidate) &&
        candidate.length >= 8 &&
        normalizeFieldName(candidate[0] && candidate[0].n) === 'IDAM' &&
        normalizeFieldName(candidate[7] && candidate[7].n) === 'LCREGD'
    );
    if (!card) {
        throw new Error(`${keyword} damage card IDAM...LCREGD was not found`);
    }
    return card;
}

function patchMatAddErosionDamageFields(schema, locale = 'en') {
    const definitions = fieldDefinitionsForLocale(locale);
    let changedFields = 0;

    for (const keyword of TARGET_KEYWORDS) {
        const card = findDamageCard(schema[keyword], keyword);
        definitions.forEach((definition, offset) => {
            const index = offset + 1;
            const current = card[index];
            const patched = {
                n: definition.n,
                p: current.p,
                w: current.w,
                h: definition.h,
                t: definition.t,
            };
            if (JSON.stringify(current) !== JSON.stringify(patched)) {
                card[index] = patched;
                changedFields++;
            }
        });
    }

    return { changedFields };
}

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

function patchFile(filePath, locale) {
    const data = loadJson(filePath);
    const result = patchMatAddErosionDamageFields(data, locale);
    writeJson(filePath, data);
    return result;
}

function main() {
    const english = patchFile(englishPath, 'en');
    const localized = patchFile(localizedPath, 'zh');

    console.log(`Patched ${path.relative(repoRoot, englishPath)} (${english.changedFields} fields changed).`);
    console.log(`Patched ${path.relative(repoRoot, localizedPath)} (${localized.changedFields} fields changed).`);
}

if (require.main === module) {
    main();
}

module.exports = {
    patchMatAddErosionDamageFields,
    patchFile,
};
