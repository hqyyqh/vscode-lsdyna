'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function isValidUtf8(buffer) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return true;
    } catch (_error) {
        return false;
    }
}

function findLatestValidRevision(commits, readBlob) {
    for (const commit of commits) {
        const blob = readBlob(commit);
        if (blob && isValidUtf8(blob)) return commit;
    }
    return null;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeRecoveredMarkdown(buffer) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return Buffer.from(text.replace(/[ \t]+(?=\r?$)/gm, ''), 'utf8');
}

function shouldRecoverDocument(currentBuffer, headBuffer) {
    return !isValidUtf8(currentBuffer) || !!(headBuffer && !isValidUtf8(headBuffer));
}

function collectMarkdownFiles(rootDir) {
    if (!fs.existsSync(rootDir)) return [];
    const result = [];
    const stack = [rootDir];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(fullPath);
            else if (entry.name.endsWith('.md')) result.push(fullPath);
        }
    }
    return result.sort();
}

function gitOutput(projectRoot, args, encoding = 'utf8') {
    return execFileSync('git', args, {
        cwd: projectRoot,
        encoding,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
    });
}

function gitPath(projectRoot, filePath) {
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function getFileCommits(projectRoot, relativePath) {
    const output = gitOutput(projectRoot, ['log', '--format=%H', '--', relativePath]);
    return output.trim().split(/\r?\n/).filter(Boolean);
}

function readBlob(projectRoot, commit, relativePath) {
    try {
        return gitOutput(projectRoot, ['show', `${commit}:${relativePath}`], null);
    } catch (_error) {
        return null;
    }
}

function currentBlobId(projectRoot, relativePath) {
    try {
        return gitOutput(projectRoot, ['rev-parse', `HEAD:${relativePath}`]).trim();
    } catch (_error) {
        return null;
    }
}

function renderArchiveReadme(records) {
    const lines = [
        '# Superpowers 文档编码恢复清单',
        '',
        '本清单由 `scripts/recover-superpowers-docs.cjs` 生成。恢复过程只接受可被严格 UTF-8 解码的 Git 历史 blob，不使用替换字符猜测丢失内容。',
        '',
        '| 原路径 | 状态 | 来源提交 | 原始 SHA-256 | 恢复后 SHA-256 |',
        '| :--- | :--- | :--- | :--- | :--- |',
    ];
    for (const record of records) {
        lines.push(`| \`${record.path}\` | ${record.status} | ${record.recoveredFrom || '-'} | \`${record.originalSha256}\` | \`${record.recoveredSha256 || '-'}\` |`);
    }
    lines.push('');
    return lines.join('\n');
}

function recoverSuperpowersDocs(projectRoot, { apply = false } = {}) {
    const root = path.resolve(projectRoot);
    const docsRoot = path.join(root, 'docs', 'superpowers');
    const invalidFiles = collectMarkdownFiles(docsRoot)
        .map(filePath => {
            const relativePath = gitPath(root, filePath);
            return {
                filePath,
                relativePath,
                current: fs.readFileSync(filePath),
                head: readBlob(root, 'HEAD', relativePath),
            };
        })
        .filter(entry => shouldRecoverDocument(entry.current, entry.head));
    const records = [];

    for (const entry of invalidFiles) {
        const { filePath, relativePath } = entry;
        const original = entry.head && !isValidUtf8(entry.head) ? entry.head : entry.current;
        const commits = getFileCommits(root, relativePath);
        const recoveredFrom = findLatestValidRevision(
            commits,
            commit => readBlob(root, commit, relativePath)
        );
        const recoveredBlob = recoveredFrom ? readBlob(root, recoveredFrom, relativePath) : null;
        const recovered = recoveredBlob ? normalizeRecoveredMarkdown(recoveredBlob) : null;
        const record = {
            path: relativePath,
            currentBlob: currentBlobId(root, relativePath),
            recoveredFrom,
            status: recovered ? 'recovered' : 'archived-raw',
            originalSha256: sha256(original),
            recoveredSha256: recovered ? sha256(recovered) : null,
        };
        records.push(record);

        if (!apply) continue;
        if (recovered) {
            fs.writeFileSync(filePath, recovered);
        } else {
            const rawPath = path.join(docsRoot, 'archive', 'raw', `${relativePath}.bin`);
            fs.mkdirSync(path.dirname(rawPath), { recursive: true });
            fs.writeFileSync(rawPath, original);
            fs.unlinkSync(filePath);
        }
    }

    if (apply && records.length > 0) {
        const readmePath = path.join(docsRoot, 'archive', 'README.md');
        fs.mkdirSync(path.dirname(readmePath), { recursive: true });
        fs.writeFileSync(readmePath, renderArchiveReadme(records), 'utf8');
    }

    return records;
}

module.exports = {
    findLatestValidRevision,
    isValidUtf8,
    normalizeRecoveredMarkdown,
    recoverSuperpowersDocs,
    renderArchiveReadme,
    shouldRecoverDocument,
};

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    const records = recoverSuperpowersDocs(process.cwd(), { apply });
    console.log(JSON.stringify({
        mode: apply ? 'apply' : 'dry-run',
        invalidDocuments: records.length,
        recovered: records.filter(record => record.status === 'recovered').length,
        archivedRaw: records.filter(record => record.status === 'archived-raw').length,
        records,
    }, null, 2));
}
