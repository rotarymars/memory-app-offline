// A tiny element builder so views can be written as nested calls instead of
// innerHTML. Card text is user content, so it only ever goes in as text nodes.

/**
 * h("button", { class: "btn", onclick: fn, disabled: true }, "保存")
 *
 * Props: `class`, `style` (string or object), `dataset`, `on<event>`
 * handlers, boolean/DOM properties (value, checked, disabled, hidden…),
 * anything else as an attribute (aria-*, for, type…). Children may be
 * strings, numbers, nodes, arrays, or null/false (skipped).
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key.startsWith("on") && typeof value === "function")
        el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in PROPERTIES) el[key] = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

const PROPERTIES = {
  value: 1,
  checked: 1,
  disabled: 1,
  hidden: 1,
  selected: 1,
  multiple: 1,
  textContent: 1,
  htmlFor: 1,
  tabIndex: 1,
  indeterminate: 1,
  rows: 1,
  placeholder: 1,
  accept: 1,
  required: 1,
  type: 1,
  href: 1,
  src: 1,
  alt: 1,
  title: 1,
  name: 1,
  id: 1,
  min: 1,
  max: 1,
  autocomplete: 1,
  spellcheck: 1,
};

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Replaces `el`'s children. */
export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function plural(n, unit) {
  return `${n}${unit}`;
}

/** A `<button>` that toggles aria-pressed, for filter chips. */
export function toggleChip(label, pressed, onToggle, extra = null) {
  return h(
    "button",
    {
      type: "button",
      class: "filter-chip",
      "aria-pressed": pressed ? "true" : "false",
      onclick: () => onToggle(!pressed),
    },
    label,
    extra
  );
}

// Escape hatch for "is the user typing?" checks in keyboard shortcuts.
export function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
