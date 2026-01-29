import type { PropsWithChildren } from 'react';
import { Badge } from './ui';

export type TabKey = 'accounts' | 'articles' | 'jobs' | 'bulk';
export type ThemeMode = 'light' | 'dark' | 'system';

export function Layout(
  props: PropsWithChildren<{
    tab: TabKey;
    onTabChange: (t: TabKey) => void;
    health?: { ok: boolean } | null;
    themeMode: ThemeMode;
    onThemeChange: (mode: ThemeMode) => void;
  }>
) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbarMain">
          <div>
            <div className="title">LinkedIn Publisher</div>
            <div className="subtitle">Accounts, Articles, and Publish Jobs</div>
          </div>
          <div className="topbarRight">
            <div className="themeSwitcher" role="group" aria-label="Color theme">
              {(['light', 'system', 'dark'] as ThemeMode[]).map(mode => (
                <button
                  key={mode}
                  type="button"
                  className={props.themeMode === mode ? 'themePill active' : 'themePill'}
                  onClick={() => props.onThemeChange(mode)}
                >
                  {mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System'}
                </button>
              ))}
            </div>
            {props.health ? (
              <Badge tone={props.health.ok ? 'ok' : 'danger'} text={props.health.ok ? 'Healthy' : 'Down'} />
            ) : (
              <Badge tone="neutral" text="Health: …" />
            )}
          </div>
        </div>
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
      </header>

      <main className="content">{props.children}</main>
    </div>
  );
}
