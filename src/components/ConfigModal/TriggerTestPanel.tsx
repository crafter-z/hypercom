import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SerialPort, TriggerRule } from '../../types';
import { evaluateTriggers, type TriggerAction } from '../../utils/triggerEngine';
import { bytesToSpacedHex } from '../../utils/hexFormat';
import { hexToString, isValidHexInput, parseHexBytes } from '../../utils/hexUtils';
import '../../styles/rule-preview.css';

export interface TriggerTestPanelProps {
  /** Current session draft rules. The panel never mutates this array. */
  rules: readonly TriggerRule[];
  /** The expanded/selected draft rule, when the host has one. */
  selectedRule?: TriggerRule | null;
  /** Optional id form for hosts that keep the selected entity separately. */
  selectedRuleId?: string | null;
  /** Currently enumerated ports used only to choose the test scope. */
  ports: readonly SerialPort[];
}

type TriggerSampleMode = 'text' | 'hex';

interface Evaluation {
  actions: TriggerAction[];
  content: string;
  rawData: number[];
  invalidHex: boolean;
}

const panelStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 8,
  border: '1px solid var(--border-color)',
  borderRadius: 4,
};

const resultStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 0',
  borderTop: '1px solid var(--border-color)',
};

const mutedStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 11,
};

const errorStyle: React.CSSProperties = {
  color: 'var(--danger-color, #f07178)',
  fontSize: 11,
};

/**
 * Render-only trigger rule test surface.
 *
 * This deliberately evaluates the supplied draft snapshot instead of reading
 * either Zustand store. It never invokes a serial service and has no save
 * callback, so testing an unsaved rule cannot affect runtime rules, TX echo,
 * traffic statistics, history, or configuration persistence.
 */
const TriggerTestPanel: React.FC<TriggerTestPanelProps> = ({
  rules,
  selectedRule,
  selectedRuleId,
  ports,
}) => {
  const { t } = useTranslation();
  const selectedId = selectedRule?.id ?? selectedRuleId ?? null;
  const effectiveSelectedRule = selectedId
    ? rules.find((rule) => rule.id === selectedId) ?? selectedRule ?? null
    : selectedRule ?? null;
  const rulesToEvaluate = effectiveSelectedRule ? [effectiveSelectedRule] : [...rules];

  const [sampleMode, setSampleMode] = useState<TriggerSampleMode>(
    effectiveSelectedRule?.matchType === 'hex' ? 'hex' : 'text',
  );
  const [sampleText, setSampleText] = useState('');
  const [sampleHex, setSampleHex] = useState('');
  const [testPortId, setTestPortId] = useState('');

  // A selected scoped rule is the least surprising initial test target. Keep a
  // user-selected port when it remains available, but clear stale enumerations.
  useEffect(() => {
    const preferred = effectiveSelectedRule?.portId ?? '';
    if (preferred && ports.some((port) => port.id === preferred)) {
      setTestPortId(preferred);
      return;
    }
    setTestPortId((current) => current && ports.some((port) => port.id === current) ? current : '');
  }, [effectiveSelectedRule?.id, effectiveSelectedRule?.portId, ports]);

  useEffect(() => {
    setSampleMode(effectiveSelectedRule?.matchType === 'hex' ? 'hex' : 'text');
  }, [effectiveSelectedRule?.id, effectiveSelectedRule?.matchType]);

  const evaluation = useMemo<Evaluation>(() => {
    const value = sampleMode === 'hex' ? sampleHex : sampleText;
    if (sampleMode === 'hex') {
      const valid = isValidHexInput(value);
      if (!valid) return { actions: [], content: '', rawData: [], invalidHex: true };
      const rawData = parseHexBytes(value);
      return {
        actions: value.trim()
          ? evaluateTriggers(hexToString(value), rawData, rulesToEvaluate, testPortId || undefined)
          : [],
        content: hexToString(value),
        rawData,
        invalidHex: false,
      };
    }

    const rawData = Array.from(new TextEncoder().encode(value));
    return {
      actions: value
        ? evaluateTriggers(value, rawData, rulesToEvaluate, testPortId || undefined)
        : [],
      content: value,
      rawData,
      invalidHex: false,
    };
  }, [sampleHex, sampleMode, sampleText, rulesToEvaluate, testPortId]);

  const actionPreview = (action: TriggerAction): string => {
    const rule = action.rule;
    if (rule.actionType === 'alert') {
      return rule.actionContent.trim() || t('trigger.alertMessage', {
        port: testPortId || t('trigger.portId.all'),
        rule: rule.name,
      });
    }

    if (rule.actionIsHex) {
      if (!isValidHexInput(rule.actionContent)) return t('trigger.invalidHexAction', { value: rule.actionContent });
      const bytes = parseHexBytes(rule.actionContent);
      return t('trigger.hexActionPreview', { value: bytesToSpacedHex(bytes) });
    }
    return rule.actionContent || t('trigger.emptyAction');
  };

  return (
    <section className="trigger-test-panel" style={panelStyle} aria-label={t('trigger.testPreview')}>
      <div className="editor-page-heading" style={{ marginBottom: 6 }}>
        <h4 className="config-section-title" style={{ margin: 0 }}>{t('trigger.testPreview')}</h4>
        <span style={mutedStyle}>
          {effectiveSelectedRule ? t('trigger.testPreviewFor', { name: effectiveSelectedRule.name }) : t('trigger.testAllRules')}
        </span>
      </div>

      <div className="rule-settings-editor">
        <div className="rule-settings-row">
          <label className="rule-settings-label" htmlFor="trigger-test-mode">{t('trigger.sampleFormat')}</label>
          <select
            id="trigger-test-mode"
            className="input rule-settings-field"
            value={sampleMode}
            onChange={(event) => setSampleMode(event.target.value as TriggerSampleMode)}
          >
            <option value="text">{t('trigger.testMode.text')}</option>
            <option value="hex">{t('trigger.matchType.hex')}</option>
          </select>
        </div>

        <div className="rule-settings-row">
          <label className="rule-settings-label" htmlFor="trigger-test-port">{t('trigger.portId')}</label>
          <select
            id="trigger-test-port"
            className="input rule-settings-field"
            value={testPortId}
            onChange={(event) => setTestPortId(event.target.value)}
          >
            <option value="">{t('trigger.portId.all')}</option>
            {ports.map((port) => (
              <option key={port.id} value={port.id}>
                {port.alias || port.name} ({port.id})
              </option>
            ))}
          </select>
        </div>

        <div className="rule-settings-row" style={{ alignItems: 'flex-start' }}>
          <label className="rule-settings-label" htmlFor="trigger-test-input">
            {sampleMode === 'hex' ? t('trigger.matchType.hex') : t('trigger.sampleText')}
          </label>
          <textarea
            id="trigger-test-input"
            className="input rule-settings-field rule-settings-terminal"
            rows={3}
            value={sampleMode === 'hex' ? sampleHex : sampleText}
            placeholder={sampleMode === 'hex' ? t('trigger.sampleHexPlaceholder') : t('trigger.sampleTextPlaceholder')}
            onChange={(event) => {
              if (sampleMode === 'hex') setSampleHex(event.target.value);
              else setSampleText(event.target.value);
            }}
          />
        </div>
      </div>

      {sampleMode === 'hex' && evaluation.invalidHex && (
        <div role="alert" style={errorStyle}>{t('trigger.invalidHexInput')}</div>
      )}
      {sampleMode === 'hex' && !evaluation.invalidHex && evaluation.rawData.length > 0 && (
        <div className="rule-settings-note">
          {t('trigger.rawBytes')}<code className="rule-settings-terminal">{bytesToSpacedHex(evaluation.rawData)}</code>
        </div>
      )}

      <div className="rule-settings-note" style={{ marginTop: 6 }}>
        {t('trigger.testPortNote', { port: testPortId || t('trigger.portId.all') })}
      </div>

      <div style={{ marginTop: 8 }}>
        <div className="config-section-title" style={{ fontSize: 12, marginBottom: 4 }}>{t('trigger.testResult')}</div>
        {evaluation.actions.length === 0 ? (
          <div className="config-placeholder" style={{ padding: '6px 0' }}>
            {evaluation.invalidHex ? t('trigger.enterValidHex') : t('trigger.noMatch')}
          </div>
        ) : (
          evaluation.actions.map((action) => (
            <div className="trigger-test-result" style={resultStyle} key={action.rule.id}>
              <div>
                <strong>{action.rule.name}</strong>
                <span style={mutedStyle}> · {t(`trigger.matchType.${action.rule.matchType}`)} → {t(`trigger.actionType.${action.rule.actionType}`)}</span>
              </div>
              <div className="rule-settings-note">
                {t('trigger.matchedContent')}<code className="rule-settings-terminal">{action.matchedText || t('trigger.emptyMatch')}</code>
              </div>
              <div className="rule-settings-note">
                {t('trigger.actionPreview')}<code className="rule-settings-terminal">{actionPreview(action)}</code>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
};

export default TriggerTestPanel;
export { TriggerTestPanel };
