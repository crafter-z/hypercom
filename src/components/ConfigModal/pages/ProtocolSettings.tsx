import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import { notifyError } from '../../../stores/useToastStore';
import type { ProtocolTemplateInfo } from '../../../services/tauri';
import type { ProtocolTemplate } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import ProtocolTemplateEditor from '../editors/ProtocolTemplateEditor';

/** Map backend snake_case ProtocolTemplateInfo to frontend camelCase ProtocolTemplate */
function mapInfo(s: ProtocolTemplateInfo): ProtocolTemplate {
  return {
    id: s.id,
    name: s.name,
    isEnabled: s.is_enabled,
    headerBytes: s.header_bytes,
    lengthFieldOffset: s.length_field_offset,
    lengthFieldSize: s.length_field_size as 1 | 2,
    lengthEndian: s.length_endian as 'little' | 'big',
    lengthAdjust: s.length_adjust,
    checksumAlgorithm: s.checksum_algorithm as ProtocolTemplate['checksumAlgorithm'],
    checksumOffset: s.checksum_offset,
    footerBytes: s.footer_bytes,
    colorHeader: s.color_header,
    colorLength: s.color_length,
    colorPayload: s.color_payload,
    colorChecksum: s.color_checksum,
    colorFooter: s.color_footer,
  };
}

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
        useRuleStore.getState().setProtocolTemplates(templates.map(mapInfo));
      }
    }).catch((e) => console.debug('[ConfigModal] loadProtocolTemplates failed:', e));
  }, []);

  const handleRemoveSet = async (setId: string) => {
    removeProtocolTemplate(setId);
    try { await storageService.deleteProtocolTemplate(setId); } catch (e) { console.error('Failed to delete protocol template from DB:', e); notifyError(e); }
  };

  const handleSaveSet = async (setId: string) => {
    const template = useRuleStore.getState().protocolTemplates.find(t => t.id === setId);
    if (!template) return;
    try {
      await storageService.saveProtocolTemplate({
        id: template.id,
        name: template.name,
        is_enabled: template.isEnabled,
        header_bytes: template.headerBytes,
        length_field_offset: template.lengthFieldOffset,
        length_field_size: template.lengthFieldSize,
        length_endian: template.lengthEndian,
        length_adjust: template.lengthAdjust,
        checksum_algorithm: template.checksumAlgorithm,
        checksum_offset: template.checksumOffset,
        footer_bytes: template.footerBytes,
        color_header: template.colorHeader,
        color_length: template.colorLength,
        color_payload: template.colorPayload,
        color_checksum: template.colorChecksum,
        color_footer: template.colorFooter,
      });
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
