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
//
// Hierarchy: a project named a:b is below a. A keyword of a also matches a:b (and a:b:c), and when
// several projects match, the deepest one wins, provided the others are its ancestors. So with
// projects "car" (keyword car) and "car:maintainance", "car wash" is car:maintainance, while
// "gym car" is still an error. A description that is exactly a keyword is matched as a whole first,
// so a keyword with a colon (car:maintainance) is not split.
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

// Whether one keyword matches, as whole words, inside the other (ignoring case): then a description
// with the longer one also matches the shorter one.
export function keywordsOverlap(a: string, b: string): boolean {
  return keywordPattern(a).test(b) || keywordPattern(b).test(a);
}

// The names above a project: a:b:c has a:b and a.
export function ancestorsOf(name: string): string[] {
  const parts = name.split(":");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join(":")).reverse();
}

interface Match {
  name: string;
  own: boolean; // matched by its own keyword, not only by one above it
}

// The projects that match: one with a keyword that matches itself (own) or one of its ancestors.
function matchingProjects(matches: (keyword: string) => boolean, projects: Projects): Match[] {
  const found: Match[] = [];
  for (const name of projects.keys()) {
    const own = (projects.get(name) ?? []).some(matches);
    const inherited = ancestorsOf(name).some((owner) => (projects.get(owner) ?? []).some(matches));
    if (own || inherited) found.push({ name, own });
  }
  return found;
}

const depthOf = (name: string) => name.split(":").length;

// The project the matches give. The deepest matches win; at that depth a project with its own keyword
// beats one matched only through a parent (car a beats car:b, which only has car). Two own matches
// at the deepest depth, or any unrelated match, is an error. Null when nothing matches.
function resolveMatches(matches: Match[], description: string): string | null {
  if (!matches.length) return null;
  const top = Math.max(...matches.map((match) => depthOf(match.name)));
  const atTop = matches.filter((match) => depthOf(match.name) === top);
  const owned = atTop.filter((match) => match.own);
  const pool = owned.length ? owned : atTop;
  if (pool.length > 1) {
    throw new TimeParseError(`description '${description}' matches several projects: ${pool.map((match) => match.name).join(", ")}`);
  }
  const deepest = pool[0].name;
  const considered = owned.length ? matches.filter((match) => depthOf(match.name) < top || match.own) : matches;
  const unrelated = considered
    .map((match) => match.name)
    .filter((name) => name !== deepest && !ancestorsOf(deepest).includes(name));
  if (unrelated.length) {
    throw new TimeParseError(`description '${description}' matches several projects: ${[deepest, ...unrelated].join(", ")}`);
  }
  return deepest;
}

// The one project whose keyword appears in the description, or "unknown". Unrelated matches are an error.
export function detectProject(description: string, projects: Projects): string {
  const names = matchingProjects((keyword) => keywordPattern(keyword).test(description), projects);
  return resolveMatches(names, description) ?? UNKNOWN_PROJECT;
}

// The project whose keyword is exactly this text (ignoring case and surrounding spaces), or null.
function keywordProject(text: string, projects: Projects): string | null {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return null;
  return resolveMatches(
    matchingProjects((keyword) => keyword.toLowerCase() === wanted, projects),
    text.trim(),
  );
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
  // The whole description is a keyword (for example car:maintainance): no split.
  const whole = keywordProject(description, projects);
  if (whole !== null) return { project: whole, task: description.trim(), form: "anywhere" };

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
