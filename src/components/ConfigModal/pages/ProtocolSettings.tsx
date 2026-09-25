import React from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import type { ProtocolTemplate } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import ProtocolTemplateEditor from '../editors/ProtocolTemplateEditor';
import { useEntityPage } from '../hooks/useEntityPage';

const ProtocolSettings: React.FC = () => {
  const { t } = useTranslation();
  const protocolTemplates = useRuleStore((s) => s.protocolTemplates);
  const updateProtocolTemplate = useRuleStore((s) => s.updateProtocolTemplate);

  const page = useEntityPage<ProtocolTemplate>({
    items: protocolTemplates,
    label: 'ProtocolSettings',
    ops: {
      load: () => storageService.loadProtocolTemplates(),
      read: () => useRuleStore.getState().protocolTemplates,
      replace: (items) => useRuleStore.getState().setProtocolTemplates(items),
      add: (template) => useRuleStore.getState().addProtocolTemplate(template),
      drop: (id) => useRuleStore.getState().removeProtocolTemplate(id),
      persist: (template) => storageService.saveProtocolTemplate(template),
      remove: (id) => storageService.deleteProtocolTemplate(id),
    },
  });

  const handleAddSet = () => {
    page.create({
      id: `proto-${Date.now()}`,
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
  };

  return (
    <RuleSetAccordion<ProtocolTemplate>
      title={t('protocolSettings.accordionTitle')}
      description={t('protocolSettings.accordionDescription')}
      addLabel={t('protocolSettings.accordionAddLabel')}
      emptyText={t('protocolSettings.accordionEmptyText')}
      items={protocolTemplates}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={handleAddSet}
      onDelete={page.remove}
      onSave={page.save}
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
          onDelete={() => page.remove(template.id)}
        />
      )}
    />
  );
};

export default ProtocolSettings;
