const assert = require('assert');

function loadCoordinator() {
    return require('../.github/scripts/marketplace-release.cjs');
}

function createContext() {
    return {
        repo: { owner: 'hqyyqh', repo: 'vscode-lsdyna' },
        serverUrl: 'https://github.com'
    };
}

describe('marketplace release workflow coordinator', () => {
    it('extracts only a strict semantic version marker', () => {
        const { extractMarketplaceVersion } = loadCoordinator();

        assert.equal(extractMarketplaceVersion('<!-- marketplace-version:3.0.6 -->'), '3.0.6');
        assert.equal(extractMarketplaceVersion('<!-- marketplace-version:3.0 -->'), null);
        assert.equal(extractMarketplaceVersion('no marker'), null);
    });

    it('reuses an existing upload issue for the same version', async () => {
        const { ensureMarketplaceUploadIssue } = loadCoordinator();
        const existing = {
            number: 42,
            title: 'Upload DynaSense 3.0.6 to VS Marketplace',
            body: '<!-- marketplace-version:3.0.6 -->'
        };
        let createCalls = 0;
        const github = {
            rest: {
                issues: {
                    getLabel: async () => ({ data: { name: 'marketplace-upload' } }),
                    createLabel: async () => assert.fail('label must not be recreated'),
                    listForRepo: async () => ({ data: [existing] }),
                    create: async () => { createCalls += 1; }
                }
            }
        };

        const result = await ensureMarketplaceUploadIssue({
            github,
            context: createContext(),
            version: '3.0.6'
        });

        assert.equal(result.number, 42);
        assert.equal(createCalls, 0);
    });

    it('creates the label and a complete upload issue when none exists', async () => {
        const { ensureMarketplaceUploadIssue } = loadCoordinator();
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

        const result = await ensureMarketplaceUploadIssue({
            github,
            context: createContext(),
            version: '3.0.6'
        });

        assert.equal(createdLabel.name, 'marketplace-upload');
        assert.equal(createdIssue.title, 'Upload DynaSense 3.0.6 to VS Marketplace');
        assert.deepEqual(createdIssue.labels, ['marketplace-upload']);
        assert.ok(createdIssue.body.includes('releases/tag/v3.0.6'));
        assert.ok(createdIssue.body.includes('https://marketplace.visualstudio.com/manage'));
        assert.ok(createdIssue.body.includes('<!-- marketplace-version:3.0.6 -->'));
        assert.equal(result.number, 43);
    });

    it('closes only upload issues whose version is publicly available', async () => {
        const { verifyMarketplaceUploadIssues } = loadCoordinator();
        const comments = [];
        const updates = [];
        let fetchCalls = 0;
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({
                        data: [
                            { number: 10, body: '<!-- marketplace-version:3.0.6 -->' },
                            { number: 11, body: '<!-- marketplace-version:3.0.7 -->' }
                        ]
                    }),
                    createComment: async args => { comments.push(args); },
                    update: async args => { updates.push(args); }
                }
            }
        };
        const fetchImpl = async () => {
            fetchCalls += 1;
            return {
                ok: true,
                json: async () => ({
                    results: [{
                        extensions: [{
                            publisher: { publisherName: 'hqyyqh' },
                            extensionName: 'dynasense',
                            versions: [{ version: '3.0.6' }]
                        }]
                    }]
                })
            };
        };

        const result = await verifyMarketplaceUploadIssues({
            github,
            context: createContext(),
            fetchImpl
        });

        assert.equal(fetchCalls, 1);
        assert.deepEqual(result, { checked: 2, closed: 1 });
        assert.equal(comments.length, 1);
        assert.equal(comments[0].issue_number, 10);
        assert.ok(comments[0].body.includes('hqyyqh.dynasense'));
        assert.deepEqual(updates, [{
            owner: 'hqyyqh',
            repo: 'vscode-lsdyna',
            issue_number: 10,
            state: 'closed',
            state_reason: 'completed'
        }]);
    });

    it('skips the Gallery API when there are no open upload issues', async () => {
        const { verifyMarketplaceUploadIssues } = loadCoordinator();
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({ data: [] })
                }
            }
        };

        const result = await verifyMarketplaceUploadIssues({
            github,
            context: createContext(),
            fetchImpl: async () => assert.fail('fetch must not run')
        });

        assert.deepEqual(result, { checked: 0, closed: 0 });
    });

    it('fails without changing issues when the Gallery API is unavailable', async () => {
        const { verifyMarketplaceUploadIssues } = loadCoordinator();
        let writes = 0;
        const github = {
            rest: {
                issues: {
                    listForRepo: async () => ({
                        data: [{ number: 10, body: '<!-- marketplace-version:3.0.6 -->' }]
                    }),
                    createComment: async () => { writes += 1; },
                    update: async () => { writes += 1; }
                }
            }
        };

        await assert.rejects(
            verifyMarketplaceUploadIssues({
                github,
                context: createContext(),
                fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Unavailable' })
            }),
            /Marketplace Gallery API request failed: 503 Unavailable/
        );
        assert.equal(writes, 0);
    });
});
