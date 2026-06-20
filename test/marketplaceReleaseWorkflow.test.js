const assert = require('assert');
const fs = require('fs');
const path = require('path');

function loadCoordinator() {
    return require('../.github/scripts/marketplace-release.cjs');
}

function createContext() {
    return {
        repo: { owner: 'hqyyqh', repo: 'vscode-lsdyna' },
        serverUrl: 'https://github.com'
    };
}

function createStoreFetch({
    visualStudioVersions = [],
    openVsxVersions = [],
    visualStudioResponse = { ok: true, status: 200, statusText: 'OK' },
    openVsxResponse = { ok: true, status: 200, statusText: 'OK' }
} = {}) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url, options });
        if (url.includes('marketplace.visualstudio.com')) {
            return {
                ...visualStudioResponse,
                json: async () => ({
                    results: [{
                        extensions: [{
                            publisher: { publisherName: 'hqyyqh' },
                            extensionName: 'dynasense',
                            versions: visualStudioVersions.map(version => ({ version }))
                        }]
                    }]
                })
            };
        }
        if (url.includes('open-vsx.org')) {
            return {
                ...openVsxResponse,
                json: async () => ({
                    allVersions: Object.fromEntries([
                        ['latest', 'https://open-vsx.org/api/hqyyqh/dynasense/latest'],
                        ...openVsxVersions.map(version => [version, `https://open-vsx.org/api/hqyyqh/dynasense/${version}`])
                    ])
                })
            };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };
    return { calls, fetchImpl };
}

describe('marketplace release workflow coordinator', () => {
    it('extracts only a strict semantic version marker', () => {
        const { extractMarketplaceVersion } = loadCoordinator();

        assert.equal(extractMarketplaceVersion('<!-- marketplace-version:3.0.7 -->'), '3.0.7');
        assert.equal(extractMarketplaceVersion('<!-- marketplace-version:3.0 -->'), null);
        assert.equal(extractMarketplaceVersion('no marker'), null);
    });

    it('uses a release verification label', () => {
        const { RELEASE_LABEL } = loadCoordinator();
        assert.equal(RELEASE_LABEL, 'marketplace-release');
    });

    it('reuses an existing verification issue for the same version', async () => {
        const { ensureMarketplaceReleaseIssue } = loadCoordinator();
        const existing = {
            number: 42,
            title: 'Verify DynaSense 3.0.7 marketplace release',
            body: '<!-- marketplace-version:3.0.7 -->'
        };
        let createCalls = 0;
        const github = {
            rest: {
                issues: {
                    getLabel: async () => ({ data: { name: 'marketplace-release' } }),
                    createLabel: async () => assert.fail('label must not be recreated'),
                    listForRepo: async () => ({ data: [existing] }),
                    create: async () => { createCalls += 1; }
                }
            }
        };

        const result = await ensureMarketplaceReleaseIssue({
            github,
            context: createContext(),
            version: '3.0.7'
        });

        assert.equal(result.number, 42);
        assert.equal(createCalls, 0);
    });

    it('creates a complete two-store verification issue when none exists', async () => {
        const { ensureMarketplaceReleaseIssue } = loadCoordinator();
        let createdLabel;
        let createdIssue;
        const missingLabelError = Object.assign(new Error('missing'), { status: 404 });
        const github = {
            rest: {
                issues: {
                    getLabel: async () => { throw missingLabelError; },
                    createLabel: async args => { createdLabel = args; },
                    listForRepo: async () => ({ data: [] }),
                    create: async args => {
                        createdIssue = args;
                        return { data: { number: 43, ...args } };
                    }
                }
            }
        };

        const result = await ensureMarketplaceReleaseIssue({
            github,
            context: createContext(),
            version: '3.0.7'
        });

        assert.equal(createdLabel.name, 'marketplace-release');
        assert.equal(createdIssue.title, 'Verify DynaSense 3.0.7 marketplace release');
        assert.deepEqual(createdIssue.labels, ['marketplace-release']);
        assert.ok(createdIssue.body.includes('marketplace.visualstudio.com/items?itemName=hqyyqh.dynasense'));
        assert.ok(createdIssue.body.includes('open-vsx.org/extension/hqyyqh/dynasense'));
        assert.ok(createdIssue.body.includes('<!-- marketplace-version:3.0.7 -->'));
        assert.equal(result.number, 43);
    });

    it('reads version sets from both public store APIs', async () => {
        const { fetchVisualStudioMarketplaceVersions, fetchOpenVsxVersions } = loadCoordinator();
        const { calls, fetchImpl } = createStoreFetch({
            visualStudioVersions: ['3.0.7', '3.0.6'],
            openVsxVersions: ['3.0.7', '3.0.6']
        });

        const visualStudio = await fetchVisualStudioMarketplaceVersions(fetchImpl);
        const openVsx = await fetchOpenVsxVersions(fetchImpl);

        assert.deepEqual([...visualStudio], ['3.0.7', '3.0.6']);
        assert.deepEqual([...openVsx], ['3.0.7', '3.0.6']);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls[1].options.method, 'GET');
    });

    it('closes an issue only when both stores expose the target version', async () => {
        const { verifyMarketplaceReleaseIssues } = loadCoordinator();
        const comments = [];
        const updates = [];
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({
                        data: [{ number: 10, body: '<!-- marketplace-version:3.0.7 -->' }]
                    }),
                    createComment: async args => { comments.push(args); },
                    update: async args => { updates.push(args); }
                }
            }
        };
        const { fetchImpl } = createStoreFetch({
            visualStudioVersions: ['3.0.7'],
            openVsxVersions: ['3.0.7']
        });

        const result = await verifyMarketplaceReleaseIssues({ github, context: createContext(), fetchImpl });

        assert.deepEqual(result, {
            checked: 1,
            closed: 1,
            visualStudioMarketplaceVersions: 1,
            openVsxVersions: 1
        });
        assert.equal(comments.length, 1);
        assert.ok(comments[0].body.includes('Visual Studio Marketplace'));
        assert.ok(comments[0].body.includes('Open VSX'));
        assert.deepEqual(updates, [{
            owner: 'hqyyqh',
            repo: 'vscode-lsdyna',
            issue_number: 10,
            state: 'closed',
            state_reason: 'completed'
        }]);
    });

    it('keeps the issue open when only one store exposes the target version', async () => {
        const { verifyMarketplaceReleaseIssues } = loadCoordinator();
        let writes = 0;
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({
                        data: [{ number: 10, body: '<!-- marketplace-version:3.0.7 -->' }]
                    }),
                    createComment: async () => { writes += 1; },
                    update: async () => { writes += 1; }
                }
            }
        };
        const { fetchImpl } = createStoreFetch({
            visualStudioVersions: ['3.0.7'],
            openVsxVersions: ['3.0.6']
        });

        const result = await verifyMarketplaceReleaseIssues({ github, context: createContext(), fetchImpl });

        assert.equal(result.checked, 1);
        assert.equal(result.closed, 0);
        assert.equal(writes, 0);
    });

    it('does not query either store when there are no open verification issues', async () => {
        const { verifyMarketplaceReleaseIssues } = loadCoordinator();
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({ data: [] })
                }
            }
        };

        const result = await verifyMarketplaceReleaseIssues({
            github,
            context: createContext(),
            fetchImpl: async () => assert.fail('fetch must not run')
        });

        assert.deepEqual(result, {
            checked: 0,
            closed: 0,
            visualStudioMarketplaceVersions: 0,
            openVsxVersions: 0
        });
    });

    it('fails without changing issues when a store API is unavailable', async () => {
        const { verifyMarketplaceReleaseIssues } = loadCoordinator();
        let writes = 0;
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({
                        data: [{ number: 10, body: '<!-- marketplace-version:3.0.7 -->' }]
                    }),
                    createComment: async () => { writes += 1; },
                    update: async () => { writes += 1; }
                }
            }
        };
        const { fetchImpl } = createStoreFetch({
            visualStudioVersions: ['3.0.7'],
            openVsxResponse: { ok: false, status: 503, statusText: 'Unavailable' }
        });

        await assert.rejects(
            verifyMarketplaceReleaseIssues({ github, context: createContext(), fetchImpl }),
            /Open VSX API request failed: 503 Unavailable/
        );
        assert.equal(writes, 0);
    });

    it('configures the release workflow for Entra publishing and two-store verification', () => {
        const releaseWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../.github/workflows/release.yml'),
            'utf8'
        );
        const verifyWorkflow = fs.readFileSync(
            path.resolve(__dirname, '../.github/workflows/verify-marketplace.yml'),
            'utf8'
        );

        assert.match(releaseWorkflow, /id-token: write/);
        assert.match(releaseWorkflow, /environment: release/);
        assert.match(releaseWorkflow, /uses: azure\/login@v3/);
        assert.match(releaseWorkflow, /vsce publish --azure-credential/);
        assert.match(releaseWorkflow, /ensureMarketplaceReleaseIssue/);
        assert.doesNotMatch(releaseWorkflow, /Create VS Marketplace upload task/);
        assert.match(verifyWorkflow, /verifyMarketplaceReleaseIssues/);
        assert.equal(
            fs.existsSync(path.resolve(__dirname, '../.github/workflows/entra-bootstrap.yml')),
            false
        );
    });
});
