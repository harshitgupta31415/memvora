'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Icon, type IconName } from './icon';

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Overview', icon: 'grid' },
  { href: '/repositories', label: 'Repositories', icon: 'repo' },
  { href: '/sessions', label: 'Investigations', icon: 'terminal' },
  { href: '/jobs', label: 'Memory processing', icon: 'clock' },
  { href: '/ask', label: 'Ask Memvora', icon: 'spark' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isSourceView = pathname.startsWith('/sources/');
  const current = [
    ...navigation,
    { href: '/settings', label: 'Settings' },
    { href: '/setup', label: 'Local setup' },
    { href: '/backups', label: 'Backup guide' },
    { href: '/capture-recovery', label: 'Capture recovery' },
  ].find((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)));
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {open && (
        <button
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`} aria-label="Main navigation">
        <Link className="brand" href="/" onClick={() => setOpen(false)}>
          <span className="brand-mark">
            m<span>↗</span>
          </span>
          <span>
            memvora<span className="brand-sub">ENGINEERING MEMORY</span>
          </span>
        </Link>
        <div className="workspace-switch">
          <span className="workspace-avatar">P</span>
          <span>
            <strong>Personal workspace</strong>
            <small>Local development</small>
          </span>
          <span className="workspace-dot" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`nav-item ${(item.href === '/' ? pathname === '/' : pathname.startsWith(item.href) || (item.href === '/repositories' && isSourceView)) ? 'active' : ''}`}
              aria-current={
                (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href))
                  ? 'page'
                  : undefined
              }
            >
              <Icon name={item.icon} size={19} />
              {item.label}
              {item.href === '/ask' && <span className="nav-tag">RECALL</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Icon name="link" size={18} />
            <p>
              Your work, connected.
              <br />
              <span>Every memory starts with evidence.</span>
            </p>
          </div>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className={`nav-item ${pathname.startsWith('/settings') || pathname.startsWith('/backups') || pathname.startsWith('/capture-recovery') ? 'active' : ''}`}
          >
            <Icon name="settings" size={19} />
            Settings
          </Link>
          <Link
            href="/setup"
            onClick={() => setOpen(false)}
            className={`nav-item ${pathname.startsWith('/setup') ? 'active' : ''}`}
            aria-current={pathname.startsWith('/setup') ? 'page' : undefined}
          >
            <Icon name="terminal" size={19} />
            Local setup
          </Link>
          <div className="local-mode">
            <span />
            Local workspace <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="app-topbar">
          <div className="breadcrumbs">
            <button
              type="button"
              className="icon-button mobile-menu"
              onClick={() => setOpen(!open)}
              aria-label={open ? 'Close navigation' : 'Open navigation'}
              aria-expanded={open}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <Icon name="chevron" size={12} />
            <strong>
              {isSourceView ? 'Repository source' : (current?.label ?? 'Evidence detail')}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span />
              LOCAL MODE
            </span>
            <span className="user-avatar" title="Personal workspace">
              HG
            </span>
          </div>
        </header>
        <main id="main-content" className="page-content">
          {children}
        </main>
        <footer className="app-footer">
          <span>
            MEMVORA <span className="footer-divider">/</span> Keep the context. Continue the work.
          </span>
          <span>Evidence first · Read-only recall</span>
        </footer>
      </div>
    </div>
  );
}
