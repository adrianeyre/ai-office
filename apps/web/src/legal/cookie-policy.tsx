import { sessionLength } from "../session-length.ts";

const storage = [
  {
    name: "ai_office_session",
    kind: "Cookie",
    purpose:
      "Keeps you signed in. HttpOnly, SameSite=Strict, and Secure over HTTPS.",
    lasts: `${sessionLength}, or until you sign out`,
  },
  {
    name: "ai_office_sign_in",
    kind: "Cookie",
    purpose:
      "Set only when two-step sign-in is on: links your password to the code you type next. HttpOnly, SameSite=Strict, sent only with sign-in requests, and Secure over HTTPS.",
    lasts: "5 minutes, or until the code is accepted",
  },
  {
    name: "ai-office:appearance",
    kind: "Local storage",
    purpose: "Light, dark or system mode, and the colour theme.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:navigation-order",
    kind: "Local storage",
    purpose: "The order you dragged the navigation's items into.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:navigation-collapsed",
    kind: "Local storage",
    purpose: "Whether the navigation is collapsed to its icons.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:navigation-width",
    kind: "Local storage",
    purpose: "How wide you made the navigation.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:scene-settings",
    kind: "Local storage",
    purpose:
      "The 3D Office's quality, reduced-motion, frame-rate and above-head display settings.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:sound-settings",
    kind: "Local storage",
    purpose:
      "The 3D Office's sound: muted or not, its volumes, and each Floor's ambience.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:analytics-layout",
    kind: "Local storage",
    purpose: "Where you moved and how you sized the widgets on Analytics.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:inspector-panels",
    kind: "Local storage",
    purpose:
      "Where you moved each kind of panel over the 3D Office, how you sized it, and whether it fills the screen.",
    lasts: "Until you clear your browser's site data",
  },
  {
    name: "ai-office:notice-alerts",
    kind: "Local storage",
    purpose:
      "Which Notices this browser alerts you to, and whether with a sound.",
    lasts: "Until you clear your browser's site data",
  },
] as const;

/** The cookie policy's text, shown in its dialog. */
export function CookiePolicy() {
  return (
    <>
      <p className="policy-updated">Last updated: October 2026</p>

      <h3>Strictly necessary only</h3>
      <p>
        AI Office sets two cookies, which sign you in and keep you signed in,
        and remembers your settings in your browser&apos;s local storage. All of
        them are needed for the features you use, so none needs your consent,
        and nothing is used for analytics, tracking or advertising. The token
        that guards your changes against other sites (CSRF) is kept only in the
        open page&apos;s memory, and whether this browser may show notifications
        is kept by the browser itself.
      </p>

      <h3>What is stored</h3>
      <div className="table-scroll">
        <table>
          <caption>Cookies and browser storage AI Office uses</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Purpose</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            {storage.map(({ name, kind, purpose, lasts }) => (
              <tr key={name}>
                <th scope="row">
                  <code>{name}</code>
                </th>
                <td>{kind}</td>
                <td>{purpose}</td>
                <td>{lasts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Removing them</h3>
      <p>
        Signing out removes the session cookie; the sign-in cookie goes once
        your code is accepted, or after 5 minutes. To remove the settings, clear
        this site&apos;s data in your browser; each goes back to its default.
      </p>
    </>
  );
}
