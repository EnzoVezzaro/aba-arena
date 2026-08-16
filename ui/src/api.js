async function request(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export function health() {
  return request('/api/health');
}

export function loadRepo(source, opts = {}) {
  const body = { source };
  if (opts.token) body.token = opts.token; // used for private GitHub clones
  if (opts.type) body.type = opts.type; // e.g. 'github' when picked from the autocomplete
  return request('/api/repo', { method: 'POST', body: JSON.stringify(body) });
}

export function saveReport(report) {
  return request('/api/report', { method: 'POST', body: JSON.stringify(report) });
}

/** Delete a battle — removes its isolated sandboxes and saved report. */
export function deleteBattle(id) {
  return request('/api/battles/delete', { method: 'POST', body: JSON.stringify({ id }) });
}

/** Delete every battle (sandboxes + reports) on the server. */
export function deleteAllBattles() {
  return request('/api/battles/delete', { method: 'POST', body: JSON.stringify({ all: true }) });
}

/** List subdirectories of a path on the machine running the ABA server. */
export function fsList(path = '') {
  return request(`/api/fs/list?path=${encodeURIComponent(path)}`);
}

/* GitHub account connection — used only to list YOUR repos as suggestions.
   The token (from OAuth sign-in or a pasted personal access token) lives in
   localStorage and is only ever sent to api.github.com, never to ABA. */

/* GitHub OAuth (web flow + PKCE): the popup opens /api/github/start, GitHub
   redirects back to /api/github/callback, and the token is delivered to this
   window via postMessage — no codes, no secrets in the browser. */

export async function githubMe(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status} — ${(await res.json().catch(() => ({})))?.message || res.statusText}`);
  return res.json();
}

export async function githubRepos(token) {
  const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status} — ${(await res.json().catch(() => ({})))?.message || res.statusText}`);
  const rows = await res.json();
  return rows.map((r) => ({
    full: r.full_name,
    name: r.name,
    description: r.description || '',
    language: r.language || '',
  }));
}

/** File-tree of a panel's isolated sandbox copy of the repo. */
export function sandboxTree(panel) {
  return request(`/api/sandbox/${panel}/tree?path=/`);
}

/** Read a file from a panel's sandbox. */
export function sandboxRead(panel, path) {
  return request(`/api/sandbox/${panel}/file?path=${encodeURIComponent(path)}`);
}

/** Write a file into a panel's sandbox (used by the agent's tools). */
export function sandboxWrite(panel, path, content) {
  return request(`/api/sandbox/${panel}/file?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Run the agent harness inside a panel's sandbox. The harness (installed in
 * the sandbox at repo load) runs the agentic loop with the panel's
 * provider/model/key and emits NDJSON events, which are forwarded here one
 * line at a time.
 *
 * Events: {type:'delta',text} · {type:'tool',name} · {type:'verify',ok,…}
 *         {type:'done',output,verified,mode,timeMs,steps} · {type:'error',message}
 *
 * Resolves with the `done` event; throws if the harness errors or exits
 * without finishing.
 */
export async function runAgent(body, { signal, onEvent } = {}) {
  const res = await fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastError = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === 'done') return evt;
      if (evt.type === 'error') lastError = evt.message || lastError;
      onEvent?.(evt);
    }
  }
  throw new Error(lastError || 'agent exited without finishing');
}
