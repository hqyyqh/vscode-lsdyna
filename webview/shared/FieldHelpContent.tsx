import './fieldHelp.css';

export function FieldHelpContent({ name, typeLabel, description, isZh, loading, defaultValue, choices }: {
    name: string;
    typeLabel?: string;
    description: string;
    isZh: boolean;
    loading?: boolean;
    defaultValue?: string;
    choices?: string[];
}) {
    const lines = description.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return <div className="fieldHelpContent">
        <span className="fieldHelpName">{name}</span>
        {typeLabel && <span className="fieldHelpType"> ({typeLabel})</span>}:{' '}
        {loading ? <span className="fieldHelpText loading">{isZh ? '正在加载…' : 'Loading…'}</span> : <>
            <span className="fieldHelpText">{lines[0]}</span>
            {defaultValue !== undefined && <span className="helpMeta">
                <span>{isZh ? '默认值' : 'Default'}</span><code>{defaultValue || (isZh ? '（空）' : '(empty)')}</code>
            </span>}
            {!!choices?.length && <span className="fieldHelpChoices">
                <span>{isZh ? '可选值' : 'Choices'} ({choices.length})</span>: <code>{choices.join(', ')}</code>
            </span>}
            {lines.slice(1).map((rule, index) => <div key={index} className="fieldHelpRule">{rule}</div>)}
        </>}
    </div>;
}
