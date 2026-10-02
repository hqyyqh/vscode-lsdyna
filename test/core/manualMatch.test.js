'use strict';

const assert = require('assert');
const { classifyManualMatch } = require('../../out/core/manualMatch');

describe('manualMatch', () => {
    it('keeps direct index hits exact', () => {
        assert.strictEqual(classifyManualMatch('*MAT_024', '*MAT_024'), 'exact');
    });

    it('recognizes structural and schema-declared section variants', () => {
        assert.strictEqual(
            classifyManualMatch(
                '*AIRBAG_ADIABATIC_GAS_MODEL_ID',
                '*AIRBAG_ADIABATIC_GAS_MODEL'
            ),
            'section'
        );
        assert.strictEqual(
            classifyManualMatch(
                '*CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_ID',
                '*CONTACT_AUTOMATIC_SINGLE_SURFACE'
            ),
            'section'
        );
    });

    it('uses equivalent manual names to prove numeric material options', () => {
        assert.strictEqual(
            classifyManualMatch(
                '*MAT_024_LOG_INTERPOLATION',
                '*MAT_024',
                ['*MAT_PIECEWISE_LINEAR_PLASTICITY']
            ),
            'section'
        );
    });

    it('keeps an unproven material-name truncation approximate', () => {
        assert.strictEqual(
            classifyManualMatch(
                '*MAT_CONCRETE_DAMAGE_PLASTIC_MODEL',
                '*MAT_CONCRETE_DAMAGE'
            ),
            'approximate'
        );
    });

    it('does not treat an empty trailing suffix as a section option', () => {
        assert.strictEqual(
            classifyManualMatch('*MAT_024_', '*MAT_024'),
            'approximate'
        );
    });
});
