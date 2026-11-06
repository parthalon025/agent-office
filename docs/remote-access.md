# Remote access

You can open the office from your phone or laptop at an address on your own domain, for example `office.example.com`, through a Cloudflare Tunnel and Cloudflare Access. No router port is opened. Access lets only your email in, and the office also checks the signed Access login on every request from that address, so a request that did not pass Access is refused even if it reaches your PC. Tailscale is another way to do this; the office needs no setting for it.

Set it up once:

1. Install `cloudflared` on the PC and sign in to Cloudflare. Create a tunnel and route a host name to it (`cloudflared tunnel route dns <tunnel> office.example.com`). In the tunnel config, point the host at `http://127.0.0.1:4317`. The office does not start or change cloudflared.
2. In Cloudflare Zero Trust, add a self-hosted Access application for `office.example.com`. Add one Allow policy: your email only. Copy the **Application Audience (AUD) tag** from the application, and your **team domain** (`<name>.cloudflareaccess.com`) from Settings.
3. Set these four variables for the office (all four are needed) and start it:

| Variable | Value |
| --- | --- |
| `OFFICE_REMOTE_HOST` | The public host name, `office.example.com`. No port. |
| `OFFICE_REMOTE_TEAM` | The Access team domain, `<name>.cloudflareaccess.com`. |
| `OFFICE_REMOTE_AUD` | The application audience tag. |
| `OFFICE_REMOTE_EMAILS` | Your email. A comma separated list for more than one. |

`OFFICE_REMOTE_PORT` (default `4317`) is the one port that honors them. A branch office or a test office never does. If a setting is missing or wrong, the office stays off for remote requests and the start log names it. When it is on, the log says `Remote access is on at https://...`, and the Attach sessions dialog shows the address.

Open `https://office.example.com` and sign in with Access. The page takes its session from your Access login with no launch code, and the session ends when the Access login ends. Each sign-in writes a feed line with your email. Looser changes (Allow rules, No limit, a pull request, removing a room) still need their painted Confirm.

What does not work from the remote address: hooks, MCP and the OpenClaw gate. Agents run on the PC and post to `127.0.0.1`. Check once by hand: a request to the address without Access (for example with `curl`) must give 403 or the Access login page.
Decision record: [ADR 0008](adr/0008-remote-access-cloudflare-access.md). Other safety rules: [Security](security.md).
