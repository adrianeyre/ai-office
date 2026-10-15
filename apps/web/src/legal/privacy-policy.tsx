import { sessionLength } from "../session-length.ts";

/** The privacy policy's text, shown in its dialog. */
export function PrivacyPolicy() {
  return (
    <>
      <p className="policy-updated">Last updated: October 2026</p>

      <h3>Who looks after your data</h3>
      <p>
        AI Office is self-hosted. Whoever runs this copy of it (its Owner)
        decides what it holds and who can see it, and is responsible for it. The
        software sends nothing to its authors: there is no analytics, no
        tracking and no advertising, and the web app loads nothing from other
        sites. Its server only asks GitHub which version is the latest, as set
        out below.
      </p>

      <h3>What AI Office keeps</h3>
      <p>Everything is kept in the Owner&apos;s own Postgres database:</p>
      <ul>
        <li>
          <strong>People</strong> — the Owner&apos;s profile (forename, surname,
          nickname and time zone), the name, nickname and time zone of each
          person given a password of their own, who uses each API key (their
          forename, surname, nickname and time zone), the Owner&apos;s GitHub
          login, and the name and email address Agents commit as.
        </li>
        <li>
          <strong>Sign-in</strong> — each password, as a one-way hash, never the
          password itself; the sessions signed in, by a hash of their token;
          and, when two-step sign-in (TOTP) is on, its secret, encrypted, and
          its recovery codes, hashed. Every sign-in attempt is recorded with
          when it happened, whether it succeeded, the browser&apos;s IP address
          and its User-Agent.
        </li>
        <li>
          <strong>Keys and credentials</strong> — the AI Accounts&apos; API
          keys, OAuth tokens and cloud credentials, the Google account signed in
          for the Google Connections, each Connection&apos;s credentials, the
          GitHub webhook secret and the outbound proxy&apos;s password, all
          encrypted. API keys (Gateway Keys) are kept as a hash, and an
          Agent&apos;s own key encrypted too. The GitHub App&apos;s private key
          is in the server&apos;s configuration, not the database.
        </li>
        <li>
          <strong>The AI Gateway&apos;s request history</strong> — for each
          request: when, which Model and AI Account, who made it (an Agent, its
          Floor and issue, or a named tool), the tokens used, the estimated
          cost, how long it took and its headers, with keys and cookies removed.
          The prompts and answers themselves (request and response bodies) are
          kept too, encrypted, unless the Owner turns that off in AI Settings.
        </li>
        <li>
          <strong>The work</strong> — Floors, Agents, Roles, Skills, Floor
          Templates, the Office and Role memories, the work queue, reviews, QA
          and design reports, Notices, the Activity Feed (the event log), chats
          with the Managers, with Agents and in the Terminal, Grilling Sessions,
          and each Connection&apos;s delivery log. These quote GitHub issues,
          pull requests and comments, which can name the people who wrote them.
        </li>
        <li>
          <strong>Files attached in the Manager chat</strong> — the images (such
          as screenshots) and text files (such as logs) attached to a message to
          a Manager: each one&apos;s name, type, size and content, kept with the
          message that sent it. Screenshots and logs can show whatever was on
          screen or in the log, including other people&apos;s details.
        </li>
      </ul>
      <p>
        The server&apos;s own logs record each request&apos;s address and the IP
        address it came from, with passwords, keys and tokens removed.
      </p>

      <h3>Who else sees it</h3>
      <p>
        To do the work, AI Office sends issues, code, chats and prompts to the
        services the Owner connects, and only to those:
      </p>
      <ul>
        <li>
          <strong>AI providers</strong> — through the AI Gateway, to the
          provider behind each AI Account: Anthropic (Claude), OpenAI (ChatGPT),
          xAI (Grok), Google (Gemini and Vertex AI), Amazon Bedrock, OpenRouter,
          DeepSeek, Z.ai, MiniMax, Moonshot AI (Kimi), Alibaba Cloud (Qwen),
          Ollama, or any other Anthropic- or OpenAI-compatible endpoint the
          Owner names. When the Owner turns on the Decision Model, the questions
          it is asked go to it through OpenRouter. A file attached in the
          Manager chat goes to the Manager&apos;s Model with its message: a text
          file as text, with keys and tokens removed, and an image as an image
          where the Model can see one. So do the repository files a message
          mentions with <code>@</code>.
        </li>
        <li>
          <strong>GitHub</strong> — through the Owner&apos;s GitHub App: its
          issues, code, branches, pull requests and comments are read and
          written, and, when webhooks are on, GitHub tells AI Office of changes.
          Separately, to find out whether a newer version of AI Office is out,
          its server asks GitHub for AI Office&apos;s own{" "}
          <code>package.json</code> as the app opens and when you check in
          Admin; nothing else is sent with it.
        </li>
        <li>
          <strong>Connections</strong> — the notifications, Digests and reports
          the Owner chooses go to Slack, email (through the Owner&apos;s mail
          server), ntfy, Pushover, webhooks, Confluence, Notion, or Google
          Sheets, Docs, Slides, Drive and Calendar, as links only or with titles
          and summaries.
        </li>
      </ul>
      <p>
        Agents work in Docker sandboxes on the Owner&apos;s own machine. When
        the Owner sets an outbound proxy, requests to AI providers go through
        it. What each service does with what it is sent is set out in its own
        privacy policy.
      </p>

      <h3>How long it is kept</h3>
      <p>
        A session lasts {sessionLength}, or until you sign out. By default,
        request and response bodies are deleted after 7 days; request records,
        AI Accounts&apos; usage readings and Connections&apos; delivery logs
        after 90 days; and the Activity Feed, closed Notices and sign-in
        attempts after 365 days. What deleted requests used is kept as daily
        totals, without their content, so Token Caps and Analytics still count
        it. The Owner can change these periods, and delete older history sooner,
        in General Settings. A file attached in the Manager chat is kept as long
        as the message that sent it, and deleted with it; one attached but never
        sent is deleted after a day. Everything else is kept until the Owner
        deletes it.
      </p>

      <h3>Your rights</h3>
      <p>
        To see, correct or delete what this copy of AI Office holds about you,
        ask its Owner.
      </p>
    </>
  );
}
