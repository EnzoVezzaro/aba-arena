import React, { useEffect, useMemo, useState } from 'react';
import { sandboxTree, sandboxRead } from './api.js';
import { Icon, useOverlay } from './components.jsx';

const fmtBytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/**
 * Sandbox code explorer — file tree + content viewer for one panel's
 * isolated sandbox copy of the repo. Lets you see the actual code at any
 * moment, including the changes the agent made mid-battle.
 */
export default function CodeExplorer({ open, panel, repoName, onClose }) {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState('');
  const [openDirs, setOpenDirs] = useState(() => new Set(['']));
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  // Same enter/exit motion as the history drawer: stays mounted through the
  // closing transition, `visible` flips one frame after opening so the CSS
  // transition plays (slide in from the right + fade).
  const { mounted, visible } = useOverlay(open, 240);

  const panelId = panel?.id || 'acc';
  const panelLabel = panel?.acc ? 'ACC' : 'no-ACC';

  useEffect(() => {
    if (!open) return;
    setTree(null);
    setSelected('');
    setContent('');
    setError('');
    setOpenDirs(new Set(['']));
    sandboxTree(panelId)
      .then((r) => setTree(r.tree || []))
      .catch((e) => setError(e.message));
  }, [open, panelId]);

  useEffect(() => {
    if (!open || !selected) return;
    setLoading(true);
    setContent('');
    sandboxRead(panelId, selected)
      .then((r) => setContent(r.content ?? ''))
      .catch((e) => setContent(`error: ${e.message}`))
      .finally(() => setLoading(false));
  }, [open, panelId, selected]);

  const isOpen = (dirPath) => openDirs.has(dirPath);

  function toggleDir(dirPath) {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }

  function renderNodes(nodes, depth = 0) {
    return nodes.map((n) => {
      const indent = { paddingLeft: `${depth * 14 + 8}px` };
      if (n.type === 'dir') {
        const expanded = isOpen(n.path);
        return (
          <div key={n.path}>
            <button
              onClick={() => toggleDir(n.path)}
              className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)]"
              style={indent}
              title={n.path}
            >
              <Icon name="chevron" className={`size-3 shrink-0 text-[var(--color-ink-faint)] transition-transform ${expanded ? 'rotate-90' : ''}`} />
              <Icon name="folder" className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
              <span className="truncate">{n.path.split('/').pop()}</span>
            </button>
            {expanded && n.children && renderNodes(n.children, depth + 1)}
          </div>
        );
      }
      const active = selected === n.path;
      return (
        <button
          key={n.path}
          onClick={() => setSelected(n.path)}
          className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] transition-colors ${
            active ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)]'
          }`}
          style={indent}
          title={n.path}
        >
          <span className="w-3.5 shrink-0" />
          <Icon name="file" className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
          <span className="min-w-0 flex-1 truncate">{n.path.split('/').pop()}</span>
          {n.size != null && <span className="shrink-0 text-[9px] tabular-nums text-[var(--color-ink-faint)]">{fmtBytes(n.size)}</span>}
        </button>
      );
    });
  }

  if (!mounted) return null;

  return (
    <div id="code-explorer" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="code-explorer-title">
      <div
        id="code-explorer-backdrop"
        className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        id="code-explorer-panel"
        className={`absolute right-0 top-0 flex h-full w-[min(94vw,860px)] flex-col border-l border-[var(--color-line-hi)] bg-[var(--color-panel)] shadow-2xl transition-transform duration-200 ease-out ${
          visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
        }`}
      >
        <header className="flex items-center gap-2.5 border-b border-[var(--color-line)] px-4 py-3.5">
          <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${
            panel?.acc ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]' : 'bg-[var(--color-panel-hi)] text-[var(--color-ink-dim)]'
          }`}>
            <Icon name="code" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="code-explorer-title" className="truncate text-[14px] font-medium text-[var(--color-ink)]">
              {repoName} <span className="text-[var(--color-ink-faint)]">· sandbox</span>
            </h2>
            <p className="truncate text-[11px] text-[var(--color-ink-faint)]">
              {panelLabel} panel — isolated copy of the repository · the agent edits this
            </p>
          </div>
          <span className={`shrink-0 rounded-md border px-1.5 py-0.5 font-pixel text-[9px] uppercase tracking-[0.14em] ${
            panel?.acc ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/15 text-[var(--color-accent)]' : 'border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] text-[var(--color-ink-dim)]'
          }`}>
            {panelLabel}
          </span>
          <button
            onClick={onClose}
            aria-label="Close code explorer"
            className="grid size-8 shrink-0 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          >
            <Icon name="x" className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* file tree */}
          <div className="no-scrollbar w-[min(38%,280px)] shrink-0 overflow-y-auto border-r border-[var(--color-line)] p-2">
            <p className="px-2 pb-1.5 pt-1 font-pixel text-[9px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
              files
            </p>
            {error && <p className="px-2 text-[11px] text-red-400">{error}</p>}
            {!tree && !error && <p className="px-2 text-[11px] text-[var(--color-ink-faint)]">loading…</p>}
            {tree && tree.length === 0 && <p className="px-2 text-[11px] text-[var(--color-ink-faint)]">(empty repo)</p>}
            {tree && tree.length > 0 && (
              <div>
                <button
                  onClick={() => toggleDir('')}
                  className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-panel-hi)]"
                >
                  <Icon name="chevron" className={`size-3 text-[var(--color-ink-faint)] transition-transform ${isOpen('') ? 'rotate-90' : ''}`} />
                  <Icon name="folder" className="size-3.5 text-[var(--color-ink-faint)]" />
                  <span className="font-medium">/</span>
                </button>
                {isOpen('') && renderNodes(tree, 1)}
              </div>
            )}
          </div>

          {/* content viewer */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-3.5 py-2">
              <span className="truncate font-mono text-[11px] text-[var(--color-ink-dim)]">{selected || 'select a file'}</span>
              {selected && (
                <span className="flex shrink-0 items-center gap-2 text-[10px] text-[var(--color-ink-faint)]">
                  <Icon name="refresh" className="size-3" />
                  <span>live — refreshes as the agent works</span>
                </span>
              )}
            </div>
            <div className="no-scrollbar min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]">
              {loading && <p className="p-4 font-mono text-[11px] text-[var(--color-ink-faint)]">reading…</p>}
              {!loading && !selected && (
                <p className="p-4 text-[12px] text-[var(--color-ink-faint)]">Pick a file from the tree to view its contents.</p>
              )}
              {!loading && selected && (
                <pre className="p-4 font-mono text-[11px] leading-relaxed text-[var(--color-ink-dim)] whitespace-pre-wrap break-words">{content}</pre>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
