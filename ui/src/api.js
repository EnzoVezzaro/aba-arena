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
