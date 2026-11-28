// Changes to the project database text, without any file access, so the browser can use them too.
import { stringify } from "yaml";

import { TimeParseError } from "./errors";
import { categoryForNew, DbProject, loadDatabase } from "./reports";

// Text as one YAML scalar on one line: plain when that is safe, quoted otherwise.
export function scalar(text: string): string {
  return stringify(text, { version: "1.1", lineWidth: 0 }).split("\n")[0];
}

// The database text with a project appended, with keywords (default: its name). The result is
// checked as a database before it is returned, so a clash or a reserved name throws and changes nothing.
// The project gets the given category, or else its nearest parent's.
export function addProjectText(
  text: string,
  name: string,
  keywords: string[] | undefined,
  source: string,
  category?: "personal" | "professional",
): { text: string; project: DbProject } {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("the project name must not be empty");
  const words = (keywords ?? [trimmed]).map((word) => word.trim());

  let inherited: string | null = category ?? null;
  try {
    if (!category) inherited = categoryForNew(loadDatabase(text, source), trimmed);
  } catch {
    // A text that does not load is refused below, with its own message.
  }

  const block = [`${scalar(trimmed)}:`, ...(inherited ? [`  category: ${inherited}`] : []), "  keywords:", ...words.map((word) => `    - ${scalar(word)}`)];
  let body = text;
  if (text.trim()) body = (text.endsWith("\n") ? text : `${text}\n`) + "\n";
  const updated = body + block.join("\n") + "\n";

  let database;
  try {
    database = loadDatabase(updated, source);
  } catch (err) {
    if (err instanceof TimeParseError) throw new Error(err.message);
    throw err;
  }
  const project = database.get(trimmed);
  if (!project) throw new Error(`${source}: '${trimmed}' was not added`);
  return { text: updated, project };
}
