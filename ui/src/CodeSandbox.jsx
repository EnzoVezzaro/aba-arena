import React, { useEffect, useState } from 'react';
import { sandboxTree, sandboxRead } from './api.js';
import { Icon } from './components.jsx';

/**
 * Compact sandbox code viewer — shows the ACTUAL files of a panel's isolated
 * sandbox copy of the repo, including the agent's mid-battle edits. Used as
 * the Code view inside each result card, so clicking "Code" shows the real
 * repository code of that sandbox, not just the code in the model's answer.
 */
export default function CodeSandbox({ panel, repoName }) {
  const panelId = panel?.id || 'acc';
  const [tree, setTree] = useState(null);
  const [error, setError] = useState('');
  const [openDirs, setOpenDirs] = useState(() => new Set(['']));
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setTree(null);
    setSelected('');
    setContent('');
    setError('');
    setOpenDirs(new Set(['']));
    sandboxTree(panelId)
      .then((r) => setTree(r.tree || []))
      .catch((e) => setError(e.message));
  }, [panelId]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setContent('');
    sandboxRead(panelId, selected)
      .then((r) => setContent(r.content ?? ''))
      .catch((e) => setContent(`error: ${e.message}`))
      .finally(() => setLoading(false));
  }, [panelId, selected]);

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
      const indent = { paddingLeft: `${depth * 13 + 8}px` };
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
        </button>
      );
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header: which repo this sandbox contains (the battle repo, not the engine) */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--color-ink-dim)]">
          <Icon name="folder" className="size-3 shrink-0 text-[var(--color-accent)]" />
          <span className="truncate font-medium text-[var(--color-ink)]">{repoName || 'repo'}</span>
          <span className="shrink-0 text-[var(--color-ink-faint)]">· sandbox</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[9px] text-[var(--color-ink-faint)]">
          <Icon name="check" className="size-2.5 text-emerald-400" />
          <span>live</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
      {/* file tree */}
      <div className="no-scrollbar w-[min(40%,260px)] shrink-0 overflow-y-auto border-r border-[var(--color-line)] p-2">
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
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-3 py-1.5">
          <span className="truncate font-mono text-[10px] text-[var(--color-ink-dim)]">{selected || 'select a file'}</span>
          {selected && (
            <span className="flex shrink-0 items-center gap-1 text-[9px] text-[var(--color-ink-faint)]">
              <Icon name="refresh" className="size-2.5" />
              <span>live</span>
            </span>
          )}
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]">
          {loading && <p className="p-3 font-mono text-[10px] text-[var(--color-ink-faint)]">reading…</p>}
          {!loading && !selected && (
            <p className="p-3 text-[11px] text-[var(--color-ink-faint)]">Pick a file to view the sandbox code.</p>
          )}
          {!loading && selected && (
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[10.5px] leading-relaxed text-[var(--color-ink-dim)]">{content}</pre>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
