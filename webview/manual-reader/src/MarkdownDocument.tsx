import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { remarkBilingual } from './remarkBilingual';
import { protectLsdynaMathSource, remarkLsdynaMath } from './remarkLsdynaMath';
import { remarkManualTables } from './remarkManualTables';
import { scrollRegionClassName } from './tableLayout';
import { tableKindFromProps } from './tableKindFromElement';
import { TranslationOverlay } from './TranslationOverlay';
import { ImageLightbox } from './ImageLightbox';

export interface MarkdownDocumentProps {
    markdown: string;
    chunkBaseUri: string;
    sentencePairs: Array<{ primary: string; secondary: string }>;
    onOpenLink: (href: string) => void;
    tableLabel?: string;
    translationHint?: string;
    translationPreviewLabel?: string;
    closeTranslationLabel?: string;
    openImageLabel?: string;
    imagePreviewLabel?: string;
    zoomInLabel?: string;
    zoomOutLabel?: string;
    resetImageLabel?: string;
    closeImageLabel?: string;
}

interface TranslationPreview {
    text: string;
    target: HTMLElement;
    pinned: boolean;
}

interface LightboxImage {
    src: string;
    alt: string;
    caption: string;
    target: HTMLElement;
}

function imageUri(source: string | undefined, chunkBaseUri: string): string | undefined {
    if (!source) return undefined;
    if (/^(?:data:|blob:|vscode-(?:resource|webview-resource):)/i.test(source)) return source;
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return undefined;
    try {
        return new URL(source, chunkBaseUri.endsWith('/') ? chunkBaseUri : `${chunkBaseUri}/`).toString();
    } catch {
        return undefined;
    }
}

function overlayPosition(target: HTMLElement): { left: number; top: number } {
    const rect = target.getBoundingClientRect();
    const margin = 12;
    const estimatedWidth = Math.min(360, Math.max(180, window.innerWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - estimatedWidth - margin));
    const below = rect.bottom + 8;
    const top = below + 150 <= window.innerHeight ? below : Math.max(margin, rect.top - 128);
    return { left: Math.round(left), top: Math.round(top) };
}

interface MarkdownContentProps {
    markdown: string;
    chunkBaseUri: string;
    sentencePairs: Array<{ primary: string; secondary: string }>;
    onOpenLink: (href: string) => void;
    tableLabel: string;
    translationHint: string;
    onPreview: (target: HTMLElement, text: string, pinned: boolean) => void;
    onPreviewLeave: (target: HTMLElement) => void;
    openImageLabel: string;
    onOpenImage: (image: LightboxImage) => void;
}

const MarkdownContent = React.memo(function MarkdownContent({
    markdown, chunkBaseUri, sentencePairs, onOpenLink, tableLabel, translationHint, onPreview, onPreviewLeave, openImageLabel, onOpenImage,
}: MarkdownContentProps): React.JSX.Element {
    const components = useMemo<Components>(() => ({
        a: ({ node: _node, href, onClick: _onClick, ...props }) => <a {...props} href={href || undefined} onClick={event => {
            if (!href) return;
            event.preventDefault();
            onOpenLink(href);
        }} />,
        img: ({ node: _node, src, alt = '', title, ...props }) => {
            const resolved = imageUri(typeof src === 'string' ? src : undefined, chunkBaseUri);
            if (!resolved) return <span className="reader-image-unavailable" role="img" aria-label={alt} />;
            const open = (target: HTMLElement) => onOpenImage({ src: resolved, alt, caption: typeof title === 'string' ? title : alt, target });
            return <button
                type="button"
                className="reader-image-trigger"
                aria-label={`${openImageLabel}: ${alt}`}
                aria-haspopup="dialog"
                onClick={event => open(event.currentTarget)}
                onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    open(event.currentTarget);
                }}
            ><img {...props} src={resolved} alt={alt} title={title} /></button>;
        },
        table: ({ node: _node, className, children, ...props }) => {
            const attributes = props as typeof props & { 'data-manual-table'?: unknown };
            const kind = tableKindFromProps(attributes['data-manual-table'], children);
            const kindClass = `reader-table--${kind}`;
            const tableClass = [className, kindClass].filter(Boolean).join(' ');
            return <div className={scrollRegionClassName(kind)} role="region" aria-label={tableLabel} tabIndex={0}>
                <table {...props} className={tableClass || undefined} data-manual-table={kind}>{children}</table>
            </div>;
        },
        span: ({ node: _node, className, onMouseEnter, onMouseLeave, onFocus, onBlur, onClick, onKeyDown, ...props }) => {
            const bilingual = className?.split(/\s+/).includes('bilingual-text');
            const attributes = props as typeof props & { 'data-translation'?: unknown };
            const secondary = typeof attributes['data-translation'] === 'string' ? attributes['data-translation'] : null;
            if (!bilingual || !secondary) return <span {...props} className={className} />;
            return <span
                {...props}
                className={className}
                tabIndex={0}
                title={translationHint}
                aria-haspopup="dialog"
                onMouseEnter={event => { onMouseEnter?.(event); onPreview(event.currentTarget, secondary, false); }}
                onMouseLeave={event => { onMouseLeave?.(event); onPreviewLeave(event.currentTarget); }}
                onFocus={event => { onFocus?.(event); onPreview(event.currentTarget, secondary, false); }}
                onBlur={event => { onBlur?.(event); onPreviewLeave(event.currentTarget); }}
                onClick={event => { onClick?.(event); onPreview(event.currentTarget, secondary, true); }}
                onKeyDown={event => {
                    onKeyDown?.(event);
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onPreview(event.currentTarget, secondary, true);
                }}
            />;
        },
    }), [chunkBaseUri, onOpenImage, onOpenLink, onPreview, onPreviewLeave, openImageLabel, tableLabel, translationHint]);

    // Shield $$ / $ from CommonMark setext + emphasis *before* remark-parse.
    // Without this, lone `=` lines inside display math become <h1> and KaTeX
    // never receives a complete equation (raw LaTeX appears in the reader).
    const shielded = useMemo(() => protectLsdynaMathSource(markdown), [markdown]);

    return <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkManualTables, remarkLsdynaMath, [remarkBilingual, { sentencePairs }]]}
        rehypePlugins={[rehypeRaw, [rehypeKatex, { strict: 'ignore', trust: false }]]}
        components={components}
    >{shielded}</ReactMarkdown>;
});

export function MarkdownDocument({
    markdown,
    chunkBaseUri,
    sentencePairs,
    onOpenLink,
    tableLabel = 'Scrollable table',
    translationHint = 'Hold Alt to preview a translation; click to pin it.',
    translationPreviewLabel = 'Translation preview',
    closeTranslationLabel = 'Close translation',
    openImageLabel = 'Open image',
    imagePreviewLabel = 'Image preview',
    zoomInLabel = 'Zoom in',
    zoomOutLabel = 'Zoom out',
    resetImageLabel = 'Reset image',
    closeImageLabel = 'Close image',
}: MarkdownDocumentProps): React.JSX.Element {
    const [altHeld, setAltHeld] = useState(false);
    const [preview, setPreview] = useState<TranslationPreview | null>(null);
    const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
    const [, reposition] = useState(0);
    const overlayId = useId();
    const describedTarget = useRef<HTMLElement | null>(null);
    const visible = Boolean(preview && (preview.pinned || altHeld));

    const showPreview = useCallback((target: HTMLElement, text: string, pinned: boolean) => {
        setPreview(current => pinned && current?.pinned && current.target === target ? null : { target, text, pinned });
    }, []);
    const leavePreview = useCallback((target: HTMLElement) => {
        setPreview(current => current?.target === target && !current.pinned ? null : current);
    }, []);
    const openImage = useCallback((image: LightboxImage) => setLightbox(image), []);
    const closeImage = useCallback(() => {
        setLightbox(current => {
            current?.target.focus();
            return null;
        });
    }, []);

    useEffect(() => {
        const down = (event: KeyboardEvent) => {
            if (event.key === 'Alt') setAltHeld(true);
            if (event.key === 'Escape') setPreview(null);
        };
        const up = (event: KeyboardEvent) => { if (event.key === 'Alt') setAltHeld(false); };
        const blur = () => setAltHeld(false);
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', blur);
        };
    }, []);

    useEffect(() => { setPreview(null); setLightbox(null); }, [chunkBaseUri, markdown, sentencePairs]);
    useEffect(() => {
        describedTarget.current?.removeAttribute('aria-describedby');
        describedTarget.current = null;
        if (visible && preview) {
            preview.target.setAttribute('aria-describedby', overlayId);
            describedTarget.current = preview.target;
        }
        return () => describedTarget.current?.removeAttribute('aria-describedby');
    }, [overlayId, preview, visible]);
    useEffect(() => {
        if (!visible) return;
        const update = () => reposition(value => value + 1);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, { passive: true });
        return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update); };
    }, [visible]);

    const showTranslationChrome = sentencePairs.length > 0 && Boolean(translationHint);
    return <div className={`markdown-body${altHeld && showTranslationChrome ? ' translation-peek' : ''}`}>
        {showTranslationChrome ? <div className="reader-translation-hint">{translationHint}</div> : null}
        <MarkdownContent
            markdown={markdown}
            chunkBaseUri={chunkBaseUri}
            sentencePairs={sentencePairs}
            onOpenLink={onOpenLink}
            tableLabel={tableLabel}
            translationHint={translationHint}
            onPreview={showPreview}
            onPreviewLeave={leavePreview}
            openImageLabel={openImageLabel}
            onOpenImage={openImage}
        />
        {visible && preview ? <TranslationOverlay
            id={overlayId}
            text={preview.text}
            pinned={preview.pinned}
            label={translationPreviewLabel}
            closeLabel={closeTranslationLabel}
            position={overlayPosition(preview.target)}
            onClose={() => setPreview(null)}
        /> : null}
        {lightbox ? <ImageLightbox
            src={lightbox.src}
            alt={lightbox.alt}
            caption={lightbox.caption}
            label={imagePreviewLabel}
            zoomInLabel={zoomInLabel}
            zoomOutLabel={zoomOutLabel}
            resetLabel={resetImageLabel}
            closeLabel={closeImageLabel}
            onClose={closeImage}
        /> : null}
    </div>;
}
