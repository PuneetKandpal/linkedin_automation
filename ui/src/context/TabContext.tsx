import { createContext } from 'react';
import type { TabKey } from '../components/layout';

export type TabContextValue = {
  activeTab: TabKey;
  setTab: (tab: TabKey) => void;
};

export const TabContext = createContext<TabContextValue | null>(null);
