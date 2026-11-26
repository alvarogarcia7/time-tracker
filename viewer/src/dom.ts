// Small helpers for building the viewer's DOM. Text comes from the user's files, so it always goes in
// with textContent, never innerHTML.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function dot(color: string | undefined): HTMLElement {
  const node = el("span", color ? "dot" : "dot hollow");
  if (color) node.style.background = color;
  return node;
}
