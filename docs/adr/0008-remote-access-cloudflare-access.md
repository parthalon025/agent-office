# 0008: Remote access through Cloudflare Tunnel and Access, checked by the office

Status: accepted (owner decision, 2026-11-05, option A of #133).

## Context

The office ran only on the PC. Away from it, the owner could not see agents, answer an approval or read a diff. `CLAUDE.md` listed remote access as not built: an agent that can run commands needs real login and TLS. The owner has the domain kurat0r.ai on Cloudflare and wants an address on it (office.kurat0r.ai) with no open router port.

Options:

- A. Cloudflare Tunnel (cloudflared on the PC) plus Cloudflare Access (login, owner's email only). The office also checks the signed Access login itself.
- B. Tailscale. A private network. No public address, no new office code, but a client on every device.

## Decision

Option A. Tailscale stays a valid alternative (the README says so). The decision has five parts.

- The tunnel is outside the office. cloudflared on the PC forwards to 127.0.0.1. The office keeps binding 127.0.0.1 only. It does not start, install or configure cloudflared or the Access application.
- The office does not trust the tunnel. A request whose Host is the remote host must carry `Cf-Access-Jwt-Assertion`, an RS256 token signed by a key of the team's certificate list (`https://<team>/cdn-cgi/access/certs`), with the team issuer, the application audience tag, a current expiry and an allowed email. Verification uses `node:crypto` only (`auth.mjs`: `verifyAccessToken`). Anything else is refused before any route runs, so a leaked tunnel address or a wrong Access policy does not open the agents.
- Fail closed. Remote access is off unless all four settings are set (`OFFICE_REMOTE_HOST`, `_TEAM`, `_AUD`, `_EMAILS`), and honored only on the port they name (4317 by default), never on a branch office. A half setup stays off and the start log names what is missing. Only RS256 is accepted, with RSA keys of 2048 bits or more. The key list is cached, read again on an unknown key id (at most once a minute) and at most an hour old; a list that cannot be read opens nothing.
- The agent routes (hooks, MCP, the OpenClaw gate) refuse every remote request, with or without the agent token. The launch code is not served on the remote host, and the remote sign-in is not served on the local host.
- The page session. `POST /remote/signin` (launch group) gives the page cookie to a verified Access request, with no code in a URL. On the remote host the cookie is `Secure`, HttpOnly, SameSite=Strict and expires with the Access token. The gate also needs a valid Access token on every later request, so a stolen cookie alone opens nothing. The cookie holds a remote page token that is its own secret, new at each start, so it opens nothing on the local host. Looser changes still need their painted Confirm: that rule is in the routes, not the address.

## Consequences

- The owner does the Cloudflare steps once (tunnel, DNS route, Access application and policy, the four settings). The README walks through them.
- The page token is reachable from a remote page (as for any page). The agent token is shown only in the Attach sessions dialog, and it opens nothing remotely.
- The office verifies one issuer, one audience and a short list of emails. There are no teams, roles or shared access.
- The rules apply only while the office runs, as for every other check.
- Accepted risk: anyone who can sign in to the Access application as an allowed email controls the agents. Protect that account with a strong login method in the Access policy.
