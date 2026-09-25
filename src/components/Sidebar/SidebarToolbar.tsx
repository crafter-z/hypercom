import React from 'react';
import { useTranslation } from 'react-i18next';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import {
  Eye, EyeOff, ArrowUpDown, RefreshCw, Play, Square, FlaskConical, Ellipsis, Terminal,
} from 'lucide-react';

interface SidebarToolbarProps {
  showHidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  simulationMode: boolean;
  simulationAvailable: boolean;
  onToggleSimulation: () => void;
  gitBashMode: boolean;
  gitBashAvailable: boolean;
  onToggleGitBash: () => void;
  onOpenAll: () => void;
  onCloseAll: () => void;
  onSortByPort: () => void;
}

/**
 * Sidebar toolbar — the rack's control strip.
 *
 * High-frequency actions stay visible: simulation toggle (dev builds only),
 * refresh, and open/close all (they're the rack's bread and butter). Only
 * low-frequency actions (show hidden, sort) fold into the overflow menu.
 * Group/layout changes persist themselves, so there is no "save layout" button.
 */
const SidebarToolbar: React.FC<SidebarToolbarProps> = ({
  showHidden, onToggleHidden, onRefresh,
  simulationMode, simulationAvailable, onToggleSimulation,
  gitBashMode, gitBashAvailable, onToggleGitBash,
  onOpenAll, onCloseAll, onSortByPort,
}) => {
  const { t } = useTranslation();
  const { show, element } = useContextMenu();

  const overflowItems: ContextMenuEntry[] = [
    {
      label: showHidden ? t('sidebar.toolbar.hideHidden') : t('sidebar.toolbar.showHidden'),
      icon: showHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      onClick: onToggleHidden,
    },
    // 排序是一次性动作（重排后仍可拖拽/分组），不是持久开关。
    { label: t('sidebar.toolbar.sortByPort'), icon: <ArrowUpDown size={14} />, onClick: onSortByPort },
  ];

  return (
    <div className="sidebar-toolbar">
      <span className="sidebar-toolbar-title eyebrow">{t('sidebar.toolbar.title')}</span>
      <div className="sidebar-toolbar-actions">
        {simulationAvailable && (
          <button
            className={`icon-btn${simulationMode ? ' active' : ''}`}
            title={simulationMode ? t('sidebar.toolbar.disableSimulation') : t('sidebar.toolbar.enableSimulation')}
            onClick={onToggleSimulation}
          >
            <FlaskConical size={14} />
          </button>
        )}
        {gitBashAvailable && (
          <button
            className={`icon-btn${gitBashMode ? ' active' : ''}`}
            title={gitBashMode ? t('sidebar.toolbar.disableGitBashSim') : t('sidebar.toolbar.enableGitBashSim')}
            onClick={onToggleGitBash}
          >
            <Terminal size={14} />
          </button>
        )}
        <button className="icon-btn" title={t('sidebar.toolbar.refresh')} onClick={onRefresh}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn" title={t('sidebar.toolbar.openAll')} onClick={onOpenAll}>
          <Play size={14} />
        </button>
        <button className="icon-btn" title={t('sidebar.toolbar.closeAll')} onClick={onCloseAll}>
          <Square size={14} />
        </button>
        <span className="toolbar-sep" />
        <button
          className="icon-btn"
          title={t('sidebar.toolbar.more')}
          aria-label={t('sidebar.toolbar.more')}
          onClick={(e) => show(e, overflowItems)}
        >
          <Ellipsis size={14} />
        </button>
      </div>
      {element}
    </div>
  );
};

export default SidebarToolbar;
