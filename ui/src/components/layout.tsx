import type { PropsWithChildren } from 'react';
import { Badge } from './ui';

export type TabKey = 'accounts' | 'articles' | 'jobs' | 'bulk';

export function Layout(
  props: PropsWithChildren<{
    tab: TabKey;
    onTabChange: (t: TabKey) => void;
    health?: { ok: boolean } | null;
  }>
) {
  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="title">LinkedIn Publisher</div>
          <div className="subtitle">Accounts, Articles, and Publish Jobs</div>
        </div>
        <div className="topbarRight">
          {props.health ? (
            <Badge tone={props.health.ok ? 'ok' : 'danger'} text={props.health.ok ? 'Healthy' : 'Down'} />
          ) : (
            <Badge tone="neutral" text="Health: …" />
          )}
        </div>
      </header>

      <nav className="tabs">
        <button className={props.tab === 'accounts' ? 'tab active' : 'tab'} onClick={() => props.onTabChange('accounts')}>
          Accounts
        </button>
        <button className={props.tab === 'articles' ? 'tab active' : 'tab'} onClick={() => props.onTabChange('articles')}>
          Articles
        </button>
        <button className={props.tab === 'jobs' ? 'tab active' : 'tab'} onClick={() => props.onTabChange('jobs')}>
          Publish Jobs
        </button>
        <button className={props.tab === 'bulk' ? 'tab active' : 'tab'} onClick={() => props.onTabChange('bulk')}>
          Bulk (Excel)
        </button>
      </nav>

      <main className="content">{props.children}</main>
    </div>
  );
}
