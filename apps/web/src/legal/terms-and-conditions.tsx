/** The terms and conditions' text, shown in their dialog. */
export function TermsAndConditions() {
  return (
    <>
      <p className="policy-updated">Last updated: October 2026</p>

      <h3>Using AI Office</h3>
      <p>
        AI Office is software you run yourself. By using this copy of it, you
        agree to these terms and to any its Owner adds.
      </p>

      <h3>Your accounts and their terms</h3>
      <p>
        You connect your own GitHub App, AI Accounts and Connections (such as
        Slack, Google or Notion), and their providers&apos; terms still apply.
        Some subscriptions limit automated use, or use by more than one person:
        check yours before AI Office load-balances across it. Where an AI
        provider bills extra usage or charges by the token, those charges are
        yours.
      </p>

      <h3>Passwords and API keys</h3>
      <p>
        Keep your passwords, recovery codes and API keys (Gateway Keys) secret.
        Anyone you give a password, or an API key with web app access, can use
        this copy of AI Office as you can; any API key lets its holder use your
        AI Accounts through the AI Gateway. You are responsible for what is done
        with them, and can disable or revoke a key in API Key Management.
      </p>

      <h3>The work Agents do</h3>
      <p>
        Agents write code, comments and pull requests in your repositories on
        your behalf, and run commands in Docker sandboxes on your machine.
        Review their work before you merge or ship it: you are responsible for
        what is merged, for what the Communications Agent sends through your
        Connections, and for keeping within the Token Caps and budgets you set.
        Skills and Floor Templates you import from other repositories are yours
        to check before Agents use them.
      </p>

      <h3>No warranty</h3>
      <p>
        AI Office is provided as it is, without warranty of any kind. Its
        authors are not liable for any loss arising from its use, including AI
        providers&apos; charges, to the extent the law allows.
      </p>

      <h3>Changes</h3>
      <p>
        These terms may change with new versions of AI Office; the date above
        says when they last did.
      </p>
    </>
  );
}
