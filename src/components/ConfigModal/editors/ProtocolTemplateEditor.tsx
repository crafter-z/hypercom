import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { ProtocolTemplate } from '../../../types';
import { safeCssColor } from '../../../utils/cssColor';
import { NumericInput } from '../../shared/NumericInput';
import '../../../styles/rule-preview.css';

/**
 * Protocol template editor form.
 * Controlled component — all state lives in the parent (ProtocolSettings page).
 * The structure summary is a visualisation of the configured fields only; it
 * does not claim to parse a live frame.
 */
const ProtocolTemplateEditor: React.FC<{
  template: ProtocolTemplate;
  onChange: (patch: Partial<ProtocolTemplate>) => void;
  onDelete: () => void;
}> = ({ template, onChange, onDelete }) => {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  const focusField = (id: string) => {
    const field = document.getElementById(id);
    if (!field || !rootRef.current?.contains(field)) return;
    field.focus();
    field.scrollIntoView?.({ block: 'nearest' });
  };
  const summaryColor = (color: string): React.CSSProperties => ({
    '--segment-color': safeCssColor(color) ?? 'var(--text-secondary)',
  } as React.CSSProperties);
  const none = t('protocolEditor.structure.none');
  const header = template.headerBytes.trim() || none;
  const footer = template.footerBytes.trim() || none;
  const lengthSize = template.lengthFieldSize === 2
    ? t('protocolEditor.lengthFieldSize.2bytes')
    : t('protocolEditor.lengthFieldSize.1byte');
  const lengthEndian = template.lengthEndian === 'big'
    ? t('protocolEditor.lengthEndian.big')
    : t('protocolEditor.lengthEndian.little');
  const checksum = template.checksumAlgorithm === 'none'
    ? t('protocolEditor.checksumAlgorithm.none')
    : template.checksumAlgorithm === 'sum8'
      ? 'Sum8'
      : template.checksumAlgorithm === 'xor'
        ? 'XOR'
        : 'CRC-8';

  return (
    <div ref={rootRef} className="protocol-template-editor">
      <div className="protocol-structure-summary" aria-label={t('protocolEditor.structureSummary')}>
        <div className="protocol-structure-summary__header">
          <span className="protocol-structure-summary__title">{t('protocolEditor.structureSummary')}</span>
          <span className="protocol-structure-summary__hint">{t('protocolEditor.structureSummaryHint')}</span>
        </div>
        <div className="protocol-structure-summary__segments" role="group" aria-label={t('protocolEditor.structureSummary')}>
          <button
            type="button"
            className="protocol-structure-summary__segment"
            style={summaryColor(template.colorHeader)}
            aria-label={`${t('protocolEditor.color.header')}: ${header}`}
            onClick={() => focusField(`protocol-header-${template.id}`)}
          >
            <span className="protocol-structure-summary__segment-label">{t('protocolEditor.color.header')}</span>
            <span className="protocol-structure-summary__segment-value">{header}</span>
          </button>
          <button
            type="button"
            className="protocol-structure-summary__segment"
            style={summaryColor(template.colorLength)}
            aria-label={`${t('protocolEditor.color.length')}: ${template.lengthFieldOffset}, ${lengthSize}, ${lengthEndian}, ${t('protocolEditor.lengthAdjustLabel')}: ${template.lengthAdjust}`}
            onClick={() => focusField(`protocol-length-offset-${template.id}`)}
          >
            <span className="protocol-structure-summary__segment-label">{t('protocolEditor.color.length')}</span>
            <span className="protocol-structure-summary__segment-value">{template.lengthFieldOffset} · {lengthSize} · {lengthEndian} · {t('protocolEditor.lengthAdjustLabel')}: {template.lengthAdjust}</span>
          </button>
          <button
            type="button"
            className="protocol-structure-summary__segment"
            style={summaryColor(template.colorPayload)}
            aria-label={t('protocolEditor.payloadSummary')}
            onClick={() => focusField(`protocol-length-offset-${template.id}`)}
          >
            <span className="protocol-structure-summary__segment-label">{t('protocolEditor.color.payload')}</span>
            <span className="protocol-structure-summary__segment-value">{t('protocolEditor.payloadSummary')}</span>
          </button>
          <button
            type="button"
            className="protocol-structure-summary__segment"
            style={summaryColor(template.colorChecksum)}
            aria-label={`${t('protocolEditor.color.checksum')}: ${checksum}, ${t('protocolEditor.checksumOffsetLabel')}: ${template.checksumOffset}`}
            onClick={() => focusField(`protocol-checksum-algorithm-${template.id}`)}
          >
            <span className="protocol-structure-summary__segment-label">{t('protocolEditor.color.checksum')}</span>
            <span className="protocol-structure-summary__segment-value">{checksum} · {t('protocolEditor.checksumOffsetLabel')}: {template.checksumOffset}</span>
          </button>
          <button
            type="button"
            className="protocol-structure-summary__segment"
            style={summaryColor(template.colorFooter)}
            aria-label={`${t('protocolEditor.color.footer')}: ${footer}`}
            onClick={() => focusField(`protocol-footer-${template.id}`)}
          >
            <span className="protocol-structure-summary__segment-label">{t('protocolEditor.color.footer')}</span>
            <span className="protocol-structure-summary__segment-value">{footer}</span>
          </button>
        </div>
      </div>

      <div className="protocol-template-editor__section">
        <div className="protocol-template-editor__section-title">{t('protocolEditor.section.frameStructure')}</div>
        <div className="protocol-template-editor__row">
          <label className="protocol-template-editor__label" htmlFor={`protocol-header-${template.id}`}>{t('protocolEditor.headerLabel')}</label>
          <input
            id={`protocol-header-${template.id}`}
            className="input protocol-template-editor__field"
            value={template.headerBytes}
            onChange={e => onChange({ headerBytes: e.target.value })}
            placeholder={t('protocolEditor.headerPlaceholder')}
          />
        </div>
        <div className="protocol-template-editor__row">
          <label className="protocol-template-editor__label" htmlFor={`protocol-length-offset-${template.id}`}>{t('protocolEditor.lengthOffsetLabel')}</label>
          <NumericInput
            id={`protocol-length-offset-${template.id}`}
            className="input protocol-template-editor__number"
            value={template.lengthFieldOffset}
            onCommit={value => onChange({ lengthFieldOffset: value })}
            min={0}
            max={65535}
            step={1}
          />
          <label className="protocol-template-editor__label" htmlFor={`protocol-length-size-${template.id}`}>{t('protocolEditor.lengthFieldSizeLabel')}</label>
          <select
            id={`protocol-length-size-${template.id}`}
            className="select protocol-template-editor__select"
            value={template.lengthFieldSize}
            onChange={e => onChange({ lengthFieldSize: Number(e.target.value) as 1 | 2 })}
          >
            <option value={1}>{t('protocolEditor.lengthFieldSize.1byte')}</option>
            <option value={2}>{t('protocolEditor.lengthFieldSize.2bytes')}</option>
          </select>
        </div>
        <div className="protocol-template-editor__row">
          <label className="protocol-template-editor__label" htmlFor={`protocol-length-endian-${template.id}`}>{t('protocolEditor.lengthEndianLabel')}</label>
          <select
            id={`protocol-length-endian-${template.id}`}
            className="select protocol-template-editor__select protocol-template-editor__select--wide"
            value={template.lengthEndian}
            onChange={e => onChange({ lengthEndian: e.target.value as 'little' | 'big' })}
          >
            <option value="little">{t('protocolEditor.lengthEndian.little')}</option>
            <option value="big">{t('protocolEditor.lengthEndian.big')}</option>
          </select>
          <label className="protocol-template-editor__label" htmlFor={`protocol-length-adjust-${template.id}`}>{t('protocolEditor.lengthAdjustLabel')}</label>
          <NumericInput
            id={`protocol-length-adjust-${template.id}`}
            className="input protocol-template-editor__number"
            value={template.lengthAdjust}
            onCommit={value => onChange({ lengthAdjust: value })}
            min={-65535}
            max={65535}
            step={1}
          />
        </div>
        <div className="protocol-template-editor__row">
          <label className="protocol-template-editor__label" htmlFor={`protocol-footer-${template.id}`}>{t('protocolEditor.footerLabel')}</label>
          <input
            id={`protocol-footer-${template.id}`}
            className="input protocol-template-editor__field"
            value={template.footerBytes}
            onChange={e => onChange({ footerBytes: e.target.value })}
            placeholder={t('protocolEditor.footerPlaceholder')}
          />
        </div>
      </div>

      <div className="protocol-template-editor__section">
        <div className="protocol-template-editor__section-title">{t('protocolEditor.section.checksum')}</div>
        <div className="protocol-template-editor__row">
          <label className="protocol-template-editor__label" htmlFor={`protocol-checksum-algorithm-${template.id}`}>{t('protocolEditor.checksumAlgorithmLabel')}</label>
          <select
            id={`protocol-checksum-algorithm-${template.id}`}
            className="select protocol-template-editor__select protocol-template-editor__select--wide"
            value={template.checksumAlgorithm}
            onChange={e => onChange({ checksumAlgorithm: e.target.value as ProtocolTemplate['checksumAlgorithm'] })}
          >
            <option value="none">{t('protocolEditor.checksumAlgorithm.none')}</option>
            <option value="sum8">Sum8</option>
            <option value="xor">XOR</option>
            <option value="crc8">CRC-8</option>
          </select>
          <label className="protocol-template-editor__label" htmlFor={`protocol-checksum-offset-${template.id}`}>{t('protocolEditor.checksumOffsetLabel')}</label>
          <NumericInput
            id={`protocol-checksum-offset-${template.id}`}
            className="input protocol-template-editor__number"
            value={template.checksumOffset}
            onCommit={value => onChange({ checksumOffset: value })}
            min={0}
            max={65535}
            step={1}
          />
          <span className="protocol-template-editor__hint">{t('protocolEditor.checksumOffsetHint')}</span>
        </div>
      </div>

      <div className="protocol-template-editor__section">
        <div className="protocol-template-editor__section-title">{t('protocolEditor.section.fieldColors')}</div>
        <div className="protocol-template-editor__colors">
          <label className="protocol-template-editor__color-field">
            {t('protocolEditor.color.header')}
            <input className="protocol-template-editor__color" type="color" value={safeCssColor(template.colorHeader) ?? '#000000'} onChange={e => onChange({ colorHeader: e.target.value })} />
          </label>
          <label className="protocol-template-editor__color-field">
            {t('protocolEditor.color.length')}
            <input className="protocol-template-editor__color" type="color" value={safeCssColor(template.colorLength) ?? '#000000'} onChange={e => onChange({ colorLength: e.target.value })} />
          </label>
          <label className="protocol-template-editor__color-field">
            {t('protocolEditor.color.payload')}
            <input className="protocol-template-editor__color" type="color" value={safeCssColor(template.colorPayload) ?? '#000000'} onChange={e => onChange({ colorPayload: e.target.value })} />
          </label>
          <label className="protocol-template-editor__color-field">
            {t('protocolEditor.color.checksum')}
            <input className="protocol-template-editor__color" type="color" value={safeCssColor(template.colorChecksum) ?? '#000000'} onChange={e => onChange({ colorChecksum: e.target.value })} />
          </label>
          <label className="protocol-template-editor__color-field">
            {t('protocolEditor.color.footer')}
            <input className="protocol-template-editor__color" type="color" value={safeCssColor(template.colorFooter) ?? '#000000'} onChange={e => onChange({ colorFooter: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="protocol-template-editor__actions">
        <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} title={t('protocolEditor.deleteTemplate')}>
          <Trash2 size={14} /> {t('protocolEditor.deleteTemplate')}
        </button>
      </div>
    </div>
  );
};

export default ProtocolTemplateEditor;
