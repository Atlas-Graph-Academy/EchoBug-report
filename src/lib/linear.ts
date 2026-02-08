import type { LinearUser } from './types';

export async function linearGraphQL<T = Record<string, unknown>>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch('/api/linear/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken, query, variables }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GraphQL request failed: ${err}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors[0]?.message || 'GraphQL error');
  }
  return json.data;
}

export async function fetchLinearUser(accessToken: string): Promise<LinearUser> {
  const data = await linearGraphQL<{ viewer: LinearUser }>(
    accessToken,
    '{ viewer { id name email displayName avatarUrl } }'
  );
  return data.viewer;
}

export async function uploadImageToLinear(
  accessToken: string,
  blob: Blob,
  filename: string
): Promise<string> {
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('access_token', accessToken);

  const res = await fetch('/api/linear/upload', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Upload failed: ${err}`);
  }

  const json = await res.json();
  return json.assetUrl;
}
