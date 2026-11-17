// Filtering HTTP proxy for the browser-prompt Server browser. It runs in its own sidecar container
// (proxy-main.mjs), the only one of a session with a route out: the browser container sits alone on
// an internal Docker network and Chromium sends every HTTP(S) and WebSocket request here (Playwright
// also proxies loopback for Chromium). For each request it resolves the host itself, refuses
// tailnet and local names and every private, loopback, link-local, CGNAT (Tailscale), multicast,
// documentation or otherwise reserved address, plus the daemon host's own addresses, and then
// connects to exactly the address it checked, so a name that resolves (or re-resolves) to a
// private address is refused too. No dependencies: Node's standard library only.
import { lookup } from "node:dns/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { BlockList, connect, isIP } from "node:net";

/** IPv4 ranges that are never reachable from the Server browser. */
export const BLOCKED_IPV4 = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT, Tailscale addresses
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private, Docker bridges
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

/** IPv6 ranges that are never reachable. IPv4-mapped addresses are checked as IPv4. */
export const BLOCKED_IPV6 = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64: could reach private IPv4
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds IPv4
  ["fc00::", 7], // unique local, Tailscale fd7a:115c:a1e0::/48
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

/** Host names (and every subdomain) that are never reachable, whatever they resolve to. */
export const BLOCKED_HOST_SUFFIXES = ["localhost", "ts.net", "beta.tailscale.net", "local", "internal", "home.arpa", "lan", "localdomain"];

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const MAPPED_V4_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** Strips brackets and an IPv6 zone id, and turns an IPv4-mapped IPv6 address into its IPv4 form. */
export function normalizeAddress(address) {
  let value = String(address ?? "").trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  const dotted = MAPPED_V4.exec(value);
  if (dotted) return dotted[1];
  const hex = MAPPED_V4_HEX.exec(value);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return value;
}

/** Normalizes a host name: lower case, no brackets, no trailing dot. */
export function normalizeHost(host) {
  let value = String(host ?? "").trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  while (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

/**
 * The network policy: `blockedAddress(ip)` for resolved addresses, `blockedName(host)` for names.
 * `extraBlocked` adds single addresses (the daemon host's own), so a public address of the host,
 * where its services listen, is refused as well.
 */
export function createPolicy(extraBlocked = []) {
  const list = new BlockList();
  for (const [net, prefix] of BLOCKED_IPV4) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of BLOCKED_IPV6) list.addSubnet(net, prefix, "ipv6");
  const extras = new Set();
  for (const raw of extraBlocked) {
    const address = normalizeAddress(raw);
    const family = isIP(address);
    if (family === 4) list.addAddress(address, "ipv4");
    else if (family === 6) list.addAddress(address, "ipv6");
    if (family) extras.add(address);
  }
  function blockedAddress(raw) {
    const address = normalizeAddress(raw);
    const family = isIP(address);
    // Anything that is not a plain address (a parse surprise) is refused.
    if (family === 0) return true;
    return list.check(address, family === 4 ? "ipv4" : "ipv6");
  }
  function blockedName(raw) {
    const host = normalizeHost(raw);
    if (!host) return true;
    if (isIP(normalizeAddress(host))) return blockedAddress(host);
    return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }
  return { blockedAddress, blockedName, extras: [...extras] };
}

/** Default resolver: every address the system resolver returns, in its order. */
async function systemResolve(host) {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

export const BLOCKED_MESSAGE =
  "Blocked by the browser-prompt Server browser: tailnet, private, loopback and link-local addresses, and the server itself, are not reachable from this browser.";

/**
 * Where to connect for `host`, or why not: names on the block list, names that do not resolve, and
 * names with any blocked address are refused (all addresses are checked, so a name that mixes a
 * public and a private address is refused as a whole). The connection goes to the first address,
 * the one that was checked, so DNS cannot change it in between.
 */
export async function resolveTarget(policy, host, resolve = systemResolve) {
  const name = normalizeHost(host);
  if (!name || name.length > 253) return { refused: "bad host" };
  if (policy.blockedName(name)) return { refused: "blocked host" };
  const literal = normalizeAddress(name);
  let addresses;
  if (isIP(literal)) addresses = [literal];
  else {
    try {
      addresses = (await resolve(name)).map(normalizeAddress);
    } catch {
      return { refused: "not found" };
    }
  }
  if (addresses.length === 0) return { refused: "not found" };
  if (addresses.some((address) => policy.blockedAddress(address))) return { refused: "blocked address" };
  return { address: addresses[0], family: isIP(addresses[0]), addresses };
}

/**
 * Connects to the checked addresses in order and resolves with the first socket that connects, or
 * rejects when none does. Only addresses `resolveTarget` checked are ever tried.
 */
export function connectFirst(addresses, port, { timeoutMs = 10_000, connectTo = connect } = {}) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const next = () => {
      if (index >= addresses.length) {
        reject(new Error("no address connected"));
        return;
      }
      const address = addresses[index++];
      const socket = connectTo({ host: address, port, family: isIP(address) || undefined });
      const timer = setTimeout(() => socket.destroy(new Error("timeout")), timeoutMs);
      const failed = () => {
        clearTimeout(timer);
        socket.removeAllListeners("connect");
        socket.destroy();
        next();
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", failed);
        resolve(socket);
      });
    };
    next();
  });
}

/**
 * Which clients may use the proxy: only addresses in `cidr` (the session's internal network). Other
 * containers on Docker's default bridge can reach the sidecar too and are turned away.
 */
export function createClientCheck(cidr) {
  if (!cidr) return () => true;
  const match = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(String(cidr).trim());
  if (!match) return () => false;
  const family = isIP(match[1]);
  if (!family) return () => false;
  const list = new BlockList();
  list.addSubnet(match[1], Number(match[2]), family === 4 ? "ipv4" : "ipv6");
  return (remote) => {
    const address = normalizeAddress(remote);
    const kind = isIP(address);
    return kind !== 0 && list.check(address, kind === 4 ? "ipv4" : "ipv6");
  };
}

/** `host:port` of a CONNECT request, with bracketed IPv6; null when malformed. */
export function parseAuthority(authority) {
  const value = String(authority ?? "");
  const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value) ?? /^([^:\[\]]+):(\d{1,5})$/.exec(value);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (!HOP_BY_HOP.has(rawHeaders[i].toLowerCase())) out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

/**
 * Starts the proxy on `host` (127.0.0.1 unless given; the sidecar uses 0.0.0.0) and `port` (random
 * unless given). Handles CONNECT tunnels (HTTPS, WSS, also ws:// from Chromium) and absolute-form
 * plain HTTP requests. Clients outside `allowClients` (a CIDR) are disconnected at once. Returns
 * `{ port, close() }`.
 */
export async function startProxy({
  extraBlocked = [],
  host = "127.0.0.1",
  port = 0,
  allowClients = "",
  resolve = systemResolve,
  log = () => {},
  policy: given,
  connectTo,
} = {}) {
  const policy = given ?? createPolicy(extraBlocked);
  const clientAllowed = createClientCheck(allowClients);
  const server = createServer();
  server.maxConnections = 512;
  server.keepAliveTimeout = 30_000;
  server.on("connection", (socket) => {
    if (!clientAllowed(socket.remoteAddress)) {
      log(`refused client ${normalizeAddress(socket.remoteAddress)}`);
      socket.destroy();
    }
  });

  server.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {});
    const target = parseAuthority(req.url);
    if (!target) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    void resolveTarget(policy, target.host, resolve).then((resolved) => {
      if ("refused" in resolved) {
        log(`refused CONNECT ${normalizeHost(target.host)}:${target.port} (${resolved.refused})`);
        const body = BLOCKED_MESSAGE;
        clientSocket.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\nX-Browser-Prompt-Blocked: ${resolved.refused.replace(/\s/g, "-")}\r\n\r\n${body}`,
        );
        return;
      }
      connectFirst(resolved.addresses, target.port, { connectTo }).then(
        (upstream) => {
          upstream.setTimeout(300_000, () => upstream.destroy());
          upstream.on("error", () => clientSocket.destroy());
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
          clientSocket.on("close", () => upstream.destroy());
          upstream.on("close", () => clientSocket.destroy());
        },
        () => {
          if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        },
      );
    });
  });

  server.on("request", (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Only proxy requests are accepted.");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Only http:// requests are proxied directly; https uses CONNECT.");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    void resolveTarget(policy, url.hostname, resolve).then((resolved) => {
      if ("refused" in resolved) {
        log(`refused ${req.method} ${normalizeHost(url.hostname)}:${port} (${resolved.refused})`);
        res.writeHead(403, { "Content-Type": "text/plain", "X-Browser-Prompt-Blocked": resolved.refused.replace(/\s/g, "-") }).end(BLOCKED_MESSAGE);
        return;
      }
      connectFirst(resolved.addresses, port, { connectTo }).then(
        (socket) => {
          // A one-off agent whose only connection is the checked socket: nothing is pooled, so a
          // later request can never reuse a connection made for another host.
          const agent = new Agent({ keepAlive: false, maxSockets: 1 });
          agent.createConnection = () => socket;
          const upstream = httpRequest({
            agent,
            host: resolved.address,
            port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers: forwardHeaders(req.rawHeaders),
            setHost: false,
          });
          upstream.setTimeout(300_000, () => upstream.destroy());
          upstream.on("response", (response) => {
            res.writeHead(response.statusCode ?? 502, response.statusMessage, forwardHeaders(response.rawHeaders));
            response.pipe(res);
          });
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }).end("Upstream error.");
            else res.destroy();
          });
          req.pipe(upstream);
        },
        () => {
          if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }).end("Upstream error.");
        },
      );
    });
  });

  // Plain-proxy WebSocket upgrades are not used by Chromium (it tunnels them with CONNECT).
  server.on("upgrade", (_req, socket) => {
    socket.on("error", () => {});
    socket.end("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    policy,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}
