import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDownToLine, ArrowUpToLine, Bold, Info, Italic, Moon, Sun, Trash2 } from 'lucide-react';
import type { HighlightRule } from '../../../types';
import { safeCssColor } from '../../../utils/cssColor';
import '../../../styles/highlight-editor.css';
import '../../../styles/rule-preview.css';

const LIGHT_SURFACE = [255, 255, 255] as const;
// Mirror the two opaque terminal surfaces; design-token tests guard drift.
const DARK_SURFACE = [25, 26, 30] as const;
const CONTRAST_WARNING_THRESHOLD = 4.5;

type Rgba = [number, number, number, number];
export type HighlightContrast = { light: number; dark: number };

/**
 * Contrast is deliberately a small parser for the color spellings that can be
 * measured without browser-dependent CSS computation. `safeCssColor` remains
 * the only acceptance gate; unsupported safe spellings are reported as
 * unknown rather than being presented as passing.
 */
function parseHexColor(color: string | undefined): Rgba | null {
  const safe = safeCssColor(color);
  if (!safe || !safe.startsWith('#')) return null;
  const hex = safe.slice(1);
  if (![3, 4, 6, 8].includes(hex.length)) return null;
  const expanded = hex.length <= 4 ? hex.split('').map(value => value + value).join('') : hex;
  const channel = (start: number) => Number.parseInt(expanded.slice(start, start + 2), 16);
  return [channel(0), channel(2), channel(4), expanded.length === 8 ? channel(6) / 255 : 1];
}

function blend(foreground: Rgba, background: readonly [number, number, number]): [number, number, number] {
  const alpha = foreground[3];
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
  ];
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  const channels = rgb.map(value => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground: Rgba, background: readonly [number, number, number]): number {
  const foregroundLuminance = relativeLuminance(blend(foreground, background));
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function getHighlightContrast(color: string | undefined): HighlightContrast | null {
  const parsed = parseHexColor(color);
  if (!parsed) return null;
  return {
    light: contrastRatio(parsed, LIGHT_SURFACE),
    dark: contrastRatio(parsed, DARK_SURFACE),
  };
}

const HighlightRuleEditor: React.FC<{
  rule: HighlightRule;
  onChange: (patch: Partial<HighlightRule>) => void;
  onDelete: () => void;
  handle?: React.ReactNode;
  onInsert?: () => void;
  onInsertBelow?: () => void;
  autoFocus?: boolean;
}> = ({ rule, onChange, onDelete, handle, onInsert, onInsertBelow, autoFocus }) => {
  const { t } = useTranslation();
  const patternRef = useRef<HTMLInputElement>(null);
  const contrastId = useId();
  const [showContrast, setShowContrast] = useState(false);
  const previewColor = safeCssColor(rule.color);
  const pickerColor = previewColor ?? (rule.color ? '#000000' : '#ff6b6b');
  const contrast = getHighlightContrast(rule.color);
  const contrastWarning = contrast !== null && Math.min(contrast.light, contrast.dark) < CONTRAST_WARNING_THRESHOLD;
  const previewStyle = {
    '--preview-color': previewColor ?? 'inherit',
    '--preview-weight': rule.bold ? 'bold' : 'normal',
    '--preview-style': rule.italic ? 'italic' : 'normal',
  } as React.CSSProperties;
  const sample = rule.pattern || t('highlightRuleEditor.emptyPattern');
  const contrastLabel = contrast
    ? `${t('highlightRuleEditor.backgroundLight')} · ${t('highlightRuleEditor.contrastRatio', { ratio: contrast.light.toFixed(1) })}; ${t('highlightRuleEditor.backgroundDark')} · ${t('highlightRuleEditor.contrastRatio', { ratio: contrast.dark.toFixed(1) })}${contrastWarning ? ` — ${t('highlightRuleEditor.contrastWarning')}` : ''}`
    : t('highlightRuleEditor.contrastUnavailable');

  useEffect(() => {
    if (autoFocus) {
      patternRef.current?.focus();
      patternRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [autoFocus]);

  return (
    <div className="highlight-rule-editor">
      <div className="highlight-rule-editor__line highlight-rule-editor__line--main">
        <span className="highlight-rule-editor__handle">{handle}</span>
        <input className="input highlight-rule-editor__name" value={rule.name} onChange={e => onChange({ name: e.target.value })} aria-label={t('highlightRuleEditor.namePlaceholder')} placeholder={t('highlightRuleEditor.namePlaceholder')} />
        <input ref={patternRef} className="input highlight-rule-editor__pattern" value={rule.pattern} onChange={e => onChange({ pattern: e.target.value })} aria-label={t('highlightRuleEditor.patternPlaceholder')} placeholder={t('highlightRuleEditor.patternPlaceholder')} spellCheck={false} />
        <label className="checkbox-wrapper highlight-rule-editor__regex">
          <input type="checkbox" checked={rule.isRegex} onChange={e => onChange({ isRegex: e.target.checked })} />{t('highlightRuleEditor.regexLabel')}
        </label>
        <button type="button" className="icon-btn highlight-rule-editor__delete" onClick={onDelete} title={t('highlightRuleEditor.deleteRule')} aria-label={t('highlightRuleEditor.deleteRule')}><Trash2 size={13} /></button>
      </div>
      <div className="highlight-rule-editor__line highlight-rule-editor__line--style">
        <input className="highlight-rule-editor__color" type="color" value={pickerColor} onChange={e => onChange({ color: e.target.value })} aria-label={t('highlightRuleEditor.colorLabel')} />
        <button type="button" className={`icon-btn highlight-rule-editor__toggle${rule.bold ? ' active' : ''}`}
          aria-pressed={!!rule.bold} title={t('highlightRuleEditor.boldLabel')} aria-label={t('highlightRuleEditor.boldLabel')}
          onClick={() => onChange({ bold: !rule.bold })}><Bold size={14} /></button>
        <button type="button" className={`icon-btn highlight-rule-editor__toggle${rule.italic ? ' active' : ''}`}
          aria-pressed={!!rule.italic} title={t('highlightRuleEditor.italicLabel')} aria-label={t('highlightRuleEditor.italicLabel')}
          onClick={() => onChange({ italic: !rule.italic })}><Italic size={14} /></button>
        <div className="highlight-rule-editor__preview rule-preview__samples" role="group" aria-label={t('highlightRuleEditor.previewLabel')}>
          <div className="rule-preview__sample rule-preview__sample--light" style={previewStyle} title={`${t('highlightRuleEditor.backgroundLight')} · ${sample}`}>
            <Sun size={12} className="highlight-rule-editor__sample-icon" aria-label={t('highlightRuleEditor.backgroundLight')} />
            <span className="rule-preview__sample-text">{sample}</span>
          </div>
          <div className="rule-preview__sample rule-preview__sample--dark" style={previewStyle} title={`${t('highlightRuleEditor.backgroundDark')} · ${sample}`}>
            <Moon size={12} className="highlight-rule-editor__sample-icon" aria-label={t('highlightRuleEditor.backgroundDark')} />
            <span className="rule-preview__sample-text">{sample}</span>
          </div>
        </div>
        <button type="button" className={`icon-btn highlight-rule-editor__contrast-toggle${contrastWarning ? ' rule-preview__contrast--warning' : ''}`}
          aria-expanded={showContrast} aria-controls={showContrast ? contrastId : undefined} title={contrastLabel} aria-label={contrastLabel}
          onClick={() => setShowContrast(value => !value)}>
          {contrastWarning ? <AlertTriangle size={13} /> : <Info size={13} />}
        </button>
        <div className="highlight-rule-editor__insert-actions">
          {onInsert && <button type="button" className="icon-btn" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={onInsert}><ArrowUpToLine size={12} /></button>}
          {onInsertBelow && <button type="button" className="icon-btn" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={onInsertBelow}><ArrowDownToLine size={12} /></button>}
        </div>
      </div>
      {showContrast && <div id={contrastId} className={`rule-preview__contrast highlight-rule-editor__contrast-panel${contrast ? '' : ' rule-preview__contrast--unknown'}`} role="status">
        {contrast ? <>
          <span>{t('highlightRuleEditor.backgroundLight')} · {t('highlightRuleEditor.contrastRatio', { ratio: contrast.light.toFixed(1) })}</span>
          <span>{t('highlightRuleEditor.backgroundDark')} · {t('highlightRuleEditor.contrastRatio', { ratio: contrast.dark.toFixed(1) })}</span>
          {contrastWarning && <span className="highlight-rule-editor__contrast-note">{t('highlightRuleEditor.contrastWarning')}</span>}
        </> : t('highlightRuleEditor.contrastUnavailable')}
      </div>}
    </div>
  );
};

export default HighlightRuleEditor;
