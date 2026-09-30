import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

/** Rack filter — matches port id and alias (see Sidebar's `filteredPorts`). */
const SearchBox: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="sidebar-search">
      <Search size={13} className="sidebar-search-icon" />
      <input
        className="toolbar-input sidebar-search-input"
        placeholder={t('sidebar.search.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="sidebar-search-clear" onClick={() => onChange('')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
};

export default SearchBox;
