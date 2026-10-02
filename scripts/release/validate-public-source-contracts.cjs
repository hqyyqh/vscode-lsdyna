'use strict';
const { verifyPublicData } = require('./build-public-runtime-data.cjs');
const { validateProjectContracts } = require("../maintenance/validate-project-contracts.cjs");
try {
    require('./update-source-manifest.cjs').updateSourceManifest(process.cwd());
    verifyPublicData(process.cwd());
    require('./validate-public-source-boundary.cjs').validatePublicSourceBoundary(process.cwd());
    const errors = validateProjectContracts(process.cwd(), { publicSource: true });
    if (errors.length) throw Error(errors.join('\n'));
    console.log('Public data integrity and product contracts passed.');
} catch (error) { console.error(error); process.exitCode = 1; }
