import { useEffect, useState } from 'react';
import './App.css';
import { Layout, type TabKey } from './components/layout';
import { AccountsPage } from './features/accounts/AccountsPage';
import { ArticlesPage } from './features/articles/ArticlesPage';
import { JobsPage } from './features/jobs/JobsPage';
import { HealthApi } from './api/health';
import type { Health } from './api/types';

export default function App() {
  const [tab, setTab] = useState<TabKey>('accounts');
  const [health, setHealth] = useState<Health | null>(null);

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

  return (
    <Layout tab={tab} onTabChange={setTab} health={health}>
      {tab === 'accounts' ? <AccountsPage /> : null}
      {tab === 'articles' ? <ArticlesPage /> : null}
      {tab === 'jobs' ? <JobsPage /> : null}
    </Layout>
  );
}
