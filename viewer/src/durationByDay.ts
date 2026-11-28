// The duration by day: a column per day, stacked by project, with hour gridlines and the day total on each bar.
// The week view and the reports both draw it, so both show the same bars.
import { UNKNOWN_COLOR, formatMinutes } from "@core/summary";
import type { WeekDay } from "@core/week";
import { dot, el } from "./dom";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// "Mon 09-11": the weekday, then the day and month as in the file names.
function dayLabel(date: string): string {
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 is Monday
  return `${WEEKDAY_NAMES[weekday]} ${date.slice(8, 10)}-${date.slice(5, 7)}`;
}

// The plot, the day labels and the legend, as the parts of one card. Each column is one day, stacked by project,
// bottom to top, in the order of projects.
export function durationByDay(days: WeekDay[], projects: string[], colors: Map<string, string>): HTMLElement[] {
  const peak = Math.max(0, ...days.map((day) => day.minutes));
  const top = Math.max(60, Math.ceil(peak / 60) * 60); // the axis runs to a whole hour
  const hourStep = top > 8 * 60 ? 2 : 1;
  const columnsStyle = `repeat(${days.length}, minmax(0, 1fr))`;

  const plot = el("div", "week-plot");
  for (let hour = 0; hour * 60 <= top; hour += hourStep) {
    const line = el("div", "week-tick");
    line.style.bottom = `${((hour * 60) / top) * 100}%`;
    line.append(el("span", "week-tick-label", `${hour}h`));
    plot.append(line);
  }
  const columns = el("div", "week-columns");
  columns.style.gridTemplateColumns = columnsStyle;
  for (const day of days) {
    const column = el("div", "week-col");
    if (day.minutes > 0) {
      const height = (day.minutes / top) * 100;
      const stack = el("div", "week-bar");
      stack.style.height = `${height}%`;
      for (const project of projects) {
        const minutes = day.byProject.get(project);
        if (!minutes) continue;
        const segment = el("div", "week-seg");
        segment.style.flexGrow = String(minutes);
        segment.style.background = colors.get(project) ?? UNKNOWN_COLOR;
        segment.title = `${project}: ${formatMinutes(minutes)}`;
        stack.append(segment);
      }
      const total = el("span", "week-total", formatMinutes(day.minutes));
      total.style.bottom = `calc(${height}% + 4px)`;
      column.append(stack, total);
    }
    column.title = `${dayLabel(day.date)}: ${formatMinutes(day.minutes)}`;
    columns.append(column);
  }
  plot.append(columns);

  const labels = el("div", "week-labels");
  labels.style.gridTemplateColumns = columnsStyle;
  for (const day of days) labels.append(el("span", "week-label", dayLabel(day.date)));

  const legend = el("div", "legend");
  for (const project of projects) {
    const item = el("div", "legend-item");
    item.append(dot(colors.get(project)), el("span", "legend-name", project));
    legend.append(item);
  }
  return [plot, labels, legend];
}
