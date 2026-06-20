const MARKETPLACE_LABEL = 'marketplace-upload';
const EXTENSION_ID = 'hqyyqh.dynasense';
const VERSION_MARKER = /<!-- marketplace-version:(\d+\.\d+\.\d+) -->/;
const GALLERY_API_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';

function extractMarketplaceVersion(body = '') {
    return VERSION_MARKER.exec(body)?.[1] ?? null;
}

function uploadIssueTitle(version) {
    return `Upload DynaSense ${version} to VS Marketplace`;
}

function uploadIssueBody({ context, version }) {
    const serverUrl = context.serverUrl || process.env.GITHUB_SERVER_URL || 'https://github.com';
    const repositoryUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}`;

    return [
        `DynaSense ${version} has been packaged and published to Open VSX.`,
        '',
        'Upload the same VSIX to Visual Studio Marketplace:',
        '',
        `- [ ] Download \`dynasense-${version}.vsix\` from [GitHub Release v${version}](${repositoryUrl}/releases/tag/v${version})`,
        '- [ ] Upload it from the [Visual Studio Marketplace publisher page](https://marketplace.visualstudio.com/manage)',
        `- [ ] Confirm [${EXTENSION_ID}](https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}) shows version \`${version}\``,
        '',
        'This issue is closed automatically after the public Marketplace API reports the target version.',
        '',
        `<!-- marketplace-version:${version} -->`
    ].join('\n');
}

async function ensureMarketplaceLabel({ github, context }) {
    const args = { ...context.repo, name: MARKETPLACE_LABEL };

    try {
        await github.rest.issues.getLabel(args);
    } catch (error) {
        if (error?.status !== 404) {
            throw error;
        }
        await github.rest.issues.createLabel({
            ...context.repo,
            name: MARKETPLACE_LABEL,
            color: '7057ff',
            description: 'Manual Visual Studio Marketplace upload required'
        });
    }
}

async function ensureMarketplaceUploadIssue({ github, context, version }) {
    await ensureMarketplaceLabel({ github, context });

    const title = uploadIssueTitle(version);
    const { data: issues } = await github.rest.issues.listForRepo({
        ...context.repo,
        state: 'all',
        labels: MARKETPLACE_LABEL,
        per_page: 100
    });
    const existing = issues.find(issue =>
        !issue.pull_request &&
        (issue.title === title || extractMarketplaceVersion(issue.body) === version)
    );

    if (existing) {
        return existing;
    }

    const { data } = await github.rest.issues.create({
        ...context.repo,
        title,
        body: uploadIssueBody({ context, version }),
        labels: [MARKETPLACE_LABEL]
    });
    return data;
}

async function fetchMarketplaceVersions(fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(GALLERY_API_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json;api-version=7.2-preview.1',
            'Content-Type': 'application/json',
            'User-Agent': 'vscode-lsdyna-release-workflow'
        },
        body: JSON.stringify({
            filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }],
            flags: 914
        })
    });

    if (!response.ok) {
        throw new Error(`Marketplace Gallery API request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const extensions = payload.results?.flatMap(result => result.extensions || []) || [];
    const extension = extensions.find(candidate =>
        candidate.publisher?.publisherName === 'hqyyqh' &&
        candidate.extensionName === 'dynasense'
    );

    return new Set((extension?.versions || []).map(version => version.version));
}

async function verifyMarketplaceUploadIssues({ github, context, fetchImpl = globalThis.fetch }) {
    const { data: issues } = await github.rest.issues.listForRepo({
        ...context.repo,
        state: 'open',
        labels: MARKETPLACE_LABEL,
        per_page: 100
    });
    const uploadIssues = issues.filter(issue => !issue.pull_request && extractMarketplaceVersion(issue.body));

    if (uploadIssues.length === 0) {
        return { checked: 0, closed: 0 };
    }

    const publishedVersions = await fetchMarketplaceVersions(fetchImpl);
    let closed = 0;

    for (const issue of uploadIssues) {
        const version = extractMarketplaceVersion(issue.body);
        if (!publishedVersions.has(version)) {
            continue;
        }

        await github.rest.issues.createComment({
            ...context.repo,
            issue_number: issue.number,
            body: `Verified ${EXTENSION_ID}@${version} on Visual Studio Marketplace: https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`
        });
        await github.rest.issues.update({
            ...context.repo,
            issue_number: issue.number,
            state: 'closed',
            state_reason: 'completed'
        });
        closed += 1;
    }

    return { checked: uploadIssues.length, closed };
}

module.exports = {
    EXTENSION_ID,
    MARKETPLACE_LABEL,
    extractMarketplaceVersion,
    ensureMarketplaceUploadIssue,
    fetchMarketplaceVersions,
    verifyMarketplaceUploadIssues
};
