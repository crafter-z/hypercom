import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProtocolTemplate } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import ProtocolTemplateEditor from '../editors/ProtocolTemplateEditor';
import { useEntityPage } from '../hooks/useEntityPage';

const ProtocolSettings: React.FC = () => {
  const { t } = useTranslation();
  const page = useEntityPage<ProtocolTemplate>({ kind: 'protocolTemplates' });
  const updateProtocolTemplate = page.update;

  const handleAddSet = (beforeId?: string) => {
    page.create({
      id: crypto.randomUUID(),
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
    }, beforeId);
  };

  return (
    <RuleSetAccordion<ProtocolTemplate>
      title={t('protocolSettings.accordionTitle')}
      description={t('protocolSettings.accordionDescription')}
      addLabel={t('protocolSettings.accordionAddLabel')}
      emptyText={t('protocolSettings.accordionEmptyText')}
      items={page.items}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={() => handleAddSet()}
      onInsert={handleAddSet}
      onReorder={page.reorder}
      onDiscard={page.discard}
      dirty={page.dirty}
      isDirty={page.isDirty}
      saving={page.saving}
      error={page.error}
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
