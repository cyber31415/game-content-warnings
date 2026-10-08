import { EBS_BASE } from "./env.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function ebs<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(EBS_BASE + path, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new HttpError(res.status, typeof err.error === "string" ? err.error : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Small DOM builder: text is always set via textContent, never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: (Node | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Off-site link with the visible marker Twitch requires (guideline 4.6.2). */
export function externalLink(href: string, text: string): HTMLAnchorElement {
  const a = el("a", { text, attrs: { href, target: "_blank", rel: "noopener noreferrer" } });
  a.append(
    el("span", { className: "offsite", text: " ↗", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "visually-hidden", text: " (opens an external site in a new tab)" }),
  );
  return a;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The extension's mark: an amber warning triangle (same shape as the listing icon). Decorative. */
export function brandMark(size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("mark");
  const tri = document.createElementNS(SVG_NS, "path");
  tri.setAttribute("d", "M12 2.5 22.5 20.5H1.5Z");
  tri.setAttribute("class", "mark-tri");
  tri.setAttribute("stroke-linejoin", "round");
  const bang = document.createElementNS(SVG_NS, "path");
  bang.setAttribute("d", "M12 9v5.5M12 17.2v.3");
  bang.setAttribute("class", "mark-bang");
  bang.setAttribute("stroke-linecap", "round");
  svg.append(tri, bang);
  return svg;
}

export function applyTheme(theme: string | undefined): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}
