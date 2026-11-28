// Reads the description of an entry into its project and its task.
//
// Written as "task, project": the project is the text after the LAST comma, matched exactly against the
// keywords (ignoring case and surrounding spaces). The task is the text before that comma, kept as
// written, so the task may contain commas. A tag that matches no project gives "unknown", with the text
// before the comma as the task.
//
// Without a comma tag, a colon split is tried, as written
//   kitchen: wash dishes     wash dishes: kitchen
// A side that is a keyword gives the project and the other side is the task, kept as written. The
// first and the last colon are both tried. Two different projects on the two sides is an error.
//
// Without either, the project is the one whose keyword appears as a whole word anywhere in the
// description (ignoring case). No match gives "unknown", and the task is the whole description.
//
// Hierarchy: a project named a:b is below a, and a keyword of a also matches a:b (and a:b:c). Among all
// matching projects the DEEPEST wins. At that depth, a project matched by its own keyword beats one
// matched only through its parent. Two own matches at that depth are an error, and so is an unrelated
// own match that is not an ancestor of the chosen project. With projects "car" (keyword car), "car:a"
// (keyword a) and "car:b" (keyword b): "car a" is car:a, "car" alone is car:maintainance when that
// project inherits car, "car" alone is car itself when several children inherit it (car:a and car:b),
// and "gym car" is an error when gym is unrelated.
import { TimeParseError } from "./errors";
import { UNKNOWN_PROJECT } from "./summary";

export type Projects = Map<string, string[]>;

// "tag": a comma tag was given (its project may be unknown); "keyword-first" and "keyword-last": a colon
// split whose left or right side is the keyword; "keyword": found by the keyword search, or the whole
// description is a keyword; "none": no tag, no split and no keyword, so unknown.
export type DescriptionForm = "tag" | "keyword-first" | "keyword-last" | "keyword" | "none";

export interface DescriptionParts {
  project: string;
  task: string;
  form: DescriptionForm;
  tagAt?: number; // the index of the last comma, for a "tag" form
  separatorAt?: number; // the index of the colon, for a "keyword-first" or "keyword-last" form
}

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

// The deepest own match that is above every project of the pool, or undefined.
function commonOwner(pool: Match[], matches: Match[]): string | undefined {
  const owners = matches.filter((match) => match.own && pool.every((member) => ancestorsOf(member.name).includes(match.name)));
  return owners.sort((a, b) => depthOf(b.name) - depthOf(a.name))[0]?.name;
}

// The project the matches give. The deepest matches win; at that depth an own match beats one matched
// only through a parent. Two own matches at the deepest depth, or an own match that is unrelated to the
// winner (not an ancestor of it), is an error. Several children matched only through their parent give
// the parent. Null when nothing matches.
function resolveMatches(matches: Match[], description: string): string | null {
  if (!matches.length) return null;
  const top = Math.max(...matches.map((match) => depthOf(match.name)));
  const atTop = matches.filter((match) => depthOf(match.name) === top);
  const owned = atTop.filter((match) => match.own);
  const pool = owned.length ? owned : atTop;
  let deepest = pool[0].name;
  if (pool.length > 1) {
    // Several children matched only through their parent's keyword: the description names the parent.
    const parent = owned.length ? undefined : commonOwner(pool, matches);
    if (parent === undefined) {
      throw new TimeParseError(`description '${description}' matches several projects: ${pool.map((match) => match.name).join(", ")}`);
    }
    deepest = parent;
  }
  const above = ancestorsOf(deepest);
  const unrelated = matches.filter((match) => match.own && match.name !== deepest && !above.includes(match.name)).map((match) => match.name);
  if (unrelated.length) {
    throw new TimeParseError(`description '${description}' matches several projects: ${[deepest, ...unrelated].join(", ")}`);
  }
  return deepest;
}

// The one project whose keyword appears in the description as whole words, or "unknown".
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

// The two sides around the first colon and around the last one, as [at, before, after] triples.
function colonSplits(description: string): [number, string, string][] {
  const positions: number[] = [];
  const first = description.indexOf(":");
  const last = description.lastIndexOf(":");
  if (first >= 0) positions.push(first);
  if (last >= 0 && last !== first) positions.push(last);
  return positions.map((at) => [at, description.slice(0, at), description.slice(at + 1)]);
}

export function parseDescription(description: string, projects: Projects): DescriptionParts {
  const at = description.lastIndexOf(",");
  if (at !== -1) {
    const tag = description.slice(at + 1).trim();
    if (tag) {
      return {
        project: keywordProject(tag, projects) ?? UNKNOWN_PROJECT,
        task: description.slice(0, at).trim(),
        form: "tag",
        tagAt: at,
      };
    }
  }

  // The whole description is a keyword (for example car:maintainance): no split.
  const whole = keywordProject(description, projects);
  if (whole !== null) return { project: whole, task: description.trim(), form: "keyword" };

  for (const [colon, before, after] of colonSplits(description)) {
    const beforeProject = keywordProject(before, projects);
    const afterProject = keywordProject(after, projects);
    if (beforeProject !== null && afterProject !== null && beforeProject !== afterProject) {
      throw new TimeParseError(`description '${description}' matches several projects: ${beforeProject}, ${afterProject}`);
    }
    if (beforeProject !== null) return { project: beforeProject, task: after.trim(), form: "keyword-first", separatorAt: colon };
    if (afterProject !== null) return { project: afterProject, task: before.trim(), form: "keyword-last", separatorAt: colon };
  }

  const project = detectProject(description, projects);
  return {
    project,
    task: description.trim(),
    form: project === UNKNOWN_PROJECT ? "none" : "keyword",
  };
}
