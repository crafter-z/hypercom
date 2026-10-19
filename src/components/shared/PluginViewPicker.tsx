import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, ChevronRight, TerminalSquare, Wrench } from 'lucide-react';
import { useOutsideDismiss } from './useOutsideDismiss';
import { usePluginViewOverlay } from './usePluginViewOverlay';
import type { PluginViewDeclaration, PluginViewPreference } from '../../types/pluginViews';

export interface PluginViewChoice {
  preference: PluginViewPreference;
  declaration: PluginViewDeclaration;
  pluginName: string;
}

interface PickerOption {
  kind: 'raw' | 'choice' | 'fallback';
  key: string;
  label: string;
  meta?: string;
  choice?: PluginViewChoice;
  disabled?: boolean;
}

interface PluginViewPickerProps {
  choices: PluginViewChoice[];
  value?: string;
  triggerLabel: string;
  title: string;
  ariaLabel: string;
  onSelect: (choice: PluginViewChoice | null) => void;
  rawOption?: { key: string; label: string };
  fallbackOption?: { key: string; label: string };
  variant?: 'launcher' | 'toolbar';
  className?: string;
  showCount?: boolean;
  triggerIcon?: React.ReactNode;
}

function choiceKey(choice: PluginViewChoice): string {
  return `${choice.preference.pluginId}/${choice.preference.viewId}`;
}

const PluginViewPicker: React.FC<PluginViewPickerProps> = ({
  choices,
  value,
  triggerLabel,
  title,
  ariaLabel,
  onSelect,
  rawOption,
  fallbackOption,
  variant = 'toolbar',
  className = '',
  showCount = false,
  triggerIcon,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overlayReady = usePluginViewOverlay(open, panelRef);

  const selectedChoice = choices.find(choice => choiceKey(choice) === value);
  const options: PickerOption[] = [
    ...(rawOption ? [{ kind: 'raw' as const, key: rawOption.key, label: rawOption.label }] : []),
    ...(fallbackOption && !selectedChoice && value === fallbackOption.key
      ? [{ kind: 'fallback' as const, key: fallbackOption.key, label: fallbackOption.label, disabled: true }]
      : []),
    ...choices.map(choice => ({
      kind: 'choice' as const,
      key: choiceKey(choice),
      label: choice.declaration.label,
      meta: choice.pluginName,
      choice,
    })),
  ];
  const selectableIndices = options.reduce<number[]>((indices, option, index) => {
    if (!option.disabled) indices.push(index);
    return indices;
  }, []);
  const selectedIndex = options.findIndex(option => option.key === value);
  const currentLabel = selectedChoice?.declaration.label
    ?? (rawOption && value === rawOption.key ? rawOption.label : undefined)
    ?? (fallbackOption && value === fallbackOption.key ? fallbackOption.label : undefined)
    ?? triggerLabel;

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);
  useOutsideDismiss(rootRef, close, open, panelRef);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    let left = variant === 'launcher' ? triggerRect.right - panelRect.width : triggerRect.left;
    let top = triggerRect.bottom + 6;
    if (left + panelRect.width > window.innerWidth - margin) left = window.innerWidth - panelRect.width - margin;
    if (left < margin) left = margin;
    if (top + panelRect.height > window.innerHeight - margin) top = triggerRect.top - panelRect.height - 6;
    if (top < margin) top = margin;
    setPosition({ left, top });
  }, [variant]);

  useEffect(() => {
    if (!open) return;
    const firstIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : selectableIndices[0] ?? 0;
    setActiveIndex(firstIndex);
  }, [open, selectedIndex, selectableIndices.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = requestAnimationFrame(() => {
      optionRefs.current[activeIndex]?.focus({ preventScroll: true });
      updatePosition();
    });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [activeIndex, open, overlayReady, updatePosition]);

  const chooseIndex = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onSelect(option.kind === 'choice' ? option.choice! : null);
    close();
  };

  const moveActive = (direction: 1 | -1) => {
    if (selectableIndices.length === 0) return;
    const currentPosition = selectableIndices.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? 0
      : (currentPosition + direction + selectableIndices.length) % selectableIndices.length;
    setActiveIndex(selectableIndices[nextPosition]);
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(selectableIndices[selectableIndices.length - 1] ?? 0);
    }
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(selectableIndices[0] ?? 0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(selectableIndices[selectableIndices.length - 1] ?? 0);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseIndex(activeIndex);
    }
  };

  return (
    <div ref={rootRef} className={`plugin-view-picker plugin-view-picker-${variant} ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`plugin-view-picker-trigger${open ? ' open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(current => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        {triggerIcon ?? ((rawOption && value === rawOption.key) ? <TerminalSquare size={14} className="plugin-view-picker-trigger-icon" /> : <Wrench size={14} className="plugin-view-picker-trigger-icon" />)}
        {variant === 'toolbar' ? (
          <span className="plugin-view-picker-value">{currentLabel}</span>
        ) : null}
        {showCount && <span className="plugin-view-picker-count">{choices.length}</span>}
        {variant !== 'launcher' && <ChevronDown size={13} className="plugin-view-picker-chevron" />}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className="plugin-view-picker-panel animate-fade-in"
          style={{ left: position.left, top: position.top, visibility: overlayReady ? 'visible' : 'hidden' }}
          role="listbox"
          aria-label={title}
          onKeyDown={handlePanelKeyDown}
        >
          <div className="plugin-view-picker-heading">
            <span className="eyebrow">{t('pluginViews.openToolShort')}</span>
            <strong>{title}</strong>
            {variant === 'launcher' && <span className="plugin-view-picker-heading-hint">{t('pluginViews.pickerWorkspaceHint')}</span>}
          </div>
          <div className="plugin-view-picker-list">
            {rawOption && (
              <div className="plugin-view-picker-section">
                <div className="plugin-view-picker-section-label">{triggerLabel}</div>
                {options.filter(option => option.kind === 'raw').map(option => {
                  const optionIndex = options.indexOf(option);
                  const active = optionIndex === activeIndex;
                  const selected = option.key === value;
                  return (
                    <button
                      key={option.key}
                      ref={element => { optionRefs.current[optionIndex] = element; }}
                      type="button"
                      className={`plugin-view-picker-option${active ? ' active' : ''}${selected ? ' selected' : ''}`}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIndex(optionIndex)}
                      onClick={() => chooseIndex(optionIndex)}
                    >
                      <span className="plugin-view-picker-option-mark">{selected && <Check size={13} />}</span>
                      <span className="plugin-view-picker-option-copy">
                        <span className="plugin-view-picker-option-label">{option.label}</span>
                        <span className="plugin-view-picker-option-meta">{t('pluginViews.pickerHostTerminal')}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {options.some(option => option.kind === 'fallback' || option.kind === 'choice') && (
              <div className="plugin-view-picker-section">
                <div className="plugin-view-picker-section-label">{t('pluginViews.view')}</div>
                {options.filter(option => option.kind === 'fallback' || option.kind === 'choice').map(option => {
                  const optionIndex = options.indexOf(option);
                  const active = optionIndex === activeIndex;
                  const selected = option.key === value;
                  if (option.kind === 'fallback') {
                    return (
                      <button
                        key={option.key}
                        ref={element => { optionRefs.current[optionIndex] = element; }}
                        type="button"
                        className={`plugin-view-picker-option unavailable${active ? ' active' : ''}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled="true"
                        disabled
                      >
                        <span className="plugin-view-picker-option-mark"><AlertTriangle size={13} /></span>
                        <span className="plugin-view-picker-option-copy">
                          <span className="plugin-view-picker-option-label">{option.label}</span>
                          <span className="plugin-view-picker-option-meta">{t('pluginViews.pickerUnavailable')}</span>
                        </span>
                      </button>
                    );
                  }
                  return (
                    <button
                      key={option.key}
                      ref={element => { optionRefs.current[optionIndex] = element; }}
                      type="button"
                      className={`plugin-view-picker-option${active ? ' active' : ''}${selected ? ' selected' : ''}`}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIndex(optionIndex)}
                      onClick={() => chooseIndex(optionIndex)}
                    >
                      <span className="plugin-view-picker-option-mark">{selected && <Check size={13} />}</span>
                      <span className="plugin-view-picker-option-copy">
                        <span className="plugin-view-picker-option-label">{option.label}</span>
                        <span className="plugin-view-picker-option-meta">{option.meta}</span>
                      </span>
                      <ChevronRight size={13} className="plugin-view-picker-option-arrow" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {options.length === 0 && (
            <div className="plugin-view-picker-empty">{t('pluginViews.pickerEmpty')}</div>
          )}
        </div>
      , document.body)}
    </div>
  );
};

export default PluginViewPicker;