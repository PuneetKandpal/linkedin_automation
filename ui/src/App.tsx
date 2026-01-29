import { useEffect, useState } from 'react';
import './App.css';
import { Layout, type TabKey } from './components/layout';
import { AccountsPage } from './features/accounts/AccountsPage';
import { ArticlesPage } from './features/articles/ArticlesPage';
import { JobsPage } from './features/jobs/JobsPage';
import { BulkPage } from './features/bulk/BulkPage';
import { HealthApi } from './api/health';
import type { Health } from './api/types';

const TAB_STORAGE_KEY = 'lp-active-tab';
const TAB_QUERY_KEY = 'tab';

function normalizeTab(value: string | null): TabKey | null {
  if (value === 'accounts' || value === 'articles' || value === 'jobs' || value === 'bulk') return value;
  return null;
}

function getTabFromUrl(): TabKey | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  return normalizeTab(url.searchParams.get(TAB_QUERY_KEY));
}

function setTabInUrl(nextTab: TabKey, mode: 'replace' | 'push') {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set(TAB_QUERY_KEY, nextTab);
  if (mode === 'replace') {
    window.history.replaceState({ tab: nextTab }, '', url.toString());
  } else {
    window.history.pushState({ tab: nextTab }, '', url.toString());
  }
}

function getInitialTab(): TabKey {
  const fromUrl = getTabFromUrl();
  if (fromUrl) return fromUrl;
  if (typeof window === 'undefined') return 'accounts';
  const saved = normalizeTab(window.localStorage.getItem(TAB_STORAGE_KEY));
  if (saved) return saved;
  return 'accounts';
}

export default function App() {
  const [tab, setTab] = useState<TabKey>(() => getInitialTab());
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const onPopState = () => {
      const next = getTabFromUrl();
      if (next) setTab(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setTabInUrl(tab, 'replace');
  }, [tab]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const h = await HealthApi.get();
        if (mounted) setHealth(h);
      } catch {
        if (mounted) setHealth({ ok: false });
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const handleTabChange = (nextTab: TabKey) => {
    setTab(nextTab);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TAB_STORAGE_KEY, nextTab);
      setTabInUrl(nextTab, 'push');
    }
  };

  return (
    <Layout tab={tab} onTabChange={handleTabChange} health={health}>
      {tab === 'accounts' ? <AccountsPage /> : null}
      {tab === 'articles' ? <ArticlesPage /> : null}
      {tab === 'jobs' ? <JobsPage /> : null}
      {tab === 'bulk' ? <BulkPage /> : null}
    </Layout>
  );
}
