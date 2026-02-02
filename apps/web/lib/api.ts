export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json() as Promise<T>;
}
