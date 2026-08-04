import React, { useRef } from 'react';
import type { ManualLanguage, ManualLocation, ReaderChromeIdentity, ReaderViewModel } from '../../../src/manual/readerProtocol';
import type { ReaderMessages } from './readerI18n';
import {
    IconArrowLeft,
    IconArrowRight,
    IconChevronLeft,
    IconChevronRight,
    IconPdf,
    IconSearch,
} from './ToolbarIcons';
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
    displayLanguage?: ManualLanguage;
    onToggleLanguage?: () => void;
    progress: number;
    fontScalePercentLabel: string;
    canDecreaseFontScale: boolean;
    canIncreaseFontScale: boolean;
    onDecreaseFontScale: () => void;
    onIncreaseFontScale: () => void;
    onResetFontScale: () => void;
}

/**
 * Always single-row chrome: nav clusters · identity (ellipsis) · actions.
 * Avoids ≤760px wrapping that caused height thrash / content jump.
 */
export function ReaderToolbar({
    view, messages, searchButtonRef, onOpenSearch, onNavigate, onRequest, onOpenPdf,
    displayLanguage, onToggleLanguage, progress,
    fontScalePercentLabel, canDecreaseFontScale, canIncreaseFontScale,
    onDecreaseFontScale, onIncreaseFontScale, onResetFontScale,
}: ReaderToolbarProps): React.JSX.Element {
    const toolbarRef = useRef<HTMLElement>(null);
    useToolbarHeight(toolbarRef);
    // Toggle follows pack capability only — not VS Code UI locale.
    const showLanguageToggle = view.canToggleLanguage !== false;
    const sectionTitle = view.location.title || view.location.sectionId;
    const crumb = formatCrumb(view.chrome);
    const identityTooltip = crumb ? `${crumb} — ${sectionTitle}` : sectionTitle;
    const language = displayLanguage ?? view.language;
    const languageLabel = language === 'zh' ? '中文' : 'EN';
    const languageHint = language === 'zh' ? 'EN' : '中文';

    return <header ref={toolbarRef} className="reader-toolbar" aria-label={messages.toolbar}>
        <div className="reader-toolbar__navigation">
            <div className="reader-toolbar__cluster" role="group" aria-label={messages.navHistory}>
                <ToolbarButton label={messages.back} disabled={!view.navigation.canBack} onClick={() => onNavigate('back')}>
                    <IconArrowLeft />
                </ToolbarButton>
                <ToolbarButton label={messages.forward} disabled={!view.navigation.canForward} onClick={() => onNavigate('forward')}>
                    <IconArrowRight />
                </ToolbarButton>
            </div>
            <div className="reader-toolbar__cluster" role="group" aria-label={messages.navSections}>
                <ToolbarButton label={messages.previousSection} disabled={!view.navigation.canPreviousSection} onClick={() => onNavigate('previousSection')}>
                    <IconChevronLeft />
                </ToolbarButton>
                <ToolbarButton label={messages.nextSection} disabled={!view.navigation.canNextSection} onClick={() => onNavigate('nextSection')}>
                    <IconChevronRight />
                </ToolbarButton>
            </div>
        </div>

        <div className="reader-toolbar__identity" title={identityTooltip}>
            {crumb ? <span className="reader-toolbar__crumb">{crumb}</span> : null}
            {crumb ? <span className="reader-toolbar__sep" aria-hidden="true">/</span> : null}
            <span className="reader-toolbar__title">{sectionTitle}</span>
        </div>

        <div className="reader-toolbar__actions">
            {showLanguageToggle ? (
                <ToolbarButton
                    className="reader-toolbar__button--lang"
                    label={messages.toggleLanguage}
                    title={`${messages.toggleLanguage} → ${languageHint}`}
                    onClick={() => (onToggleLanguage ? onToggleLanguage() : onRequest('reader/toggleLanguage'))}
                >
                    <span className="reader-toolbar__lang-pill">{languageLabel}</span>
                </ToolbarButton>
            ) : null}
            <ToolbarButton
                className="reader-toolbar__button--text"
                label={messages.openPdf}
                onClick={() => (onOpenPdf ? onOpenPdf() : onRequest('reader/openPdf'))}
            >
                <IconPdf />
                <span className="reader-toolbar__btn-label">PDF</span>
            </ToolbarButton>
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
            <ToolbarButton
                className="reader-toolbar__button--search"
                label={messages.searchManuals}
                title={`${messages.searchManuals} (/)`}
                onClick={onOpenSearch}
                buttonRef={searchButtonRef}
            >
                <IconSearch />
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
