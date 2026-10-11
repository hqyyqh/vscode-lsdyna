import React, { useEffect, useRef } from 'react';
import type { ManualReadingMode, ManualLocation, ReaderChromeIdentity, ReaderViewModel } from '../../../src/manual/readerProtocol';
import type { ReaderMessages } from './readerI18n';
import { Codicon } from '../../shared/Codicon';
import { useToolbarHeight } from './useToolbarHeight';

interface ToolbarButtonProps {
    label: string;
    title?: string;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
    className?: string;
    buttonRef?: React.RefObject<HTMLButtonElement | null>;
}

function ToolbarButton({
    label, title, disabled, onClick, children, className = '', buttonRef,
}: ToolbarButtonProps): React.JSX.Element {
    return <button
        ref={buttonRef}
        className={`reader-toolbar__button${className ? ` ${className}` : ''}`}
        type="button"
        aria-label={label}
        title={title || label}
        disabled={disabled}
        onClick={onClick}
    >{children}</button>;
}

function formatCrumb(chrome: ReaderChromeIdentity): string {
    const volume = (chrome.volumeTitle || '').trim();
    const chapter = (chrome.chapterLabel || '').trim();
    if (volume && chapter) return `${volume} · ${chapter}`;
    return volume || chapter;
}

interface ReaderToolbarProps {
    view: ReaderViewModel;
    messages: ReaderMessages;
    searchButtonRef: React.RefObject<HTMLButtonElement | null>;
    onOpenSearch: () => void;
    onNavigate: (target: string | ManualLocation) => void;
    onRequest: (name: string, payload?: Record<string, unknown>) => void;
    onOpenPdf?: () => void;
    /** Document language shown in the pill (may be optimistic until host catches up). */
    displayLanguage?: ManualReadingMode;
    languagePending?: boolean;
    onToggleLanguage?: (mode: ManualReadingMode) => void;
    progress: number;
    fontScalePercentLabel: string;
    canDecreaseFontScale: boolean;
    canIncreaseFontScale: boolean;
    onDecreaseFontScale: () => void;
    onIncreaseFontScale: () => void;
    onResetFontScale: () => void;
}

/** Responsive chrome; measured height keeps anchors and overlays below both rows. */
export function ReaderToolbar({
    view, messages, searchButtonRef, onOpenSearch, onNavigate, onRequest, onOpenPdf,
    displayLanguage, languagePending, onToggleLanguage, progress,
    fontScalePercentLabel, canDecreaseFontScale, canIncreaseFontScale,
    onDecreaseFontScale, onIncreaseFontScale, onResetFontScale,
}: ReaderToolbarProps): React.JSX.Element {
    const toolbarRef = useRef<HTMLElement>(null);
    useToolbarHeight(toolbarRef);
    const settingsRef = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        const closeOutside = (event: PointerEvent) => {
            const settings = settingsRef.current;
            if (settings?.open && event.target instanceof Node && !settings.contains(event.target)) settings.open = false;
        };
        document.addEventListener('pointerdown', closeOutside, true);
        return () => document.removeEventListener('pointerdown', closeOutside, true);
    }, []);
    // Toggle follows pack capability only — not VS Code UI locale.
    const showLanguageToggle = view.canToggleLanguage !== false;
    const sectionTitle = view.location.title || view.location.sectionId;
    const crumb = formatCrumb(view.chrome);
    const matchHint = view.location.matchKind === 'approximate'
        ? `${messages.approximateMatch}: ${view.location.requestedKeyword || ''} → ${view.location.matchedKeyword || sectionTitle}` : '';
    const identityTooltip = crumb ? `${crumb} — ${sectionTitle}` : sectionTitle;
    const language = displayLanguage ?? view.language;


    return <header ref={toolbarRef} className="reader-toolbar" aria-label={messages.toolbar}>
        <div className="reader-toolbar__navigation">
            <div className="reader-toolbar__cluster" role="group" aria-label={messages.navHistory}>
                <ToolbarButton label={messages.back} disabled={!view.navigation.canBack} onClick={() => onNavigate('back')}>
                    <Codicon name="arrow-left" className="reader-toolbar__icon" />
                </ToolbarButton>
                <ToolbarButton label={messages.forward} disabled={!view.navigation.canForward} onClick={() => onNavigate('forward')}>
                    <Codicon name="arrow-right" className="reader-toolbar__icon" />
                </ToolbarButton>
            </div>
            <div className="reader-toolbar__cluster" role="group" aria-label={messages.navSections}>
                <ToolbarButton label={messages.previousSection} disabled={!view.navigation.canPreviousSection} onClick={() => onNavigate('previousSection')}>
                    <Codicon name="chevron-left" className="reader-toolbar__icon" />
                </ToolbarButton>
                <ToolbarButton label={messages.nextSection} disabled={!view.navigation.canNextSection} onClick={() => onNavigate('nextSection')}>
                    <Codicon name="chevron-right" className="reader-toolbar__icon" />
                </ToolbarButton>
            </div>
        </div>

        <div className="reader-toolbar__identity" title={identityTooltip}>
            {crumb ? <span className="reader-toolbar__crumb">{crumb}</span> : null}
            <span className="reader-toolbar__title">{matchHint && <span role="img" aria-label={matchHint} title={matchHint}>≈ </span>}{sectionTitle}</span>
        </div>

        <div className="reader-toolbar__actions">
            {showLanguageToggle ? (
                <label className="reader-language" title={`${messages.toggleLanguage}: ${language === 'bilingual' ? messages.bilingualLabel : language === 'zh' ? '中文' : 'English'}`}>
                    <Codicon name={language === 'bilingual' ? 'split-horizontal' : 'globe'} />
                    <select aria-label={messages.toggleLanguage} value={language} disabled={languagePending}
                        onChange={event => {
                            const mode = event.target.value as ManualReadingMode;
                            if (onToggleLanguage) onToggleLanguage(mode);
                            else onRequest('reader/toggleLanguage', { mode });
                        }}>
                        <option value="zh" aria-label="中文">中</option>
                        <option value="en" aria-label="English">EN</option>
                        {view.canCompareLanguages && <option value="bilingual" aria-label={messages.bilingualLabel}>{messages.bilingual}</option>}
                    </select>
                </label>
            ) : null}
            <ToolbarButton
                className="reader-toolbar__button--text"
                label={messages.openPdf}
                onClick={() => (onOpenPdf ? onOpenPdf() : onRequest('reader/openPdf'))}
            >
                <Codicon name="file-pdf" className="reader-toolbar__icon" />
                <span className="reader-toolbar__btn-label">PDF</span>
            </ToolbarButton>
            <details ref={settingsRef} className="reader-settings"
                onKeyDown={event => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector('summary')?.focus();
                }}
                onBlur={event => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
                }}
            >
                <summary className="reader-toolbar__button" title={messages.readingSettings} aria-label={messages.readingSettings}>Aa</summary>
                <div className="reader-settings__panel">
                    <span className="reader-settings__label">{messages.fontScaleGroup}</span>
                    <div className="reader-toolbar__cluster reader-toolbar__cluster--font-scale" role="group" aria-label={messages.fontScaleGroup}>
                        <ToolbarButton
                            label={messages.fontScaleDecrease}
                            disabled={!canDecreaseFontScale}
                            onClick={onDecreaseFontScale}
                        >
                            <span aria-hidden="true">A−</span>
                        </ToolbarButton>
                        <ToolbarButton
                            className="reader-toolbar__button--font-scale-label"
                            label={`${messages.fontScaleReset} (${fontScalePercentLabel})`}
                            title={`${messages.fontScaleReset} · ${fontScalePercentLabel}`}
                            onClick={onResetFontScale}
                        >
                            {/* span (not output): avoid implicit role=status clashing with search status. */}
                            <span aria-live="polite">{fontScalePercentLabel}</span>
                        </ToolbarButton>
                        <ToolbarButton
                            label={messages.fontScaleIncrease}
                            disabled={!canIncreaseFontScale}
                            onClick={onIncreaseFontScale}
                        >
                            <span aria-hidden="true">A+</span>
                        </ToolbarButton>
                    </div>
                </div>
            </details>
            <ToolbarButton
                className="reader-toolbar__button--search"
                label={messages.searchManuals}
                title={`${messages.searchManuals} (/)`}
                onClick={onOpenSearch}
                buttonRef={searchButtonRef}
            >
                <Codicon name="search" className="reader-toolbar__icon" />
            </ToolbarButton>
        </div>

        <div
            className="reader-progress"
            role="progressbar"
            aria-label={messages.readingProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
        >
            <i style={{ width: `${progress}%` }} />
        </div>
    </header>;
}
