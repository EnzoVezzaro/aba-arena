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
