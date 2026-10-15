import { ShieldCheck } from "lucide-react";

import { issuesUrl } from "./links.ts";

/** The accessibility statement's text, shown in its dialog. */
export function AccessibilityStatement() {
  return (
    <>
      <p className="policy-updated">Last reviewed: October 2026</p>

      <div className="status-box">
        <ShieldCheck className="size-5" aria-hidden />
        <p>
          <strong>Conformance status:</strong> AI Office is built to meet the
          Web Content Accessibility Guidelines (WCAG) 2.2 at{" "}
          <strong>Level AA</strong>.
        </p>
      </div>

      <h3>What we have done</h3>
      <ul>
        <li>
          <strong>Keyboard access</strong> — every control, menu and dialog
          works with a keyboard alone, with a clear focus outline that is never
          hidden behind other content. A &ldquo;Skip to main content&rdquo; link
          leads each page.
        </li>
        <li>
          <strong>The 3D Office</strong> — everything you can do in it can also
          be done from its 2D panels and the keyboard: the lift&apos;s floor
          picker, and an &ldquo;Inspect&rdquo; list of every object on the
          Floor, moved through with the arrow keys, opens each object&apos;s
          panel as clicking it does. Each panel has its own address, and the
          Notice Board, Activity Feed and other pages hold the same information.
        </li>
        <li>
          <strong>Rearranging</strong> — the navigation&apos;s items move with
          Alt and the up and down arrows, and its width with the left and right
          arrows; Analytics&apos; widgets move with the arrow keys, and resize
          with Shift and the arrows.
        </li>
        <li>
          <strong>Screen readers</strong> — every page has its own title, one
          main heading and labelled landmarks; every control has a name, and
          errors, saved changes and the lobby receptionist&apos;s greeting are
          announced as they happen.
        </li>
        <li>
          <strong>Colour and contrast</strong> — text has at least 4.5:1
          contrast with its background, and controls, icons and focus outlines
          at least 3:1. Nothing is shown by colour alone.
        </li>
        <li>
          <strong>Themes</strong> — light, dark or matching your device, and six
          colour themes, on the Admin page. Every theme meets these contrast
          ratios in both light and dark, and Windows Contrast Themes are
          respected.
        </li>
        <li>
          <strong>Motion</strong> — animations are short, and switched off when
          your device asks for reduced motion; the 3D Office has its own
          reduced-motion setting too, which cuts the camera straight to each
          view.
        </li>
        <li>
          <strong>Sound and notifications</strong> — the 3D Office&apos;s sound
          is muted until you turn it on, and the browser asks before showing a
          notification only once you turn notifications on in General Settings.
        </li>
        <li>
          <strong>Zoom and reflow</strong> — pages reflow on narrow screens and
          when zoomed, and text spacing can be changed; wide tables and dialog
          contents scroll on their own instead of the page.
        </li>
        <li>
          <strong>Target sizes</strong> — every control is at least 24 by 24
          pixels.
        </li>
        <li>
          <strong>Sign-in</strong> — the password and code fields accept pasting
          and password managers; no puzzle is ever asked.
        </li>
        <li>
          <strong>Checked automatically</strong> — every page, dialog and panel
          is checked with the axe-core accessibility engine, in light and dark,
          and keyboard use and focus are checked in a real browser, by the
          end-to-end tests.
        </li>
      </ul>

      <h3>Known limitations</h3>
      <ul>
        <li>
          The 3D Office needs a browser with WebGL 2. Without it, the Office
          page says so, and every other page works as usual.
        </li>
        <li>
          The 3D scene itself is hidden from screen readers: what is in it is
          read from its lists and panels instead.
        </li>
      </ul>

      <h3>Feedback</h3>
      <p>
        If something is hard to use, please{" "}
        <a href={issuesUrl} target="_blank" rel="noopener noreferrer">
          open an issue on GitHub
          <span className="sr-only">, opens in a new tab</span>
        </a>{" "}
        saying what you were trying to do, and with which browser and assistive
        technology.
      </p>
    </>
  );
}
