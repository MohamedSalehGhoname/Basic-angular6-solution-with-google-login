/**
 * Storage for files sent to the clipboard. Only this server holds the storage
 * API key; devices get short-lived upload/download URLs and move the bytes
 * directly, so file contents never pass through here on upload.
 */
export interface FileStore {
  create(input: { fileName: string; path: string; sizeBytes: number }): Promise<CreatedFile>;
  confirm(fileId: string): Promise<{ fileId: string; sizeBytes: number; expiresAt: string | null }>;
  downloadUrl(fileId: string): Promise<{ downloadUrl: string; expiresAt: string }>;
}

export interface CreatedFile {
  fileId: string;
  uploadUrl: string;
  uploadExpiresAt: string;
}

/** A storage call failed; `status` is the upstream HTTP status (0 = unreachable). */
export class FileStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * GTDrive's append-only plain-files API (`/api/v1/files`). The GTDrive client
 * behind the key must have plain file storage enabled; its retention setting
 * is what eventually removes files — the API has no delete.
 */
export function gtdriveFileStore(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): FileStore {
  const base = baseUrl.replace(/\/+$/, '');

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          // GTDrive answers 411 to a bodyless POST without a length.
          'content-type': 'application/json',
        },
        body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new FileStoreError('File storage is unreachable', 0);
    }
    if (!res.ok) {
      throw new FileStoreError(`File storage returned ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  };

  return {
    create: (input) => call<CreatedFile>('POST', '/api/v1/files', input),
    confirm: (fileId) => call('POST', `/api/v1/files/${encodeURIComponent(fileId)}/uploaded`),
    downloadUrl: (fileId) => call('GET', `/api/v1/files/${encodeURIComponent(fileId)}/download`),
  };
}
