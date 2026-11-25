// Reads the description of an entry into its project and its task.
//
// Written as one of
//   kitchen: wash dishes     kitchen, wash dishes
//   wash dishes, kitchen     wash dishes: kitchen
// where "kitchen" is a keyword of a project. The keyword side gives the project; the other side is
// the task, kept as written. The separators are ":" and ",", and both the first and the last one
// are tried, so a task may itself contain a comma.
//
// Without such a split, the project is the one whose keyword appears as a whole word anywhere in
// the description (ignoring case), and the task is the whole description.
import { TimeParseError } from "./errors";
import { UNKNOWN_PROJECT } from "./summary";

export type Projects = Map<string, string[]>;

export type DescriptionForm = "keyword-first" | "keyword-last" | "anywhere" | "none";

export interface DescriptionParts {
  project: string;
  task: string;
  form: DescriptionForm;
  separatorAt?: number; // where the separator of a keyword split is
}

const SEPARATORS = [":", ","];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keywords match whole words: the characters around them must not be letters, digits or underscores.
const keywordPattern = (keyword: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}_])`, "iu");

// The one project whose keyword appears in the description, or "unknown". Two projects is an error.
export function detectProject(description: string, projects: Projects): string {
  const matches = [...projects]
    .filter(([, keywords]) => keywords.some((keyword) => keywordPattern(keyword).test(description)))
    .map(([name]) => name);
  if (matches.length > 1) {
    throw new TimeParseError(`description '${description}' matches several projects: ${matches.join(", ")}`);
  }
  return matches.length ? matches[0] : UNKNOWN_PROJECT;
}

// The project whose keyword is exactly this text (ignoring case and surrounding spaces), or null.
function keywordProject(text: string, projects: Projects): string | null {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  const owners = [...projects]
    .filter(([, keywords]) => keywords.some((keyword) => keyword.toLowerCase() === wanted))
    .map(([name]) => name);
  return owners.length ? owners[0] : null;
}

// The two sides around the first separator and around the last one, as [before, after] pairs.
function splits(description: string): [number, string, string][] {
  const positions: number[] = [];
  const first = Math.min(...SEPARATORS.map((sep) => description.indexOf(sep)).filter((i) => i >= 0));
  const last = Math.max(...SEPARATORS.map((sep) => description.lastIndexOf(sep)));
  if (Number.isFinite(first)) positions.push(first);
  if (last >= 0 && last !== first) positions.push(last);
  return positions.map((at) => [at, description.slice(0, at), description.slice(at + 1)]);
}

export function parseDescription(description: string, projects: Projects): DescriptionParts {
  for (const [at, before, after] of splits(description)) {
    const beforeProject = keywordProject(before, projects);
    const afterProject = keywordProject(after, projects);
    if (beforeProject !== null && afterProject !== null && beforeProject !== afterProject) {
      throw new TimeParseError(`description '${description}' matches several projects: ${beforeProject}, ${afterProject}`);
    }
    if (beforeProject !== null) return { project: beforeProject, task: after.trim(), form: "keyword-first", separatorAt: at };
    if (afterProject !== null) return { project: afterProject, task: before.trim(), form: "keyword-last", separatorAt: at };
  }

  const project = detectProject(description, projects);
  return {
    project,
    task: description.trim(),
    form: project === UNKNOWN_PROJECT ? "none" : "anywhere",
  };
}

// The description with its keyword replaced by another keyword, keeping the separator and the task.
// Only for a keyword split (keyword-first or keyword-last); other descriptions are returned unchanged.
export function replaceKeyword(description: string, parts: DescriptionParts, keyword: string): string {
  if (parts.separatorAt === undefined) return description;
  const at = parts.separatorAt;
  if (parts.form === "keyword-first") return keyword + description.slice(at);
  const after = description.slice(at + 1);
  const leading = after.match(/^\s*/)?.[0] ?? "";
  const trailing = after.match(/\s*$/)?.[0] ?? "";
  return description.slice(0, at + 1) + leading + keyword + trailing;
}
