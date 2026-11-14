import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { popoutEventService } from '../../services/tauri';
import { useConfigPersistence, isOrdinaryConfigDirty, discardOrdinaryConfigDraft } from '../../hooks/useConfigPersistence';
import { getCommittedUpdateMode, runAutoCheck } from '../../utils/updateService';
import { applyUiScale } from '../../utils/uiScale';
import { listDirtyEntityKinds, subscribeEntityEditor } from '../../utils/entityEditor';
import { registerEditorParticipant, requestEditorLeave } from '../../utils/editorLeave';
import {
  Settings, FileText, HardDrive, Monitor, Palette, Send, Code2, Wrench, Zap, Plug, X, Maximize2, Minimize2,
} from 'lucide-react';
import GeneralSettings from './pages/GeneralSettings';
import LogSettings from './pages/LogSettings';
import BackupSettings from './pages/BackupSettings';
import DisplaySettings from './pages/DisplaySettings';
import HighlightSettings from './pages/HighlightSettings';
import CommandSettings from './pages/CommandSettings';
import ProtocolSettings from './pages/ProtocolSettings';
import ToolSettings from './pages/ToolSettings';
import TriggerSettings from './pages/TriggerSettings';
import PluginSettings from './pages/PluginSettings';
import Modal from '../shared/Modal';

import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
interface NavItem {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { id: 'general', labelKey: 'configModal.nav.general', icon: <Settings size={16} /> },
  { id: 'log', labelKey: 'configModal.nav.log', icon: <FileText size={16} /> },
  { id: 'backup', labelKey: 'configModal.nav.backup', icon: <HardDrive size={16} /> },
  { id: 'display', labelKey: 'configModal.nav.display', icon: <Monitor size={16} /> },
  { id: 'highlight', labelKey: 'configModal.nav.highlight', icon: <Palette size={16} /> },
  { id: 'commands', labelKey: 'configModal.nav.commands', icon: <Send size={16} /> },
  { id: 'protocol', labelKey: 'configModal.nav.protocol', icon: <Code2 size={16} /> },
  { id: 'tools', labelKey: 'configModal.nav.tools', icon: <Wrench size={16} /> },
  { id: 'triggers', labelKey: 'config.triggerSettings', icon: <Zap size={16} /> },
  { id: 'plugins', labelKey: 'configModal.nav.plugins', icon: <Plug size={16} /> },
];

const navTabId = (id: string) => `config-tab-${id}`;
const navPanelId = (id: string) => `config-tabpanel-${id}`;
const CONFIG_TITLE_ID = 'config-modal-title';

const ConfigModal: React.FC = () => {
  const { t } = useTranslation();
  const isConfigOpen = useSystemStore((s) => s.ui.isConfigOpen);
  const configActiveTab = useSystemStore((s) => s.ui.configActiveTab);
  const isHotkeyHelpOpen = useSystemStore((s) => s.ui.isHotkeyHelpOpen);
  const overlayReady = usePluginViewOverlay(isConfigOpen);
  const toggleConfigModal = useSystemStore((s) => s.toggleConfigModal);
  const setConfigActiveTab = useSystemStore((s) => s.setConfigActiveTab);
  const { saveConfig } = useConfigPersistence();
  // Overlay click must only close on a click whose press *and* release were both
  // on the overlay: dragging a text selection that starts inside the dialog and
  // ends over the overlay synthesises a click there, which used to dismiss the
  // dialog mid-selection.
  const dialogRef = useRef<HTMLDivElement>(null);
  const mouseDownInsideDialogRef = useRef(false);
  const navRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeNavRef = useRef<HTMLButtonElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!isConfigOpen) setExpanded(false); }, [isConfigOpen]);
  const [dirty, setDirty] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const savingRef = useRef(false);
  const sessionRef = useRef(0);
  const mountedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useSystemStore.subscribe((state, previous) => {
      if (state.ui.isConfigOpen === previous.ui.isConfigOpen) return;
      sessionRef.current++;
    });
    return () => {
      mountedRef.current = false;
      sessionRef.current++;
      unsubscribe();
    };
  }, []);

  useEffect(() => registerEditorParticipant('config-ordinary', {
    isDirty: isOrdinaryConfigDirty,
    save: () => saveConfig(),
    discard: () => { discardOrdinaryConfigDraft(); },
    label: () => 'configModal.title',
  }), [saveConfig]);
  useEffect(() => {
    if (contentRef.current) contentRef.current.inert = saving;
  }, [saving, isConfigOpen, overlayReady]);

  // Each settings page owns the same scroll container. Reset it when the user
  // switches pages (or reopens the modal) so a long page can't leave the next
  // page scrolled into its middle.
  useEffect(() => {
    if (isConfigOpen && contentRef.current) contentRef.current.scrollTop = 0;
  }, [configActiveTab, isConfigOpen]);

  // Track where the press started so a drag that ends over the overlay does not
  // count as an overlay click. Capture phase sees the press before any handler
  // in the content can stop it.
  useEffect(() => {
    if (!isConfigOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      mouseDownInsideDialogRef.current =
        dialogRef.current?.contains(event.target as Node) ?? false;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isConfigOpen]);

  const handleCancel = useCallback(() => {
    if (savingRef.current) return;
    void requestEditorLeave(['config-ordinary', 'entity-editor']).then(allowed => {
      if (!allowed || savingRef.current) return;
      toggleConfigModal(false);
    });
  }, [toggleConfigModal]);

  const handleOverlayClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Clicks on dialog content bubble here; only an overlay-targeted click can
    // dismiss. Keyboard activation of a nav button has no pointer press, so the
    // press guard alone would not be enough.
    if (event.target !== event.currentTarget) return;
    if (mouseDownInsideDialogRef.current) {
      mouseDownInsideDialogRef.current = false;
      return;
    }
    handleCancel();
  }, [handleCancel]);

  const focusNavItem = useCallback((index: number) => {
    const count = navItems.length;
    navRefs.current[((index % count) + count) % count]?.focus();
  }, []);

  const handleNavKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusNavItem(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusNavItem(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusNavItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusNavItem(navItems.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!savingRef.current) setConfigActiveTab(navItems[index].id);
        break;
      default:
        break;
    }
  }, [focusNavItem, setConfigActiveTab]);

  useEffect(() => {
    if (!isConfigOpen) return undefined;
    const refresh = () => setDirty(isOrdinaryConfigDirty() || listDirtyEntityKinds().length > 0);
    refresh();
    const unsubscribeConfig = useAppStore.subscribe(refresh);
    const unsubscribeEntities = subscribeEntityEditor(refresh);
    return () => { unsubscribeConfig(); unsubscribeEntities(); };
  }, [isConfigOpen, configActiveTab]);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    const session = sessionRef.current;
    const current = useAppStore.getState().config;
    const modeChanged = getCommittedUpdateMode() !== current.updateCheckMode;
    try {
      if (!(await saveConfig())) { setSaveFailed(true); return; }
      if (!mountedRef.current || session !== sessionRef.current || !useSystemStore.getState().ui.isConfigOpen) return;
      if (isOrdinaryConfigDirty() || listDirtyEntityKinds().length > 0) { setSaveFailed(true); return; }
      const latest = useAppStore.getState().config;
      void applyUiScale(latest.uiScalePercent);
      void popoutEventService.emitUiScaleChanged(latest.uiScalePercent)
        .catch((error) => console.debug('[ConfigModal] Failed to broadcast UI scale:', error));

      toggleConfigModal(false);
      if (modeChanged && getCommittedUpdateMode() !== 'none') void runAutoCheck();
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const renderContent = () => {
    switch (configActiveTab) {
      case 'general': return <GeneralSettings />;
      case 'log': return <LogSettings />;
      case 'backup': return <BackupSettings />;
      case 'display': return <DisplaySettings />;
      case 'highlight': return <HighlightSettings />;
      case 'commands': return <CommandSettings />;
      case 'protocol': return <ProtocolSettings />;
      case 'tools': return <ToolSettings />;
      case 'triggers': return <TriggerSettings />;
      case 'plugins': return <PluginSettings />;
      default: return <GeneralSettings />;
    }
  };

  const activeNav = navItems.find(n => n.id === configActiveTab);

  return (
    <Modal
      open={isConfigOpen && overlayReady}
      onClose={handleCancel}
      disableEscape={isHotkeyHelpOpen}
      labelledBy={CONFIG_TITLE_ID}
      overlayClassName="animate-fade-in"
      dialogClassName={`animate-slide-up${expanded ? ' modal-dialog-expanded' : ''}`}
      dialogRef={dialogRef}
      initialFocusRef={activeNavRef}
      onOverlayClick={handleOverlayClick}
    >
      <div className="modal-nav">
        <div className="modal-nav-header">
          <h2 className="modal-nav-title" id={CONFIG_TITLE_ID}>{t('configModal.title')}</h2>
        </div>
        <div
          className="modal-nav-list"
          role="tablist"
          aria-label={t('configModal.title')}
          aria-orientation="vertical"
        >
          {navItems.map((item, index) => {
            const selected = configActiveTab === item.id;
            return (
              <button
                key={item.id}
                ref={(element) => {
                  navRefs.current[index] = element;
                  if (selected) activeNavRef.current = element;
                }}
                type="button"
                role="tab"
                id={navTabId(item.id)}
                aria-selected={selected}
                aria-controls={selected ? navPanelId(item.id) : undefined}
                tabIndex={selected ? 0 : -1}
                className={`modal-nav-item${selected ? ' active' : ''}`}
                onClick={() => { if (!savingRef.current) setConfigActiveTab(item.id); }}
                onKeyDown={(event) => handleNavKeyDown(event, index)}
              >
                <span className="modal-nav-icon">{item.icon}</span>
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="modal-content-area">
        <div className="modal-content-header">
          <div className="modal-content-heading">
            <span className="modal-content-title">
              {activeNav ? t(activeNav.labelKey) : ''}
            </span>
          </div>
          <div className="modal-header-actions">
            <button type="button" className="btn btn-icon" onClick={() => setExpanded(value => !value)}
              aria-pressed={expanded} title={t(expanded ? 'configModal.compact' : 'configModal.expand')}
              aria-label={t(expanded ? 'configModal.compact' : 'configModal.expand')}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button className="btn btn-icon" disabled={saving} onClick={handleCancel} title={t('configModal.close')} aria-label={t('configModal.close')}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div
          className="modal-content-body"
          id={navPanelId(configActiveTab)}
          role="tabpanel"
          aria-labelledby={navTabId(configActiveTab)}
          ref={contentRef}
          aria-busy={saving}
          onClickCapture={(event) => { if (savingRef.current) { event.preventDefault(); event.stopPropagation(); } }}
          onChangeCapture={(event) => { if (savingRef.current) event.stopPropagation(); }}>
          {renderContent()}
        </div>

        {saveFailed && (
          <div className="modal-save-error" role="alert">{t('configModal.saveFailed')}</div>
        )}
        <div className="modal-content-footer">
          <span className="modal-save-scope" title={t('configModal.scope.globalSaveHint')}>
            {t('configModal.scope.allDrafts')}
          </span>
          {dirty && !saving && <span className="modal-dirty-hint">{t('configModal.unsaved')}</span>}
          <button className="btn" disabled={saving} onClick={handleCancel}>{t('configModal.cancel')}</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{t('configModal.globalSave')}</button>
        </div>
      </div>
    </Modal>
  );
};

export default ConfigModal;
