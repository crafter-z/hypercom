import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import { notifyError } from '../../../stores/useToastStore';
import type { ProtocolTemplate } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import ProtocolTemplateEditor from '../editors/ProtocolTemplateEditor';

const ProtocolSettings: React.FC = () => {
  const { t } = useTranslation();
  const protocolTemplates = useRuleStore((s) => s.protocolTemplates);
  const addProtocolTemplate = useRuleStore((s) => s.addProtocolTemplate);
  const updateProtocolTemplate = useRuleStore((s) => s.updateProtocolTemplate);
  const removeProtocolTemplate = useRuleStore((s) => s.removeProtocolTemplate);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadProtocolTemplates().then(templates => {
      if (templates.length > 0) {
        useRuleStore.getState().setProtocolTemplates(templates);
      }
    }).catch((e) => {
      console.warn('[ConfigModal] loadProtocolTemplates failed:', e);
      notifyError(e);
    });
  }, []);

  const handleRemoveSet = async (setId: string) => {
    removeProtocolTemplate(setId);
    try { await storageService.deleteProtocolTemplate(setId); } catch (e) { console.error('Failed to delete protocol template:', e); notifyError(e); }
  };

  const handleSaveSet = async (setId: string) => {
    const template = useRuleStore.getState().protocolTemplates.find(t => t.id === setId);
    if (!template) return;
    try {
      await storageService.saveProtocolTemplate(template);
    } catch (err) {
      console.error('Failed to save protocol template:', err);
      notifyError(err);
    }
  };

  const handleAddSet = () => {
    const id = `proto-${Date.now()}`;
    addProtocolTemplate({
      id,
      name: t('protocolSettings.addSet'),
      isEnabled: true,
      headerBytes: '',
      lengthFieldOffset: 0,
      lengthFieldSize: 1,
      lengthEndian: 'little',
      lengthAdjust: 0,
      checksumAlgorithm: 'none',
      checksumOffset: 0,
      footerBytes: '',
      colorHeader: '#4fc3f7',
      colorLength: '#ce9178',
      colorPayload: '#dcdcaa',
      colorChecksum: '#b5cea8',
      colorFooter: '#6a9955',
    });
    setExpandedSetId(id);
  };

  const handleSelect = (id: string) => setExpandedSetId(expandedSetId === id ? null : id);

  return (
    <RuleSetAccordion<ProtocolTemplate>
      title={t('protocolSettings.accordionTitle')}
      description={t('protocolSettings.accordionDescription')}
      addLabel={t('protocolSettings.accordionAddLabel')}
      emptyText={t('protocolSettings.accordionEmptyText')}
      items={protocolTemplates}
      selectedId={expandedSetId}
      onSelect={handleSelect}
      onAdd={handleAddSet}
      onDelete={handleRemoveSet}
      onSave={handleSaveSet}
      onRename={(id, name) => updateProtocolTemplate(id, { name })}
      renderHeaderExtra={(template) => (
        <label className="checkbox-wrapper" style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={template.isEnabled}
            onChange={e => updateProtocolTemplate(template.id, { isEnabled: e.target.checked })}
          /> {t('protocolSettings.enableCheckbox')}
        </label>
      )}
      renderEditor={(template) => (
        <ProtocolTemplateEditor
          template={template}
          onChange={(patch) => updateProtocolTemplate(template.id, patch)}
          onDelete={() => handleRemoveSet(template.id)}
        />
      )}
      countLabel={() => ''}
      addItemLabel=""
      onAddItem={() => {}}
      itemCount={() => 0}
      emptyItemText=""
    />
  );
};

export default ProtocolSettings;
