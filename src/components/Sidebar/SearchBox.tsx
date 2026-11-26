import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

/** Rack filter — matches port id, alias, manufacturer, and product (see Sidebar's `filteredPorts`). */
const SearchBox: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="sidebar-search">
      <Search size={13} className="sidebar-search-icon" aria-hidden="true" />
      <input
        className="toolbar-input sidebar-search-input"
        placeholder={t('sidebar.search.placeholder')}
        aria-label={t('sidebar.search.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (value) {
              onChange('');
            } else {
              e.currentTarget.blur();
            }
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="sidebar-search-clear"
          title={t('sidebar.search.clear')}
          aria-label={t('sidebar.search.clear')}
          onClick={() => onChange('')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};

export default SearchBox;
