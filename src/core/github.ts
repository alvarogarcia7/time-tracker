// The part of the GitHub REST API that the sync uses: the contents of the root folder of a
// repository (GET /contents/, PUT /contents/{path}). The fetch function is a parameter, so tests
// can use a fake GitHub.
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubOptions {
  owner: string;
  repo: string;
  token: string;
  fetch?: typeof fetch;
}

export interface RemoteEntry {
  name: string;
  sha: string;
}

export function encodeBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(text: string): string {
  const binary = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

const API = "https://api.github.com";

// The contents API returns the text of a file only up to this size.
export const CONTENTS_LIMIT = 1024 * 1024;

function messageFor(status: number, repo: string): string {
  if (status === 401) return "GitHub rejected the token. Check the token in Settings.";
  if (status === 403) return "GitHub refused the request: the token may lack access to the data repository, or the rate limit was reached.";
  if (status === 404) return `GitHub has no repository ${repo}. Check the owner and the repository name in Settings.`;
  if (status === 409 || status === 422) return "The file changed on GitHub during the sync. The next sync picks it up.";
  return `GitHub answered with status ${status}.`;
}

export function githubRepo(options: GitHubOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const label = `${options.owner}/${options.repo}`;

  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetcher(`${API}${repoPath}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await response.json().catch(() => null);
    if (!response.ok) throw new GitHubError(response.status, messageFor(response.status, label));
    return data;
  }

  return {
    // The Markdown files in the root folder. A repository with no commits has no contents yet, so
    // the contents request answers 404 there; the repository itself must still exist.
    async list(): Promise<RemoteEntry[]> {
      let items: any[];
      try {
        items = (await request("GET", "/contents/")) ?? [];
      } catch (err) {
        if (!(err instanceof GitHubError) || err.status !== 404) throw err;
        await request("GET", ""); // throws when the repository does not exist
        return [];
      }
      return items
        .filter((item) => item.type === "file" && String(item.name).endsWith(".md"))
        .map((item) => ({ name: String(item.name), sha: String(item.sha) }));
    },

    // The text of a file. The contents answer has the text only up to CONTENTS_LIMIT bytes; larger
    // files (and an answer with no text) are read through the blob API. A missing file throws (404).
    async get(name: string): Promise<{ text: string; sha: string }> {
      const data = await request("GET", `/contents/${encodeURIComponent(name)}`);
      if (!data || Array.isArray(data) || data.type !== "file") throw new Error(`${name}: GitHub returned no file`);
      const sha = String(data.sha);
      const size = Number(data.size ?? 0);
      const encoding = data.encoding;
      if (encoding !== undefined && encoding !== "base64" && encoding !== "none") {
        throw new Error(`${name}: unsupported encoding ${String(encoding)}`);
      }
      const inline = encoding === "base64" && typeof data.content === "string" && size <= CONTENTS_LIMIT;
      if (inline && (data.content !== "" || size === 0)) return { text: decodeBase64(data.content), sha };

      const blob = await request("GET", `/git/blobs/${sha}`);
      if (!blob || blob.encoding !== "base64" || typeof blob.content !== "string") {
        throw new Error(`${name}: GitHub did not return the file text`);
      }
      return { text: decodeBase64(blob.content), sha };
    },

    // Creates the file (sha null) or replaces it (sha is the blob sha the change is based on).
    async put(name: string, text: string, sha: string | null, message: string): Promise<{ sha: string }> {
      const body: Record<string, string> = { message, content: encodeBase64(text) };
      if (sha !== null) body.sha = sha;
      const data = await request("PUT", `/contents/${encodeURIComponent(name)}`, body);
      return { sha: String(data.content.sha) };
    },

    // Deletes the file. sha is the blob sha the deletion is based on; a file changed since fails (409).
    async delete(name: string, sha: string, message: string): Promise<void> {
      await request("DELETE", `/contents/${encodeURIComponent(name)}`, { message, sha });
    },
  };
}

export type GitHubRepo = ReturnType<typeof githubRepo>;
