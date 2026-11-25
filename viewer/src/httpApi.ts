// The editor operations over the Node server's HTTP routes (make editor).
import { DatabaseFile, DayFile, DayFileInfo, EditorApi, StoreError } from "@core/workspace";

export function httpApi(): EditorApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new StoreError(response.status, String(data.error ?? `request failed (${response.status})`));
    return data as T;
  };
  return {
    files: async () => (await call<{ files: DayFileInfo[] }>("GET", "/api/files")).files,
    read: (name) => call<DayFile>("GET", `/api/file?name=${encodeURIComponent(name)}`),
    write: (name, text, base) => call("PUT", `/api/file?name=${encodeURIComponent(name)}`, { text, base }),
    create: (name, text) => call("POST", "/api/file", { name, text }),
    parse: (text) => call("POST", "/api/parse", { text }),
    projects: () => call<DatabaseFile>("GET", "/api/projects"),
    saveProjects: (text, base) => call("PUT", "/api/projects", { text, base }),
    createProject: (name) => call("POST", "/api/projects", { name }),
    vocabulary: async () => (await call<{ descriptions: string[] }>("GET", "/api/vocabulary")).descriptions,
    days: () => call("GET", "/api/days"),
  };
}
