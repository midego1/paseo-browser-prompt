# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue for
a vulnerability. Include the plugin version or commit, your Paseo version, what you did, and what
happened. You should get a first response within a week.

Do not include real secrets, tokens or private prompts in a report; describe them or use fake values.

## What data goes where

| Data | Where it goes | When |
| --- | --- | --- |
| Prompt text (card steps plus a fixed header) | Clipboard of the device you use | ChatGPT Desktop and Web, Claude Desktop, Copy |
| Prompt text | `https://chatgpt.com/?hints=agent&q=...` in your browser (OpenAI, browser history) | ChatGPT web mode, only when the prompt is short and has nothing that looks like a credential |
| Prompt text | Plugin memory on your Paseo daemon, under a random one-time id, at most 10 minutes; then the ChatGPT app via its `codex://` deep link, or the Claude app via its `claude://` deep link | ChatGPT desktop and Claude desktop |
| Launcher URL `http://<own Tailscale IP or 127.0.0.1>:5299/open?id=<id>` | Your browser; contains no prompt text | ChatGPT desktop and Claude desktop |
| Card steps plus a fixed safety preamble | A new agent on your own Paseo daemon, and that agent's model provider (Anthropic by default); with Claude in Chrome also Anthropic's bridge to your Chrome | Paseo browser, Server browser, Claude in Chrome |
| The pages a Server browser run opens, and their host names | Fetched from the Paseo server's network by a headless Chromium in a Docker container on that server; names resolved by the public resolvers 1.1.1.1 and 9.9.9.9; page text and screenshots go to the agent's model provider as tool output | Server browser |
| Image build: the pinned Playwright base image and the pinned `@playwright/mcp` package | Downloaded on the Paseo server from `mcr.microsoft.com` (when not there yet) and the npm registry; the build context is written to the state directory below | Server browser: only when the owner presses Download and build, then Confirm download, in the plugin settings |
| Your login sessions (cookies, local storage, history) for every site you log in to in the signed-in browser | The Docker volume `bp-si-<id>-profile` on the Paseo server, used only by the signed-in browser's container; removed by **Log out of everything** | Signed-in Server browser |
| The signed-in browser's live desktop (video), your taps and typing | Between your device and the relay on the Paseo server's Tailscale address (WebRTC over TCP, encrypted with DTLS-SRTP, inside Tailscale); not recorded | Signed-in Server browser: Log in to sites, Take over |
| The viewer key and the relay's status token (random, 256 bits), and neko's generated passwords | `signed-in/keys.json` (mode 0600) in the state directory below; the relay and neko containers' environment | Signed-in Server browser |
| Image build: the pinned neko image | Downloaded on the Paseo server from `ghcr.io` | Signed-in Server browser: only after Download and build, then Confirm download |
| The browser agent's final report (up to 4,000 characters), escaped and framed as untrusted output | The agent whose chat showed the card, and that agent's model provider | Report back to chat: Auto (default) only when that chat runs in an ask-first mode, or Always |
| Title, outcome and run agent id only | The agent whose chat showed the card | Report back to chat: Auto, when that chat runs in any other mode |
| Browser screenshots (viewport PNG after each step) | The browser agent's model provider, as tool output; a private copy kept by Paseo on the daemon host; shown as a thumbnail on the card in your Paseo app | Show live screenshot (on by default) |
| A browser agent's question for the chat (up to 1,500 characters), escaped and framed as untrusted text by the plugin | The agent whose chat showed the card, and that agent's model provider, in any permission mode | Talk to the chat (on by default, at most 10 per run by default) |
| Ids of runs that already reported | `reported-runs.json` in the state directory below | Report back to chat |
| Ids of runs the plugin archived after a successful run | `archived-runs.json` in the state directory below | Archive the agent after a successful run |
| Settings, done marks, card-to-agent links | Paseo host settings on your daemon | Always |
| Updater state, log, commit-only Git history | The state directory on the daemon host: `$XDG_STATE_HOME/paseo-plugin-browser-prompt/` when `XDG_STATE_HOME` is set, else `~/.local/state/paseo-plugin-browser-prompt/` | Git installs, once a check or update ran |
| The chat's own timeline (assistant messages and their ids) | Read by the card in your Paseo app, kept in memory to recognize repeated blocks; not sent anywhere | A chat with browser-prompt cards |
| `git ls-remote` / `git fetch` | The `https://` remote the plugin was installed from | Git installs: automatically only after the owner enabled auto-update for that remote; otherwise only when the owner presses Check now or Update now |

The plugin does not read the clipboard, does not log prompt text, and sends no telemetry.

## Server browser

**What runs where.** The run's agent runs on your Paseo daemon like any run. A Paseo browser run
drives the tabs of your Paseo desktop app (that browser lives only in the desktop app), a Claude in
Chrome run your real Chrome. A Server browser run instead gets a headless Chromium in its own Docker
container on the daemon host. The agent's provider process starts the plugin's launcher
(`node …/launch.mjs <plan>`) as an MCP server over stdio; per session the launcher creates an
internal Docker network, a proxy sidecar and the browser container, and removes all three when the
session ends. Before it runs anything it checks the plan again (defense in depth): the pinned image,
an `--internal` network, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, `--cap-add` at most
`SYS_CHROOT` for the browser, the expected networks, and no mounts, devices, privileged mode, host
namespaces, published ports or unconfined seccomp/AppArmor. The plugin adds that MCP server only to agents that carry the plugin's run labels plus
`browser-prompt-browser: server`, and only with a one-time ticket the daemon issued for that chat
and card right before the run was created, or, when an existing run's session opens again, with the
card's run record marked `browser:server`. No other agent gets it, and an agent that copies the
labels gets it only with a fresh, unused ticket. At most 3 runs have a browser at once: the cap is
checked when the card asks for a ticket and again on every session open (create, resume, refresh,
import); a run counts from the moment it is admitted until its browser container exists, and when
Docker cannot be asked how many are running, no browser is given (fail closed).

**What is isolated.**

- The browser container is alone on an `--internal` Docker network: no gateway and no route to
  anything but the sidecar, and names outside it do not resolve. Checked on rootless Docker 28.5:
  in a throwaway container on an `--internal` network (resolver Docker's embedded `127.0.0.11`),
  `getent hosts example.com`, `getent hosts paseo-box.tail60821.ts.net` and `getent hosts
  one.one.one.one` all exit 2 (not resolved), and direct TCP connections to a tailnet, a private, a
  public and the host's own address fail with "network unreachable". Chromium and the Playwright MCP
  process share that container, so a browser exploit or a misused tool has no network path except
  the proxy, which applies the rules below in a different container.
- The proxy sidecar is the only container of the session with a route out (Docker's default bridge;
  with rootless Docker, user-mode networking whose host-loopback access is off by default). It
  accepts connections only from the session's internal network, so other containers on the bridge
  cannot use it.
- Both containers: no host mounts (only tmpfs on `/tmp`), no published ports, no devices, the image's
  unprivileged `pwuser`, `--cap-drop ALL`, `no-new-privileges`, a read-only root file system, memory
  without extra swap, CPU and process limits (browser 1.5 GB / 1.5 CPUs / 512 processes, sidecar 256
  MB / 0.5 CPU / 64), no container log, never pulled.
- The browser container uses Playwright's seccomp profile (Docker's default plus user namespaces;
  Playwright's `utils/docker/seccomp_profile.json` at tag v1.65.1, byte for byte, pinned by its
  sha256 `cc3e61ca…1cc7849`; the plugin refuses to write another) and keeps `CAP_SYS_CHROOT` in its
  bounding set only, so Chromium's own sandbox (namespace sandbox) runs; `pwuser` has no effective
  capability and cannot chroot. It does not start with `--cap-drop ALL` alone: the zygote cannot set
  up its sandbox without that capability inside its user namespace, and with Docker's default
  seccomp profile it cannot create the namespace at all. The sidecar keeps Docker's default profile.
- The browser profile is in memory, downloads are refused, service workers are blocked, `file://`
  navigation is blocked, and Playwright MCP's files (screenshots, snapshots) stay in the container.
  A filter on the MCP stream lets only the tools the agent is told about through (an allowlist):
  every other tool is removed from the tool list and refused, `browser_run_code_unsafe` (code in
  Playwright MCP's Node process), `browser_file_upload` and `browser_drop` are also on a denylist
  as a second check (Playwright MCP cannot turn them off), and batches, other JSON values and
  non-JSON lines are dropped in both directions. The browser is not signed in to anything and holds none of
  your cookies.
- Lifecycle: the launcher removes the session's containers and network when the session closes its
  stdio. A killed launcher may leave them. Every resource is labelled with this plugin instance's id
  (the daemon's host name plus a uuid kept in the plugin's state directory), its launcher's process
  id and its creation time. When the plugin starts and every 10 minutes it removes only its own
  instance's resources whose launcher process is gone and that are older than 2 minutes; another
  daemon's resources on the same Docker, and anything without its instance label (such as a
  container someone started from the image by hand), are never touched. It also removes a run's
  earlier session resources when its session reopens, and all of a run's resources when it is
  closed or archived (both limited to its own instance). Each container stops itself
  after 2 hours without an MCP message and after 12 hours in total; the agent then reports that its
  browser stopped and which step it reached.

**What is blocked.** Every Chromium request (HTTP, HTTPS, WebSocket, also to loopback) goes to the
sidecar's proxy, which resolves the name itself and refuses:

- names: `localhost`, `ts.net`, `beta.tailscale.net`, `local`, `internal`, `home.arpa`, `lan`,
  `localdomain` and every subdomain of them (so every `*.ts.net` MagicDNS name), whatever they
  resolve to;
- IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (Tailscale and other CGNAT), 127.0.0.0/8,
  169.254.0.0/16 (link-local and cloud metadata), 172.16.0.0/12 (Docker bridges), 192.0.0.0/24,
  192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
  224.0.0.0/4 and 240.0.0.0/4;
- IPv6: `::`, `::1`, `::/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`, `2001::/32`,
  `2001:db8::/32`, `2002::/16`, `fc00::/7` (Tailscale's `fd7a:115c:a1e0::/48`), `fe80::/10`,
  `fec0::/10`, `ff00::/8`, and IPv4-mapped addresses checked as IPv4;
- every address on the Paseo server's own network interfaces (for example its public address, where
  services that listen on all interfaces could otherwise be reached);
- a name for which any resolved address is in those ranges. The proxy then connects only to the
  addresses it checked (in order, the next one when one fails), so DNS rebinding cannot swap them
  in between, and a public name that points to 127.0.0.1 or a tailnet address (`127.0.0.1.nip.io`,
  `localtest.me`) is refused.

Playwright MCP's origin block list repeats the name rules and the server's addresses. The sidecar
uses public DNS (1.1.1.1, 9.9.9.9), never the host's resolver or Tailscale's MagicDNS, and Chromium
may not send WebRTC UDP around the proxy (it has no route for it anyway).

**What is not blocked.**

- The public internet, through the proxy: any public address and site, including your own services
  that are reachable publicly (other servers' public addresses, a public IP of this server that is
  not on one of its interfaces, such as a NAT or floating IP), and any port Chromium allows. A page
  or a misled agent can send what it saw to any public site.
- Host names are sent to the public resolvers (and to the sites). Names on the block list are
  refused before any lookup.
- The proxy sidecar itself can reach every address (its rules are what stops it); a flaw in the
  proxy's code is therefore the remaining path to private addresses. It is small, uses only Node's
  standard library, and runs in its own locked-down container.
- Docker is the isolation boundary. With rootless Docker a container escape would get the daemon
  user's rights (with rootful Docker, root's), so keep Docker and the pinned images updated (see the
  release checklist below).
- Page content and screenshots reach the agent's model provider, as in any run, and the agent's
  rules (no secrets, ask before risky actions, stop at a login) are instructions to a model, not
  enforced controls. The agent keeps its other tools as in any run; Always Ask lets you approve each
  one.

**Release checklist.** On every plugin release, bump the Server browser's base image to the newest
`mcr.microsoft.com/playwright:vX.Y.Z-noble`, pinned by digest (`server-browser/Dockerfile` and
`BASE_IMAGE`), move `@playwright/mcp` and its `overrides` to the matching Playwright version, update
`seccomp.json` from that Playwright tag, regenerate the lock file and the embedded copy
(`node scripts/embed-server-browser.mjs`), and rerun the smoke test.

## Signed-in Server browser

You chose this trade-off: **your login sessions live on the Paseo server**, so an agent can use them
without your Mac, and you can log in and take over from your phone. Everything below follows from
that choice.

**What lives where.**

- The **profile volume** `bp-si-<id>-profile` (Docker volume, named after a hash of this plugin
  instance's id) holds Chromium's profile: cookies and logins of every site you logged in to, local
  storage, history. It survives restarts and plugin updates. Only the signed-in browser's container
  mounts it, at `/home/neko/.config/chromium`. Anyone who can run Docker as the daemon user (and
  root) can read it, like any file of that user. The browser's password manager, autofill, sync,
  sign-in, downloads, file pickers, metrics reporting and background mode are off by policy, and no
  extension can be installed (see [No extensions](#no-extensions-in-the-signed-in-browser)), so no
  saved passwords are in it.
- **Chromium's internal pages are blocked** by policy (`URLBlocklist`): `chrome://*`,
  `chrome-untrusted://*`, `chrome-search://*`, `chrome-extension://*`, `devtools://*`,
  `view-source:*`, `about:*`, `javascript:` and `data:` URLs and `file://*`, with only
  `about:blank` and `chrome://newtab` (which opens `about:blank`) allowed back. Neither the agent nor a page can open the history, the settings
  (where the list of sites with cookies is), the version page or view-source; such a navigation
  ends in `ERR_BLOCKED_BY_ADMINISTRATOR` (`about:` pages other than `about:blank` load empty). The
  owner cannot open them in the viewer either. The address bar uses Chromium's native suggestion
  popup (`--disable-features=WebUIOmniboxPopup,…`), because the default one is itself a `chrome://`
  page.
- The **viewer key** (`viewerSecret`), the relay's **status token** and **neko's passwords** are in
  `signed-in/keys.json` (mode 0600) in the plugin's state directory, and in the relay's and neko's
  container environment. neko's passwords are new on every start of the browser; you never see or
  type them.
- Nothing of this is sent anywhere by the plugin. Pages you and the agent open go out through the
  proxy like a Server browser's; page text and screenshots of agent runs go to the agent's model
  provider as tool output, as in any run.

**Who can reach it.**

- **The owner's viewer** is served by the relay only on the Paseo server's Tailscale address (or
  127.0.0.1 when the launcher is set to it), never `0.0.0.0`, a LAN or a public address; the plugin
  checks the published addresses before it runs Docker. To open it, Paseo asks the daemon for a
  one-time link: a ticket signed (HMAC-SHA256) with a key derived from the viewer key and a salt
  that is new on every relay start (so a link from before a relay restart is dead, and the relay
  never holds the viewer key itself), valid once and for 5 minutes, carried only in the URL's
  fragment, so it is never sent in a request line and never logged. The page posts it to the relay
  (with its own Origin); the relay checks signature, expiry and reuse, and counts the ticket as used
  once neko let the owner in (a link that met a browser still starting can be tried again until it
  expires). A refused ticket is answered after a constant 500 ms; there is no lockout, because with
  rootless Docker every client has the same address (a lockout would lock the owner out too), and
  an HMAC-SHA256 ticket cannot be guessed.
- **The session cookie**: `HttpOnly`, `SameSite=Strict`, `Secure` on the https address, with a
  random name (`bp_viewer_<16 hex>`) and `Path=/s-<32 hex>/`, both new on every relay start: the
  whole viewer lives under that random path, so the browser sends the cookie only there. It ends 2
  hours after login and after 20 minutes without a request or viewer input, and is bound to the
  address the login came from. Cookies ignore ports, which is why the path matters: another web
  service on the same host name or IP (another port) does not get the cookie unless the browser
  requests that service at the viewer's random path. **Limits:** with rootless Docker the relay sees
  every client as Docker's port forwarder (on paseo-box `172.20.0.1`), so the address binding adds
  nothing there (it works where the source address is kept); a service on the same host name can
  still try to set cookies for it. Give the viewer a host name no
  other web service uses: put it behind `tailscale serve` on its own name or port and enter that
  `https://…` address as the **HTTPS address**.
- The relay logs in to neko for you as a regular member (watch and take control, no admin rights;
  since 0.22.2), so neko's client neither shows nor calls its admin actions (room locks and
  settings, broadcast, kicking members), and neko itself refuses them for that login. Only the
  relay's own service login (screen size for phones, control state and reset) is an admin, and its
  token never leaves the relay. neko's token never reaches your browser (the relay
  adds it to each request it forwards and drops neko's cookies). It forwards only neko's web client
  files, its WebSocket and the routes to watch and take control (whoami, control take/release/give,
  screen size, keyboard map); member and session management, login, uploads, file transfer,
  broadcast, settings, `/metrics` (also turned off in neko), `/health` and debug routes are refused,
  query strings are never forwarded, encoded or `..` paths are refused, and neko's cookies and CORS
  (`Access-Control-*`) headers are dropped from its answers. Every request must carry the viewer's
  Host (against DNS rebinding); the WebSocket and every write need the viewer's Origin.
  The relay answers one path itself without a session: `site.webmanifest` under the viewer's random
  path, a constant manifest (name and colours only, nothing of neko's), because Safari fetches it
  without cookies.
- The signed-in image adds one stylesheet and one script of the plugin to neko's web client
  (`signed-in/viewer.css`, `signed-in/viewer.js`, served by neko under the viewer's path with a
  content hash in the file name; since 0.22.3) and patches one call in neko's key handler to go
  through the script. They change only the owner's own viewer: which element has focus on touch
  devices, the on-screen keyboard, and Shift around capitals (never while Ctrl, Alt or Meta is
  down, and not at all when neko's key state cannot be read). Keys still reach the browser only
  while the owner holds control (neko drops them otherwise). The key field sets autocorrect,
  autocapitalize, spell check and writing suggestions off, which asks iOS not to autocorrect or
  suggest from what is typed there (passwords); that is best effort, the browser decides.
  **Limit:** neko never reports the remote desktop's Caps Lock (it only sends the local one when a
  mouse or trackpad enters the video), so with the remote Caps Lock on, a capital typed on the
  on-screen keyboard comes out lowercase.
- WebRTC: the relay forwards one TCP port to neko's ICE-TCP mux, on the same address. ICE checks and
  DTLS protect the media; the port is reachable only on your tailnet. neko has no STUN or TURN
  servers (`NEKO_WEBRTC_ICESERVERS_FRONTEND/BACKEND=[]`, also neko 3.2.0's default; its client
  adds none), so the viewer gets only the candidate on the bind address and nothing goes to a public
  STUN server.
- **The agent** gets no neko account and no viewer link. Its Playwright MCP container joins neko's
  network namespace to reach the DevTools port on neko's loopback; it has no published ports, every
  capability dropped, no new privileges, a read-only root, an unprivileged user and limits. Its MCP
  filter has a **signed-in allowlist without `browser_evaluate`, `browser_console_messages` and
  `browser_network_requests`** (page JavaScript could read cookies, storage or what the owner
  types, or leave a keylogger; console and network output can carry tokens); it reads pages only
  with snapshots and screenshots. `browser_run_code_unsafe`, `browser_file_upload`, `browser_drop`
  and `browser_install` are refused as for every run. The relay is in another network namespace and
  cannot reach the DevTools port.
- **The owner's tabs are hidden from the agent (enforced, an allowlist).** Playwright MCP does not
  talk to Chromium directly: a DevTools-protocol filter in the run's container
  (`server-browser/cdp-filter.mjs`) is its only endpoint, and it shows the run only the pages the
  run created itself (`Target.createTarget` through the filter), popups of those that open while
  you do not hold control, and the frames and workers inside them. Everything else stays hidden:
  tabs open when the run starts, tabs restored after a Chromium restart, tabs you open (also while
  no Playwright client is connected, or in the first seconds of a takeover), popups that open while
  you hold control, service workers and tab targets. Playwright is never attached to them, they are
  missing from target lists and events, and commands on them (attach, activate, close, info,
  messages, related auto-attach, detach, window) and on their sessions (input, cookies, script) are
  refused, as are closing or crashing the browser and reading, setting or clearing every site's
  cookies at once. The agent cannot list, select, close, read or act on those tabs; its
  `browser_close` leaves your browser and tabs as they are (checked in the smoke test).
- **The agent can read its own tab.** If you log in inside the agent's tab during a takeover, the
  agent sees that page afterwards (not the password: password fields are masked in snapshots, and
  its calls are paused while you hold control). Where the site allows it, log in **in a new tab**
  (the + button): that tab stays hidden from the agent, the session cookie it sets is shared, and
  the agent reloads its own tab afterwards. The agent is told to ask you to do that.
- **Pages** in the browser cannot reach neko, the DevTools port, the relay, your tailnet, private or
  host addresses: Chromium sends every request, loopback included (`--proxy-bypass-list=<-loopback>`),
  to the proxy sidecar, which refuses them (the same list as the Server browser below), and neko's
  container is on an internal network with no other route.

**How it is isolated.** neko runs on the internal network only, with every capability dropped except
`SETUID`, `SETGID` and `CHOWN` (its supervisor starts the desktop as the unprivileged `neko` user)
and `SYS_CHROOT` (Chromium's own sandbox, which runs), `no-new-privileges`, Playwright's pinned
seccomp profile, a read-only root with tmpfs for what it writes, only the profile volume mounted,
2.5 GB / 2 CPUs / 1024 processes, no container log, never pulled. The relay and the proxy: every
capability dropped, `no-new-privileges`, read-only root, unprivileged user, limits, no log, no mounts.
neko's metrics, pprof, plugins, file transfer and upload-by-drop are off.

**One run at a time.** Only one run may hold the signed-in browser (a ticket out, an admitted run, or
its MCP container); the check and the claim happen together, one press or session open at a time,
so two presses at once cannot both get it. Others are told it is in use. The owner's viewer works
alongside a run.

**Takeover pauses the agent (enforced).** The relay reads neko's control state every 500 ms (one
read at a time, older results ignored, 1.5 s limit for the read and the login before it) with its
own admin session, and right after a control request it forwards. neko's own viewer takes control
over its WebSocket, which the relay passes on without reading, so the relay learns of a takeover
from these reads, not at the moment it happens. It answers `GET /control` with `{ ownerControl, known, sampledAgoMs, bootId,
epoch }` on port 8081, bound only to its address on the stack's
internal network (not published, not on the outward network).

- `ownerControl` is always a boolean. It is true whenever neko last reported a host, with or
  without a viewer, until a reset or a new read clears it. It is also true while a viewer is
  connected and the relay cannot read neko's state (then with `known: false`: unsure, which the run
  treats as unavailable, not as a takeover). A control left held without a viewer is reset (retried at every read). A control request
  over neko's REST API is forwarded only for a session whose own viewer WebSocket is open; without
  one it is refused. While such a request is being forwarded, and until a read of neko that began
  after it ended, `ownerControl` is true. (This does not make the relay see every takeover: the viewer takes control
  over its WebSocket.)
- `sampledAgoMs` is the age of the relay's last successful read of neko, on its monotonic clock
  (`null` before the first read).
- `bootId` names this relay start.
- `epoch` grows when neko reports a host after none, when a viewer WebSocket opens or closes, and
  before and after every control request the relay forwards. A failed read of neko does not move
  it.
- `known` is informational.

The run's MCP container reads it every 500 ms (one request at a time, 1.5 s timeout, older results
ignored by sequence number), and its takeover guard **fails closed**:

- It **starts paused**. The first read finishes before Playwright MCP starts and before any message
  from the agent is read; until a valid read confirms release, every tool call is refused.
- Only a valid status **releases**: a 2xx response whose JSON body is an object with
  `ownerControl` strictly `false` and with `sampledAgoMs`, `bootId` and `epoch` present and
  well-formed. `ownerControl: true` pauses. Anything else counts as **unavailable** and pauses;
  unknown is never release. That includes a missing or non-boolean `ownerControl`, a release
  without those fields, a body that is not a JSON object, a non-2xx status (its body is discarded),
  a timeout and an unreachable relay.
- It **pauses again** as soon as the status becomes unavailable: one failed or invalid read after a
  release is enough, and no number of failures ever opens it.
- A release is good for **3 seconds**, counted from the relay's own read of neko (the poll's start
  minus `sampledAgoMs`), on a monotonic clock. 3 seconds is the poll timeout (1.5 s) plus two poll
  intervals plus one relay read interval, defined in one place. When the release is older, for
  example because polls stopped or the relay's reads of neko stalled, it counts as unavailable and
  pauses. A clock that goes backwards does the same. This is checked at every tool call and every
  result, also between polls.
- The signed-in MCP container does not start without the relay's address (`BP_CONTROL_URL`); the
  launcher refuses a signed-in plan without exactly that address. Each start of the container (a
  resume, a new session, a restart) begins paused again.

While paused, the MCP filter answers **every** tool call (snapshot, screenshot, typing, navigation)
with a refusal instead of passing it to the browser:

- "the owner has taken over…" while you hold control;
- "the takeover state cannot be confirmed right now; wait about 5 seconds and try again" while the
  status is unavailable.

`initialize`, `ping` and `tools/list` still pass (they do not touch the browser);
`logging/setLevel` is answered by the filter itself, and other request methods are refused. Of the
agent's notifications only `notifications/initialized`, `notifications/cancelled` and
`notifications/roots/list_changed` pass (a `tools/call` without an id is dropped, also while
released). Of what Playwright MCP sends on its own only `notifications/tools/list_changed`,
`notifications/cancelled` and the requests `roots/list` and `ping` pass; progress and log messages
are dropped.

Request ids must be strings or numbers, and an id may be in flight only once: a second request with
an id still in flight, or one that was given up on, is refused before it reaches Playwright MCP. A
request is given up on when the agent cancels it or when Playwright MCP has not answered within 10
minutes (the agent then gets an error saying the call may have been carried out). A cancelled id
stays retired for 10 minutes; the id of a call given up on stays retired until Playwright MCP answers
it (that late answer is dropped), never by age. With 1000 retired ids, new requests are refused
instead of forgetting old ones. The run checks its in-flight calls against the state it had right
before it applies each new read of the relay, so a release that went stale in between is never
skipped. An answer from Playwright MCP passes only when it answers a tracked
request; a second answer to the same id, an answer to an id never asked for or given up on, and an
answer without an id are dropped. A line longer than 8 MB from the agent (32 MB from Playwright MCP)
is dropped whole, never passed on in part; it is answered with an error when its id can be read
(from the start of the agent's message, from the end of Playwright MCP's answer, where the MCP SDK
writes the id; the clean Server browser does the same), otherwise the call gets the no-answer error
after 10 minutes.

For each tool call in flight the filter records the relay start and epoch it began under and the
worst thing seen while it ran. Its result passes only when nothing was seen; otherwise it is
withheld and never released later:

- **Withheld with "the owner has taken over…"**: you held control while it ran (a real `ownerControl: true`). The same happens when the epoch moved between two
  good reads: a takeover the relay saw, a viewer that connected or left, or a control request it
  forwarded. So a call that started before a takeover cannot hand back what you typed.
- **Withheld with "the browser status could not be confirmed while this call ran… the call may
  have been carried out: take a snapshot before you repeat it"**: the status was unavailable at any
  moment while it ran (a failed, invalid or stale read, also a short relay blip, or the relay unsure
  because it could not read neko while a viewer was connected), or the relay started again. A later release does not prove that nobody took over in between (the epoch moves
  only for what the relay saw), so this result is never released later; the agent takes a new
  snapshot.

The DevTools filter between Playwright MCP and Chromium uses the same guard. The clean Server
browser has no owner and no takeover guard. When the last viewer disconnects, the relay resets
control, so a closed viewer cannot leave the run paused.

**Remaining window (not instant, and inherent to this design).** With a healthy relay, the run's
tools pause about 1 second after you take control, not at once: the relay sees the takeover at its next read of neko (at most
500 ms, plus neko's answer time), and the run sees it at its next read of the relay (at most 500 ms
more, plus the answer time). A call that starts and finishes within that second, right at the start
of a takeover, can return what the page showed in that moment, including what you began to type.
If the relay's reads of neko stall, that window is up to 3 seconds (a release stays good for 3
seconds after the relay's last read). Actions the agent starts in the window can still reach the
browser. A control request over neko's REST API pauses the run from the moment the relay forwards
it, so only takeovers over the viewer's WebSocket have this window. A takeover that begins and ends
between two of the relay's 500 ms reads over a viewer WebSocket that was already open is not seen at
all (the viewer takes control over that WebSocket,
which the relay passes on without reading). The agent is also told
never to type credentials and to wait for your answer. Release control (the mouse icon again, or
close the viewer) before you answer "done".

**Lifetime.** The plugin stops the stack after 30 minutes without a run or viewer, always gracefully
(neko gets up to 45 seconds so Chromium writes its cookies), also when a start fails or a stack that
stopped answering is replaced. The relay and the proxy also stop themselves after 7 days
(`BP_MAX_LIFETIME_S`; the relay only once no viewer is connected). When neko runs but its relay or
proxy is gone, the plugin starts only those (at the next use, or within a minute by its idle check);
neko and your sessions stay as they are (Chromium finds the proxy by its container name). **The plugin does the idle stop:
after you remove the plugin or roll back to 0.21.x, a running stack (neko with your logins, and the
relay on your Tailscale address) keeps running until you stop it.**

**How to log out or wipe.** Settings › Signed-in Server browser › **Log out of everything**, then
**Confirm**: stops the browser, removes the profile volume and makes new keys. By hand, as the user
that runs Paseo's Docker (on paseo-box `paseo`, rootless):

```sh
docker ps -a --filter label=browser-prompt.signed-in --format '{{.Names}}'   # find bp-si-<id>-…
docker stop -t 45 bp-si-<id>-neko                                           # stop, keeping the logins
docker rm -f bp-si-<id>-neko bp-si-<id>-relay bp-si-<id>-proxy
docker network rm bp-si-<id>-net bp-si-<id>-pub
docker volume rm bp-si-<id>-profile                                         # wipe every login
```

and delete `signed-in/keys.json` in the state directory. Removing the plugin does not remove the
stack or the volume.

### No extensions in the signed-in browser

No browser extension runs in the signed-in browser, and none can be added: its policy blocks every
extension (`ExtensionInstallBlocklist: ["*"]`), forces none (`ExtensionInstallForcelist: []`),
allows no install sources and no external extensions, keeps developer mode off
(`ExtensionDeveloperModeSettings: 1`) and blocks the Chrome Web Store and `chrome-extension://*`
pages. As defense in depth the run's DevTools filter hides every `chrome-extension://` target,
refuses navigation to extension pages and the whole `Extensions.*` domain, and the MCP filter refuses
tool calls that name an extension page. Use a password manager on your own device and type or paste
into the viewer while you hold control.

**Bitwarden (0.23.0 to 0.24.x) was removed in 0.25.0.** Those versions could build a variant of the
signed-in image with the Bitwarden extension and locked its vault after every takeover. On the
update to 0.25.0:

- The stored `bitwarden` / `bitwardenConsent` settings are ignored.
- A browser still running the Bitwarden image is never handed to a new run or session; it is
  started again with the plain image as soon as no run holds it (also with a viewer connected; your
  logins are kept). A run that held it through the update finishes on it; its own (older) filter
  still keeps the agent off the extension, but the plugin no longer locks the vault after a takeover.
- A relay started with the vault lock (from before 0.25.0) would keep a run paused forever: the
  plugin starts that relay again without it once no viewer is connected (neko keeps running; the
  run's guard fails closed across the relay restart as always).
- The plugin removes this install's Bitwarden signing key (`signed-in/bitwarden-key.pem` and any
  temp file of it) and the variant's build contexts from its state directory, and the
  `browser-prompt-signed-in:*-bw*` images (`docker rmi` without force, retried while a container
  still uses one; on a Docker shared with another plugin install that still runs such an image, that
  image stays).
- At the browser's next start its start script removes what every Bitwarden build the profile
  recorded (`.bp-bitwarden-ids`) left: its extension data directories (Local, Sync and Managed
  Extension Settings, `Storage/ext`, `Extensions`, its IndexedDB and File System entries), the shared
  extension databases (Extension State, Rules, Scripts) and its preference entries; then it forgets
  every id nothing in the profile names any more, and the file with the last one. Site logins,
  cookies and other sites' data are never touched. What Chromium keeps per origin in shared
  databases (for example the extension's service-worker registration or `localStorage` entries) is
  not removed one by one; Bitwarden keeps its vault in `chrome.storage.local` (Local Extension
  Settings, removed). **Log out of everything** removes the whole profile.

## Design limits

- The launcher listens only on the daemon host's own Tailscale address (100.64.0.0/10) or on
  127.0.0.1, never on 0.0.0.0, a LAN or a public address. Anyone who can reach that address and
  guess a live 18-byte random id within 10 minutes could open that one prompt; ids are single-use.
- Paseo browser and Claude in Chrome start Claude agents in **Auto mode by default**. The agent acts in your
  Paseo desktop app's browser, where you may be signed in. In Auto mode a model classifier, not you,
  approves its tool calls, including clicks and form submissions on those sites. The safety preamble
  tells the agent to ask you as a question before secrets, destructive or irreversible actions,
  merges, payments and security changes, but that is an instruction to a model, not an enforced
  control: a misbehaving model, or a web page that manipulates it, could act without asking, and the
  classifier may approve it. Set the permission mode to `default` (Always Ask) to approve every new
  tool yourself; review each approval there.
- The browser-only rule (use only the Paseo browser tools, or the Claude in Chrome tools with that setting: no shell commands, no file edits) and the
  secret-handling rules are also instructions in the agent's prompt, not a tool sandbox. The plugin
  does not remove other tools from the run, so enforcement depends on the selected provider and
  model and on the permission mode; in Always Ask you approve each new tool.
- The plugin checks the mode a run actually uses and stops (archives) runs in a refused mode
  (bypass, accept-edits and similar). Only agents a card recorded as its run are checked, so an
  agent that copies the plugin's labels is never archived by it. Moving between Auto, Always Ask and Plan is not acted on.
  Stopping takes a moment after the agent starts or changes mode, so a few tool calls can happen
  before it.
- Report back to chat can forward the browser agent's report, which can echo text from web pages,
  to the agent that showed the card. The report is escaped, fenced and labelled as untrusted
  output, but a model may still be influenced by it. Auto (the default) therefore forwards it only
  to chats in a known ask-first mode and sends a status-only notice to every other chat. An
  ask-first mode does not mean the agent cannot act on its own: allow rules you configured for that
  provider (for example always-allowed tools or commands) still run without asking, so a report
  could lead to those actions. **Always send the full report** removes that check; use it only if
  you accept that a web page could steer an agent that acts without approval.
- Only runs a card recorded in host settings report, so an agent that copies the plugin's labels
  cannot use them to message another chat. Anyone who can change this plugin's host settings can
  still add such a record.
- Talk to the chat forwards questions that can contain text from web pages to the chat that showed
  the card, also to chats that act without approval (bypass or Auto mode), because a status-only
  notice cannot carry a question. The plugin, not the model, frames each question: it is escaped,
  fenced and labelled as untrusted, and the instructions on how to answer and what never to send
  come from the plugin outside the block. A model may still be influenced by such text. Turn Talk
  to the chat off (or set the limit to 0) if that is not acceptable.
- Answers are written by the chat's agent and arrive in the browser agent as ordinary messages; the
  plugin cannot verify or filter them. The fixed preamble tells the browser agent to use them only as
  information about the task and, as a hard rule that no setting changes, never to accept a secret
  or a confirmation of a destructive, security, billing, merge or publish action from the chat, only
  from the owner's AskUserQuestion answer. That is an instruction to a model, not an enforced
  control. The answer tool can also set the browser agent's permission mode; the plugin tells the
  chat not to, and the mode guard stops a run that ends up in a refused mode.
- Step progress text is written by the browser agent and can echo a page. The agent is told not to
  put secrets or page text in it; the card cleans it (no control or invisible characters, one line,
  at most 60 characters) and shows it only in your Paseo app. It is never sent to a chat.
- Screenshots can show anything on the page, including signed-in account details. The agent is
  told never to screenshot a page that shows a secret, but that is an instruction to a model. The
  plugin never sends screenshots or their file paths to a chat: reports, questions and error text are
  text only (Markdown and HTML images, `file://` URIs and Paseo attachment paths are removed). The
  thumbnail only uses Paseo's own local attachment files, never a remote URL.
  The thumbnail is read from the agent's own timeline and stays in your Paseo app. Turn off Show
  live screenshot to stop the screenshots (this also saves the tokens each image costs).
- Archive the agent after a successful run (off by default) acts only on a run a card recorded, when
  the last line of its own final report says it fully succeeded. The agent writes that line, so a page
  that misleads it could get a run archived too early; archiving keeps the agent's history. The daemon
  keeps the archived run ids, and nothing else, in `archived-runs.json` in the plugin's state directory.
- Stop on the card (0.24.0) archives the run's agent from your own Paseo app, the same call the mode
  guard uses; it needs no new server permission and keeps the agent's history. It asks for a second
  press, and only stops a run one of this chat's cards recorded, never the chat's own agent. A run's
  tool call already under way may still finish (Paseo's client API has no turn cancel). The archive
  frees the run's Server browser slot or the signed-in browser at once and removes its containers;
  after a daemon restart that happens for runs a card recorded as browser runs.
- The card never makes the signed-in Server browser (your logins) a default you did not choose:
  without a choice, Run uses the Paseo browser (or the browser you had as your usual way).
- A Claude in Chrome tab run (the card's Run once in…, or the Run default; Claude in Chrome) runs the agent in your real Chrome, with every account you
  are signed in to, not in the Paseo browser. Its reach is much wider. In Auto mode, its default, a
  model classifier approves browser actions and the extension skips its own check per site, so the
  limits on sites and secrets are rules the agent is told, not rules that are enforced. A malicious
  page can try to mislead it while those accounts are in reach. Choose Always Ask to approve actions
  yourself. Steps and page content can go through Anthropic's bridge (`bridge.claudeusercontent.com`).
- Close tabs after a successful run (on by default) tells the agent to close only the tabs it opened
  itself, and only after a fully successful run. That is an instruction to a model, not an enforced
  control: the plugin does not check which tab a `browser_close_tab` call (or, in a Chrome tab run,
  a `tabs_close_mcp` call) closes, so a model may close the wrong tab (for example one you had open
  with unsaved work) or none. In Always Ask mode you approve each new tool, including the close. Turn the setting off to keep every tab open.
- Questions and permission requests the browser agent puts to the owner (AskUserQuestion, tool
  approvals) stay with the owner. The card shows them and sends the answer the owner clicks with
  Paseo's `respondToPermission`, the same as answering in the run. Nothing answers them
  automatically, the chat never sees them, and no server code responds to them. Answer buttons are
  shown only after the run's own snapshot confirms it is this card's run, a question is sent only
  after you select and press Send, and a permission offers Allow only when the card shows everything
  it would allow: every input field in full and exactly as sent (nothing cut, no characters removed
  or normalized, no unknown fields such as `dangerouslyDisableSandbox`), and Allow needs a second
  "Confirm allow" tap. Otherwise only Deny. Values typed into a page are masked until you tap Show.
  The question text, options and details come from the agent and can echo a page; read them before
  you click.
- A block repeated later in a chat shares the first's done mark and run. A copy cannot start a
  second run while that run is going, so asking for the steps again does not start parallel agents.
- Self-update is off until you enable it in settings, where the plugin names the `https://` remote it
  was installed from and says that newer code from it will be downloaded and installed. Declining, or
  never deciding, leaves everything as installed, including when cards are shown and when settings
  cannot be read. Consent applies to that remote only. It installs only fast-forward commits.
  **Update now** installs the one commit it names, only when pressed. Installing a plugin means
  trusting its repository: the server part runs unsandboxed with the daemon user's access.
