'use strict';
module.exports = ({ vscode, generateCommentLine }) => {
const families = ['MAT_BARLAT_YLD2000', 'MAT_CONSTRAINED_SPR3', 'MAT_MODIFIED_HONEYCOMB',
    'MAT_OGDEN_RUBBER', 'MAT_FABRIC', 'MAT_ARUP_ADHESIVE', 'MAT_HYSTERETIC_REINFORCEMENT',
    'MAT_GENERAL_NONLINEAR_6DOF_DISCRETE_BEAM'];

function documentFor(lines) {
    return { languageId: 'lsdyna', version: 1, lineCount: lines.length, eol: 1,
        uri: vscode.Uri.file('D:/temp/conditional-manager-test.k'),
        lineAt: index => ({ text: lines[index] }),
        getText: () => lines.join('\n') };
}
const editorFor = document => ({ document, selection: { active: new vscode.Position(0, 0) } });
const indexes = model => model.managerCards.map(card => card.cardIndex).filter(index => index !== 0);
function sample(interval) {
    return [0, 1, -1, 2, -2, interval.min, interval.max, interval.min + 1,
        interval.max - 1, (interval.min + interval.max) / 2].find(value => Number.isFinite(value) &&
        (interval.min === undefined || value > interval.min || value === interval.min && interval.minInclusive !== false) &&
        (interval.max === undefined || value < interval.max || value === interval.max && interval.maxInclusive !== false));
}
function fixture(keyword, native, rule, state, full, headers = true) {
    const values = Object.fromEntries(rule.domains.map((domain, index) =>
        [domain.controllerId, sample(domain.intervals[state.domainIndexes[index]])]));
    const cards = full ? native.cards.map(card => card.cardIndex) : state.cardIndexes;
    const records = cards.flatMap(cardIndex => {
        const card = native.cards.find(card => card.cardIndex === cardIndex);
        const chars = Array(80).fill(' ');
        for (const controller of rule.controllerFields.filter(field => field.cardIndex === cardIndex)) {
            const field = card.fields[controller.fieldIndex];
            const text = String(values[controller.controllerId]);
            [...text].forEach((character, index) => { chars[field.position + field.width - text.length + index] = character; });
        }
        const schema = card.fields.map(field => ({ n: field.name, p: field.position, w: field.width, t: field.type }));
        return [...(headers ? [generateCommentLine(schema, 'dollar-hash-fixed', 'lower')] : []), chars.join('')];
    });
    return documentFor(['*' + keyword, ...(keyword.endsWith('_TITLE') ? ['fixture title'] : []), ...records, '*END']);
}

return { families, documentFor, editorFor, indexes, sample, fixture };
};
