import React from 'react';
import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openHelpCenter } from '../../utils/help/helpNavigation';

interface HelpContextButtonProps {
  articleId: string;
  anchor?: string;
  className?: string;
}

/** Small, read-only contextual entry point shared by settings and other surfaces. */
const HelpContextButton: React.FC<HelpContextButtonProps> = ({ articleId, anchor, className = '' }) => {
  const { t } = useTranslation();
  const label = t('help.openArticle');
  return (
    <button
      type="button"
      className={`btn btn-icon ${className}`.trim()}
      title={label}
      aria-label={label}
      onClick={() => {
        void openHelpCenter({ articleId, anchor }).catch(error => console.debug('[HelpContextButton] open help failed:', error));
      }}
    >
      <BookOpen size={14} aria-hidden="true" />
    </button>
  );
};

export default HelpContextButton;
