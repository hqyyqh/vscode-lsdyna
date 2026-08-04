'use strict';

function createParameterRuntimeState() {
    return {
        globals: new Map(),
        localFrames: [],
        duplicationSeen: false,
        duplicationFlag: 1,
        sawParameterDefinition: false,
        uncertaintyReasons: new Set(),
        globalChanges: [],
    };
}

function enterParameterFile(state, occurrenceId, filePath) {
    state.localFrames.push({
        occurrenceId,
        filePath,
        bindings: new Map(),
    });
}

function leaveParameterFile(state) {
    state.localFrames.pop();
}

function findVisibleLocal(state, name) {
    for (let index = state.localFrames.length - 1; index >= 0; index--) {
        const binding = state.localFrames[index].bindings.get(name);
        if (binding) return binding;
    }
    return null;
}

function getVisibleParameterBinding(state, name) {
    const normalizedName = String(name || '').toUpperCase();
    return findVisibleLocal(state, normalizedName) ||
        state.globals.get(normalizedName) ||
        null;
}

function acceptsDuplicate(state, existing) {
    if (existing && existing.mutableAllowed) return true;
    return state.duplicationFlag === 2 || state.duplicationFlag === 4;
}

function createBinding(event, existing = null) {
    return {
        name: event.name,
        rawName: event.rawName,
        parameterType: event.parameterType,
        rawValue: event.rawValue,
        value: event.value,
        valueState: event.valueState,
        reason: event.reason,
        local: event.local,
        mutableAllowed: existing
            ? existing.mutableAllowed
            : event.mutable === true && event.parameterType !== 'C',
        noecho: event.noecho === true,
        parameterUsageType: event.parameterUsageType || null,
        definitionLine: event.lineIndex,
        keyword: event.keyword,
    };
}

function applyDefinition(state, event) {
    state.sawParameterDefinition = true;
    if (event.local) {
        const frame = state.localFrames[state.localFrames.length - 1];
        if (!frame) {
            state.uncertaintyReasons.add('parameter-environment-unavailable');
            return;
        }
        const existingLocal = findVisibleLocal(state, event.name);
        if (existingLocal && !acceptsDuplicate(state, existingLocal)) {
            return;
        }
        frame.bindings.set(event.name, createBinding(event, existingLocal));
        return;
    }

    const existingGlobal = state.globals.get(event.name) || null;
    if (existingGlobal && !acceptsDuplicate(state, existingGlobal)) {
        return;
    }
    state.globals.set(event.name, createBinding(event, existingGlobal));
    state.globalChanges.push(event.name);
}

function applyParameterEvent(state, event) {
    if (!event) return;
    if (event.type === 'scope-control') {
        state.uncertaintyReasons.add('parameter-scope-control-unsupported');
        return;
    }
    if (event.type === 'parameter-type') {
        return;
    }
    if (event.type === 'duplication') {
        if (state.duplicationSeen) return;
        state.duplicationSeen = true;
        if (state.sawParameterDefinition) {
            state.uncertaintyReasons.add('parameter-duplication-order-unsupported');
            return;
        }
        if (Number.isInteger(event.dflag) && event.dflag >= 1 && event.dflag <= 5) {
            state.duplicationFlag = event.dflag;
        } else {
            state.uncertaintyReasons.add('parameter-duplication-value-unresolved');
        }
        return;
    }
    if (event.type === 'definition') {
        applyDefinition(state, event);
    }
}

function snapshotVisibleParameterBindings(state) {
    const bindings = new Map(state.globals);
    for (const frame of state.localFrames) {
        for (const [name, binding] of frame.bindings) {
            bindings.set(name, binding);
        }
    }
    return bindings;
}

function resolveIntegerParameter(bindings, name, negated = false) {
    const binding = bindings && bindings.get(String(name || '').toUpperCase());
    if (!binding || binding.valueState !== 'integer' || !Number.isSafeInteger(binding.value)) {
        return {
            resolved: false,
            binding: binding || null,
            reason: binding && binding.reason || 'parameter-unresolved',
        };
    }
    const value = negated ? -binding.value : binding.value;
    if (!Number.isSafeInteger(value)) {
        return {
            resolved: false,
            binding,
            reason: 'parameter-value-unsafe',
        };
    }
    return {
        resolved: true,
        binding,
        value,
    };
}

module.exports = {
    createParameterRuntimeState,
    enterParameterFile,
    leaveParameterFile,
    applyParameterEvent,
    snapshotVisibleParameterBindings,
    getVisibleParameterBinding,
    resolveIntegerParameter,
};

export {};
