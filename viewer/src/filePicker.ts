// A day-file picker: a text box that filters the file names as you type, with a dropdown of the names
// that match. Enter or a click chooses a file; Escape or leaving the box puts back the chosen name.
import { el } from "./dom";

export interface FilePicker {
  element: HTMLElement;
  // The files to offer, and the one that is chosen now (shown in the box when it is not being typed in).
  setFiles(names: string[], selected: string | null): void;
}

export function filePicker(choose: (name: string) => void): FilePicker {
  const wrap = el("div", "file-picker day-picker");
  const input = el("input");
  input.type = "text";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", "day file");
  input.placeholder = "type to find a day, or open the list";
  input.autocomplete = "off";
  const toggle = el("button", "file-toggle", "▾");
  toggle.type = "button";
  toggle.title = "show all days";
  toggle.setAttribute("aria-label", "show all days");
  const list = el("ul", "suggestions hidden");
  list.setAttribute("role", "listbox");

  let names: string[] = [];
  let selected: string | null = null;
  let shown: string[] = [];
  let highlight = -1;
  let navigated = false;

  const hide = () => {
    list.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
  };
  const paint = () =>
    Array.from(list.children).forEach((node, index) => node.classList.toggle("active", index === highlight));
  const pick = (name: string) => {
    selected = name;
    input.value = name;
    hide();
    input.blur();
    choose(name);
  };
  const refresh = (showAll: boolean) => {
    const typed = showAll ? "" : input.value.trim().toLowerCase();
    shown = names.filter((name) => !typed || name.toLowerCase().includes(typed));
    list.replaceChildren();
    for (const name of shown) {
      const item = el("li", "suggestion", name);
      item.setAttribute("role", "option");
      item.addEventListener("mousedown", (event) => {
        event.preventDefault(); // keep the focus until the file is chosen
        pick(name);
      });
      list.append(item);
    }
    highlight = selected !== null ? shown.indexOf(selected) : -1;
    if (highlight < 0 && shown.length) highlight = 0;
    navigated = false;
    list.classList.toggle("hidden", shown.length === 0);
    input.setAttribute("aria-expanded", String(shown.length > 0));
    paint();
  };

  input.addEventListener("focus", () => {
    input.select();
    refresh(true);
  });
  input.addEventListener("input", () => refresh(false));
  input.addEventListener("blur", () => {
    hide();
    input.value = selected ?? "";
  });
  toggle.addEventListener("mousedown", (event) => event.preventDefault());
  toggle.addEventListener("click", () => {
    input.focus();
    refresh(true);
  });
  input.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
      event.preventDefault();
      highlight = (highlight + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      navigated = true;
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const typed = input.value.trim().toLowerCase();
      const exact = shown.find((name) => name.toLowerCase() === typed);
      const only = shown.length === 1 ? shown[0] : undefined;
      const chosen = exact ?? (navigated && highlight >= 0 ? shown[highlight] : undefined) ?? only;
      if (chosen !== undefined) pick(chosen);
      else input.value = selected ?? "";
    } else if (event.key === "Escape") {
      input.value = selected ?? "";
      input.blur();
    }
  });

  wrap.append(input, toggle, list);
  return {
    element: wrap,
    setFiles(next, current) {
      names = next;
      selected = current;
      if (document.activeElement !== input) input.value = current ?? "";
    },
  };
}
