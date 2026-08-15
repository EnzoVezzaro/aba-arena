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

export function loadRepo(source) {
  return request('/api/repo', { method: 'POST', body: JSON.stringify({ source }) });
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

/* GitHub account connection — used only to list YOUR repos as suggestions.
   The token is a personal access token (classic with `repo` read, or
   fine-grained with read-only contents) and lives in localStorage. */

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
