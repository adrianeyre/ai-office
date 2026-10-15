// The AI Office website's enhancements, which site/build.ts strips of their
// types into script.js. The page works without them: every system's steps
// show one after another, screenshots open as plain links, and the policies
// are read at the foot of the page. With them, there are a menu button on
// phones, the Quick start's system tabs, copy buttons on every command, a
// screenshot viewer, the setup guide's progress, and the policies in
// dialogs, as in the app's footer. Nothing is stored: the page sets no
// cookies and uses no browser storage (its Cookie Policy says so).

const icon = (name: string): string =>
  `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${name}" /></svg>`;

/** The element `event` happened on, when it is one. */
const targetOf = (event: Event): Element | null =>
  event.target instanceof Element ? event.target : null;

const announcer = document.getElementById("announcer");

/** Says `message` to screen readers, through the page's status region. */
function announce(message: string): void {
  if (announcer === null) return;
  announcer.textContent = "";
  // Emptied first, so the same message is read again.
  setTimeout(() => {
    announcer.textContent = message;
  }, 50);
}

/* ---------- Dialogs ---------- */

interface Dialog {
  readonly dialog: HTMLDialogElement;
  readonly heading: HTMLHeadingElement;
  readonly body: HTMLDivElement;
  readonly foot: HTMLDivElement;
  readonly open: () => void;
}

/**
 * A modal dialog on the platform's <dialog>, as the app's: a title with a
 * close button, a body that scrolls on its own and takes focus, and a
 * footer. It moves focus in, closes on Escape and on the backdrop, and
 * hands focus back to whatever opened it.
 */
function makeDialog({
  id,
  title,
  closeLabel,
  className = "",
}: {
  id: string;
  title: string;
  closeLabel: string;
  className?: string;
}): Dialog {
  const dialog = document.createElement("dialog");
  dialog.className = `dialog ${className}`.trim();
  const titleId = `${id}-dialog-title`;
  dialog.setAttribute("aria-labelledby", titleId);

  const head = document.createElement("div");
  head.className = "dialog-head";
  const heading = document.createElement("h2");
  heading.id = titleId;
  heading.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button";
  close.dataset["close"] = "";
  close.setAttribute("aria-label", closeLabel);
  close.innerHTML = icon("x");
  head.append(heading, close);

  // Focusable, so the keyboard can scroll it (WCAG 2.1.1).
  const body = document.createElement("div");
  body.className = "dialog-body";
  body.setAttribute("role", "region");
  body.setAttribute("aria-labelledby", titleId);
  body.tabIndex = 0;

  const foot = document.createElement("div");
  foot.className = "dialog-foot";
  dialog.append(head, body, foot);

  let returnTo: HTMLElement | null = null;
  const open = () => {
    returnTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    close.focus();
  };
  dialog.addEventListener("close", () => {
    returnTo?.focus();
    returnTo = null;
  });
  dialog.addEventListener("click", (event) => {
    // A click on the backdrop lands on the dialog element itself.
    if (event.target === dialog || targetOf(event)?.closest("[data-close]")) {
      dialog.close();
    }
  });
  document.body.append(dialog);
  return { dialog, heading, body, foot, open };
}

function closeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.dataset["close"] = "";
  button.textContent = "Close";
  return button;
}

/* ---------- The menu button, on phones ---------- */

const toggle = document.querySelector<HTMLButtonElement>(".menu-toggle");
const nav = document.getElementById("site-nav");
if (toggle !== null && nav !== null) {
  const phone = matchMedia("(max-width: 52rem)");
  const isOpen = () => nav.classList.contains("is-open");
  const setOpen = (open: boolean) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute(
      "aria-label",
      open ? "Close the menu" : "Open the menu",
    );
    toggle.innerHTML = icon(open ? "x" : "menu");
  };
  const sync = () => {
    toggle.hidden = !phone.matches;
    if (!phone.matches) setOpen(false);
  };
  toggle.addEventListener("click", () => {
    setOpen(!isOpen());
  });
  nav.addEventListener("click", (event) => {
    if (targetOf(event)?.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });
  // A click anywhere else closes it. By the click's path, not its target:
  // the button's icon is replaced as it opens, so the target is gone.
  document.addEventListener("click", (event) => {
    const path = event.composedPath();
    if (isOpen() && !path.includes(nav) && !path.includes(toggle)) {
      setOpen(false);
    }
  });
  phone.addEventListener("change", sync);
  sync();
}

/* ---------- The Quick start's system tabs ---------- */

const tabsContainer = document.querySelector<HTMLElement>("[data-os-tabs]");
if (tabsContainer !== null) {
  const panels = [...tabsContainer.querySelectorAll<HTMLElement>(".os-panel")];
  const platform = (
    (navigator as Navigator & { userAgentData?: { platform: string } })
      .userAgentData?.platform ?? navigator.platform
  ).toLowerCase();
  const guess = platform.includes("win")
    ? "windows"
    : platform.includes("mac")
      ? "macos"
      : platform.includes("linux")
        ? "linux"
        : "windows";

  const tablist = document.createElement("div");
  tablist.className = "os-tablist";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Operating system");

  const tabs = panels.map((panel) => {
    const heading = panel.querySelector("h3");
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "os-tab";
    tab.id = `${panel.id}-tab`;
    tab.textContent = heading?.textContent ?? panel.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    heading?.classList.add("visually-hidden");
    tablist.append(tab);
    return tab;
  });

  const select = (index: number, focus: boolean) => {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = panels[i];
      if (panel !== undefined) panel.hidden = !selected;
    });
    if (focus) tabs[index]?.focus();
  };

  const last = tabs.length - 1;
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      select(index, false);
    });
    tab.addEventListener("keydown", (event) => {
      const next = new Map([
        ["ArrowRight", index === last ? 0 : index + 1],
        ["ArrowLeft", index === 0 ? last : index - 1],
        ["Home", 0],
        ["End", last],
      ]).get(event.key);
      if (next === undefined) return;
      event.preventDefault();
      select(next, true);
    });
  });

  tabsContainer.prepend(tablist);
  tabsContainer.classList.add("is-tabbed");
  select(
    Math.max(
      0,
      panels.findIndex((panel) => panel.dataset["os"] === guess),
    ),
    false,
  );
}

/* ---------- Copy buttons on every command ---------- */

document.querySelectorAll("pre").forEach((pre, index) => {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";
  pre.before(wrapper);
  wrapper.append(pre);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.setAttribute("aria-label", "Copy the commands");
  button.title = "Copy";
  button.innerHTML = icon("copy");
  if (pre.id === "") pre.id = `code-${String(index + 1)}`;
  button.setAttribute("aria-describedby", pre.id);
  wrapper.append(button);

  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", () => {
    // Without the prompts' `$ `, which are not part of the commands.
    const copy = pre.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".prompt").forEach((prompt) => {
      prompt.remove();
    });
    navigator.clipboard.writeText(copy.textContent.trim()).then(
      () => {
        button.dataset["copied"] = "";
        button.innerHTML = icon("check");
        announce("Copied to the clipboard.");
        clearTimeout(timer);
        timer = setTimeout(() => {
          delete button.dataset["copied"];
          button.innerHTML = icon("copy");
        }, 2000);
      },
      () => {
        announce("Could not copy: select the text and copy it instead.");
      },
    );
  });
});

/* ---------- The screenshot viewer ---------- */

const shots = [
  ...document.querySelectorAll<HTMLAnchorElement>("a[data-lightbox]"),
];
if (shots.length > 0) {
  const viewer = makeDialog({
    id: "screenshot",
    title: "Screenshot",
    closeLabel: "Close the screenshot",
    className: "lightbox",
  });
  const image = document.createElement("img");
  image.decoding = "async";
  viewer.body.append(image);

  const caption = document.createElement("p");
  caption.className = "lightbox-caption";
  const count = document.createElement("span");
  count.className = "lightbox-count";
  count.setAttribute("aria-live", "polite");
  const step = (label: string, name: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.setAttribute("aria-label", label);
    button.innerHTML = icon(name);
    return button;
  };
  const previous = step("Previous screenshot", "chevron-left");
  const next = step("Next screenshot", "chevron-right");
  viewer.foot.append(caption, count, previous, next);

  let current = 0;
  const show = (index: number) => {
    current = (index + shots.length) % shots.length;
    const link = shots[current];
    if (link === undefined) return;
    const thumbnail = link.querySelector("img");
    image.src = link.href;
    image.alt = thumbnail?.alt ?? "";
    if (thumbnail !== null) {
      image.width = thumbnail.width;
      image.height = thumbnail.height;
    }
    const figcaption = link.closest("figure")?.querySelector("figcaption");
    caption.innerHTML = figcaption?.innerHTML ?? "";
    viewer.heading.textContent =
      figcaption?.querySelector("strong")?.textContent.replace(/\.$/, "") ??
      "Screenshot";
    count.textContent = `${String(current + 1)} of ${String(shots.length)}`;
  };

  previous.addEventListener("click", () => {
    show(current - 1);
  });
  next.addEventListener("click", () => {
    show(current + 1);
  });
  viewer.dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      show(current + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });

  shots.forEach((link, index) => {
    link.setAttribute("aria-haspopup", "dialog");
    link.addEventListener("click", (event) => {
      // A new tab or window, as the browser would.
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      show(index);
      viewer.open();
    });
  });
}

/* ---------- The setup guide's progress ---------- */

const tocLinks = [
  ...document.querySelectorAll<HTMLAnchorElement>(".toc a[href^='#']"),
];
const steps = tocLinks.flatMap((link) => {
  const step = document.getElementById(link.hash.slice(1));
  return step === null ? [] : [{ link, step }];
});
const visible = new Set<Element>();
const progress = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    // The first step on screen is the one being read.
    const reading = steps.find(({ step }) => visible.has(step));
    for (const { link } of steps) {
      if (link === reading?.link) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    }
  },
  { rootMargin: "-20% 0px -55% 0px" },
);
for (const { step } of steps) progress.observe(step);

/* ---------- The policies, in dialogs ---------- */

const policies = new Map<string, Dialog>();
document.querySelectorAll<HTMLElement>(".policy").forEach((section) => {
  const policy = makeDialog({
    id: section.id,
    title: section.querySelector("h2")?.textContent ?? "",
    closeLabel: section.dataset["closeLabel"] ?? "Close",
  });
  const body = section.querySelector(".policy-body");
  if (body !== null) policy.body.append(...body.childNodes);
  policy.foot.append(closeButton());
  policies.set(section.id, policy);
});
document.getElementById("policies")?.remove();

// The footer's links become buttons that open them, as in the app.
document
  .querySelectorAll<HTMLAnchorElement>("a[data-policy]")
  .forEach((link) => {
    const policy = policies.get(link.dataset["policy"] ?? "");
    if (policy === undefined) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = link.className;
    button.setAttribute("aria-haspopup", "dialog");
    button.textContent = link.textContent;
    button.addEventListener("click", policy.open);
    link.replaceWith(button);
  });

// An address that names a policy, such as #privacy-policy, opens it.
const openFromAddress = () => {
  const policy = policies.get(location.hash.slice(1));
  if (policy !== undefined && !policy.dialog.open) policy.open();
};
addEventListener("hashchange", openFromAddress);
openFromAddress();
