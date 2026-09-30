import React from 'react';
import {
  Search, Wrench, Play, Square, Terminal, RefreshCw, Eye, EyeOff,
  ArrowUpDown, PlugZap, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  Search, Wrench, Play, Square, Terminal, RefreshCw, Eye, EyeOff, ArrowUpDown,
  Zap: PlugZap,
  Send: PlugZap,
};

export function pluginIcon(name: string | undefined, size = 13): React.ReactElement {
  const Icon = (name && ICONS[name]) || PlugZap;
  return <Icon size={size} />;
}
