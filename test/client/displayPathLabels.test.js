'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { displayPathLabels } = require('../../out/client/displayPathLabels');
const { KeywordOptionsWebviewProvider } = require('../../out/client/KeywordOptionsWebviewProvider');

describe('cached result display paths', () => {
    const root = path.parse(process.cwd()).root;
    const front = path.join(root, 'model', 'front', 'contact.key');
    const rear = path.join(root, 'model', 'rear', 'contact.key');
    it('distinguishes unique files, directory depth and roots without counting repeated locations', () => {
        const other = path.join(root, 'other', 'front', 'contact.key');
        const unique = path.join(root, 'model', 'part.key');
        const paths = [front, rear, front, other, unique];
        const labels = displayPathLabels(paths);
        assert.equal(labels.get(front), 'model/front/contact.key');
        assert.equal(labels.get(rear), 'rear/contact.key');
        assert.equal(labels.get(other), 'other/front/contact.key');
        assert.equal(labels.get(unique), 'part.key');
        if (process.platform === 'win32') {
            const roots = displayPathLabels(['C:/model/contact.key', 'D:/model/contact.key']);
            assert.equal(roots.get('C:/model/contact.key'), 'C:/model/contact.key');
            assert.equal(roots.get('D:/model/contact.key'), 'D:/model/contact.key');
        }
    });
    it('keeps instance identity and cached labels across field edits, then updates a changed path set', () => {
        const instances = [front, rear, front].map((filePath, index) => ({ instanceId: String(index), filePath, line: index }));
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {}, { revision: 0, instances });
        assert.equal(provider.getState().instances[0].displayPath, 'front/contact.key');
        const labels = provider.pathLabels;
        provider.publish({ instances: instances.map(instance => ({ ...instance })), selectedFieldId: 'SSID' });
        assert.equal(provider.pathLabels, labels);
        assert.equal(provider.getState().instances[2].instanceId, '2');
        assert.equal(provider.getState().instances[2].filePath, front);
        provider.publish({ instances: [instances[0]] });
        assert.equal(provider.getState().instances[0].displayPath, 'contact.key');
        provider.dispose();
    });
});
