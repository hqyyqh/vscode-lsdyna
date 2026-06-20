const RELEASE_LABEL = 'marketplace-release';
const EXTENSION_ID = 'hqyyqh.dynasense';
const VERSION_MARKER = /<!-- marketplace-version:(\d+\.\d+\.\d+) -->/;
const GALLERY_API_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX_API_URL = 'https://open-vsx.org/api/hqyyqh/dynasense';
const VISUAL_STUDIO_MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;
const OPEN_VSX_EXTENSION_URL = 'https://open-vsx.org/extension/hqyyqh/dynasense';

function extractMarketplaceVersion(body = '') {
    return VERSION_MARKER.exec(body)?.[1] ?? null;
}

function releaseIssueTitle(version) {
    return `Verify DynaSense ${version} marketplace release`;
}

function releaseIssueBody(version) {
    return [
        `DynaSense ${version} has been submitted automatically to both extension marketplaces.`,
        '',
        'This issue tracks public indexing of the same packaged VSIX:',
        '',
        `- [ ] [Visual Studio Marketplace](${VISUAL_STUDIO_MARKETPLACE_URL}) exposes version \`${version}\``,
        `- [ ] [Open VSX](${OPEN_VSX_EXTENSION_URL}) exposes version \`${version}\``,
        '',
        'The scheduled verification workflow closes this issue after both public APIs report the target version.',
        '',
        `<!-- marketplace-version:${version} -->`
    ].join('\n');
}

async function ensureReleaseLabel({ github, context }) {
    const args = { ...context.repo, name: RELEASE_LABEL };

    try {
        await github.rest.issues.getLabel(args);
    } catch (error) {
        if (error?.status !== 404) {
            throw error;
        }
        await github.rest.issues.createLabel({
            ...context.repo,
            name: RELEASE_LABEL,
            color: '1d76db',
            description: 'Tracks public availability in both extension marketplaces'
        });
    }
}

async function ensureMarketplaceReleaseIssue({ github, context, version }) {
    await ensureReleaseLabel({ github, context });

    const title = releaseIssueTitle(version);
    const { data: issues } = await github.rest.issues.listForRepo({
        ...context.repo,
        state: 'all',
        labels: RELEASE_LABEL,
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
        body: releaseIssueBody(version),
        labels: [RELEASE_LABEL]
    });
    return data;
}

async function fetchVisualStudioMarketplaceVersions(fetchImpl = globalThis.fetch) {
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
        throw new Error(`Visual Studio Marketplace Gallery API request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.results)) {
        throw new Error('Visual Studio Marketplace Gallery API returned an invalid response');
    }
    const extensions = payload.results.flatMap(result => result.extensions || []);
    const extension = extensions.find(candidate =>
        candidate.publisher?.publisherName === 'hqyyqh' &&
        candidate.extensionName === 'dynasense'
    );

    return new Set((extension?.versions || []).map(version => version.version));
}

async function fetchOpenVsxVersions(fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(OPEN_VSX_API_URL, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            'User-Agent': 'vscode-lsdyna-release-workflow'
        }
    });

    if (!response.ok) {
        throw new Error(`Open VSX API request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (!payload?.allVersions || typeof payload.allVersions !== 'object' || Array.isArray(payload.allVersions)) {
        throw new Error('Open VSX API returned an invalid response');
    }

    return new Set(Object.keys(payload.allVersions).filter(version => VERSION_MARKER.test(`<!-- marketplace-version:${version} -->`)));
}

async function verifyMarketplaceReleaseIssues({ github, context, fetchImpl = globalThis.fetch }) {
    const { data: issues } = await github.rest.issues.listForRepo({
        ...context.repo,
        state: 'open',
        labels: RELEASE_LABEL,
        per_page: 100
    });
    const releaseIssues = issues.filter(issue => !issue.pull_request && extractMarketplaceVersion(issue.body));

    if (releaseIssues.length === 0) {
        return {
            checked: 0,
            closed: 0,
            visualStudioMarketplaceVersions: 0,
            openVsxVersions: 0
        };
    }

    const visualStudioVersions = await fetchVisualStudioMarketplaceVersions(fetchImpl);
    const openVsxVersions = await fetchOpenVsxVersions(fetchImpl);
    let closed = 0;

    for (const issue of releaseIssues) {
        const version = extractMarketplaceVersion(issue.body);
        if (!visualStudioVersions.has(version) || !openVsxVersions.has(version)) {
            continue;
        }

        await github.rest.issues.createComment({
            ...context.repo,
            issue_number: issue.number,
            body: [
                `Verified ${EXTENSION_ID}@${version} in both extension marketplaces:`,
                '',
                `- Visual Studio Marketplace: ${VISUAL_STUDIO_MARKETPLACE_URL}`,
                `- Open VSX: ${OPEN_VSX_EXTENSION_URL}`
            ].join('\n')
        });
        await github.rest.issues.update({
            ...context.repo,
            issue_number: issue.number,
            state: 'closed',
            state_reason: 'completed'
        });
        closed += 1;
    }

    return {
        checked: releaseIssues.length,
        closed,
        visualStudioMarketplaceVersions: visualStudioVersions.size,
        openVsxVersions: openVsxVersions.size
    };
}

module.exports = {
    EXTENSION_ID,
    RELEASE_LABEL,
    extractMarketplaceVersion,
    ensureMarketplaceReleaseIssue,
    fetchVisualStudioMarketplaceVersions,
    fetchOpenVsxVersions,
    verifyMarketplaceReleaseIssues
};
