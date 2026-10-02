const assert = require('assert');
const {
    createParameterRuntimeState,
    enterParameterFile,
    leaveParameterFile,
    applyParameterEvent,
    snapshotVisibleParameterBindings,
} = require('../../../out/core/references/parameterEnvironment');

function definition(name, value, options = {}) {
    return {
        type: 'definition',
        keyword: options.local ? '*PARAMETER_LOCAL' : '*PARAMETER',
        lineIndex: options.lineIndex || 0,
        sequence: 0,
        name,
        rawName: name,
        parameterType: options.parameterType || 'I',
        rawValue: String(value),
        value,
        valueState: 'integer',
        reason: null,
        local: options.local === true,
        mutable: options.mutable === true,
        noecho: options.noecho === true,
        parameterUsageType: options.parameterUsageType,
        expression: false,
    };
}

describe('parameterEnvironment', () => {
    it('inherits local values into children and restores the parent binding on return', () => {
        const state = createParameterRuntimeState();
        enterParameterFile(state, 'root', 'main.k');
        applyParameterEvent(state, definition('CID', 10));

        enterParameterFile(state, 'child', 'child.k');
        applyParameterEvent(state, definition('CID', 20, { local: true }));
        assert.equal(snapshotVisibleParameterBindings(state).get('CID').value, 20);

        enterParameterFile(state, 'grandchild', 'grandchild.k');
        assert.equal(snapshotVisibleParameterBindings(state).get('CID').value, 20);
        leaveParameterFile(state);

        leaveParameterFile(state);
        assert.equal(snapshotVisibleParameterBindings(state).get('CID').value, 10);
        leaveParameterFile(state);
    });

    it('keeps non-local child redefinitions after returning to the parent', () => {
        const state = createParameterRuntimeState();
        enterParameterFile(state, 'root', 'main.k');
        applyParameterEvent(state, {
            type: 'duplication',
            lineIndex: 0,
            dflag: 4,
        });
        applyParameterEvent(state, definition('CID', 10, { lineIndex: 1 }));
        enterParameterFile(state, 'child', 'child.k');
        applyParameterEvent(state, definition('CID', 30, { lineIndex: 2 }));
        leaveParameterFile(state);

        assert.equal(snapshotVisibleParameterBindings(state).get('CID').value, 30);
    });

    it('applies DFLAG ignore/accept behavior and first-definition MUTABLE', () => {
        const ignored = createParameterRuntimeState();
        enterParameterFile(ignored, 'root', 'main.k');
        applyParameterEvent(ignored, definition('CID', 1));
        applyParameterEvent(ignored, definition('CID', 2));
        assert.equal(snapshotVisibleParameterBindings(ignored).get('CID').value, 1);

        const mutable = createParameterRuntimeState();
        enterParameterFile(mutable, 'root', 'main.k');
        applyParameterEvent(mutable, definition('CID', 1, { mutable: true }));
        applyParameterEvent(mutable, definition('CID', 2));
        assert.equal(snapshotVisibleParameterBindings(mutable).get('CID').value, 2);
    });

    it('does not globally degrade an unrelated integer because PARAMETER_TYPE is present', () => {
        const state = createParameterRuntimeState();
        enterParameterFile(state, 'root', 'main.k');
        applyParameterEvent(state, definition('CID', 1001));
        applyParameterEvent(state, {
            type: 'parameter-type',
            keyword: '*PARAMETER_TYPE',
            lineIndex: 2,
        });

        assert.equal(snapshotVisibleParameterBindings(state).get('CID').value, 1001);
        assert.deepEqual([...state.uncertaintyReasons], []);
    });

    it('retains PARAMETER_TYPE metadata on an integer binding', () => {
        const state = createParameterRuntimeState();
        enterParameterFile(state, 'root', 'main.k');
        applyParameterEvent(state, definition('WHLPID', 100, {
            parameterUsageType: 'PID',
            noecho: true,
        }));

        const binding = snapshotVisibleParameterBindings(state).get('WHLPID');
        assert.equal(binding.value, 100);
        assert.equal(binding.parameterUsageType, 'PID');
        assert.equal(binding.noecho, true);
    });

    it('ignores MUTABLE for character parameters', () => {
        const state = createParameterRuntimeState();
        enterParameterFile(state, 'root', 'main.k');
        applyParameterEvent(state, definition('LABEL', null, {
            parameterType: 'C',
            mutable: true,
        }));
        applyParameterEvent(state, definition('LABEL', 2));

        assert.equal(snapshotVisibleParameterBindings(state).get('LABEL').parameterType, 'C');
    });
});
