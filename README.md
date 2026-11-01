# Boom Boom Baby scores

One Node process serves the `game1` and `game2` leaderboards at
<https://scores.boomboombaby.ca/>. Node 24 or newer, standard library only. No
npm dependencies or database.

## Development

```sh
nix develop
npm test
npm start
```

`npm start` listens on `127.0.0.1:3000` and creates `./data`. Stop with Ctrl-C.
Without Nix, use Node 24 and the same npm commands. No `npm install` is needed.
The CLI is `node cli.mjs` in a checkout, or `bbbscores` from the Nix package.

```sh
nix flake check
nix build
./result/bin/bbbscores list game1
```

The last command needs a running server with the same `STATE_DIRECTORY`.
`nix flake check` runs the Node tests in the package build and evaluates the
NixOS module's generated unit. It does not start a systemd service.

## Public API

Point each game's `VITE_HIGH_SCORE_URL` at its full endpoint:

- Game1: `https://scores.boomboombaby.ca/game1/high-scores`
- Game2: `https://scores.boomboombaby.ca/game2/high-scores`

Both boards keep the existing games' request and response shapes.

`GET /<board>/high-scores` returns HTTP 200:

```json
{
  "scores": [
    { "initials": "ABC", "score": 12345, "createdAt": "2026-11-01T18:00:00.000Z" }
  ]
}
```

`POST /<board>/high-scores` with `Content-Type: application/json`:

```json
{ "initials": "ABC", "score": 12345 }
```

HTTP 200 response:

```json
{
  "accepted": true,
  "scores": [
    { "initials": "ABC", "score": 12345, "createdAt": "2026-11-01T18:00:00.000Z" }
  ]
}
```

Initials must be exactly three uppercase ASCII letters. Score must be an
integer from 1 to 999999999, not a numeric string. `createdAt` comes from the
server. Scores sort descending, with older timestamps first on ties. Each
board keeps ten records. A score equal to the tenth-place score does not
qualify and returns HTTP 200 with `accepted: false` and the unchanged board.

Errors return `{ "error": "message" }`:

- 400: invalid JSON, invalid fields, non-object body, or body over 10,000 bytes.
- 403: a POST with an Origin outside the allowlist, including `Origin: null`.
- 404: unknown board or route. There is no `/api/high-scores` alias.
- 405: unsupported method, with an `Allow` header.
- 429: submission limit reached, with `Retry-After` in seconds.
- 500: storage or other service failure.

Board responses, errors and health checks use `Cache-Control: no-store`.
Allowed browser origins receive CORS headers, including on errors. Preflight
uses `OPTIONS`. Disallowed origins can read with a non-browser client, but
receive no CORS permission. Requests without an Origin are allowed. CORS is
not authentication, and client-reported scores can be forged.

`GET /health` returns `{ "ok": true }` with HTTP 200 after checking canonical
state and the aggregate. A storage failure returns `{ "ok": false }` with
HTTP 503. `HEAD` works on health and the aggregate.

`GET /scores.json` serves the static aggregate, also written to disk:

```json
{
  "updatedAt": "2026-11-01T18:00:00.000Z",
  "boards": {
    "game1": [
      { "initials": "ABC", "score": 12345, "createdAt": "2026-11-01T18:00:00.000Z" }
    ],
    "game2": []
  }
}
```

The landing page reads only this endpoint. It uses
`Cache-Control: public, max-age=60`, so a browser or CDN may show the previous
snapshot for up to a minute after a submission or admin removal. All CORS
responses vary on Origin.

## Configuration

Environment variables for `bbbscores serve`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATE_DIRECTORY` | `./data` | Persistent state directory and admin socket location. |
| `HOST` | `127.0.0.1` | HTTP listen address. |
| `PORT` | `3000` | HTTP port. Port 0 selects a free port for fixtures. |
| `ALLOWED_ORIGINS` | See below | Comma-separated CORS allowlist. Empty disables browser cross-origin access. |
| `RATE_LIMIT` | `10` | POST attempts per client IP, shared across both boards. |
| `RATE_WINDOW_MS` | `60000` | Fixed window starting with the first attempt. |
| `CLIENT_IP_HEADER` | Empty | Optional single-IP header from a trusted loopback proxy. |

Default origins:

```text
https://game1.boomboombaby.ca
https://game2.boomboombaby.ca
https://boomboombaby.ca
https://*.itch.zone
```

Wildcards match subdomains only, with the specified scheme and no non-default
port. `https://itch.zone`, HTTP itch hosts, and suffix lookalikes do not match.
For local browser development, add `http://localhost:5173` explicitly.

Malformed attempts consume rate quota. GET and OPTIONS do not. Counters are
in memory, expire after the configured window, and reset on restart. The
service tracks at most 10,000 active client IPs and refuses new IPs while
full, rather than dropping existing quotas. This is a small-service abuse
limit, not distributed denial-of-service protection.

By default the socket peer identifies the client. Behind Caddy this would
share one quota for every player. Set `CLIENT_IP_HEADER=x-real-ip` only when
Caddy overwrites that header with a verified client IP. Headers are trusted
only from loopback peers, must contain one valid IP, and never accept an
`X-Forwarded-For` list. Do not trust arbitrary incoming `CF-Connecting-IP` or
`X-Real-IP` headers.

## Admin commands

The CLI talks to `STATE_DIRECTORY/admin.sock`, an owner-only Unix socket. It
never writes score files itself and needs the server running. No admin route
exists on the public HTTP port. Submissions and admin changes share one write
queue.

```sh
export STATE_DIRECTORY=/var/lib/bbbscores
bbbscores list game1
bbbscores remove game1 ABC 12345 2026-11-01T18:00:00.000Z
bbbscores import game1 /path/to/game1-high-scores.json
bbbscores import game2 /path/to/game2-high-scores.json
```

Removal matches the full record copied from `list`, not its changing rank. It
removes the first exact match and returns `removed: false` when none exists.
Both removal and import rewrite the aggregate.

Import accepts each game's existing JSON file:

- Game1 reads `scores`.
- Game2 reads `storyScores`. It validates but does not import legacy `scores`,
  which mixed routes before Story mode had its own board. A legacy file with
  no `storyScores` imports an empty board, as the old server would show it.

The source is validated in full, sorted and cut to ten. Each board must be
empty and can be imported only once, even after all its scores are removed
or the service restarts. Existing `createdAt` values are preserved. The admin
request limit is 1 MB. Source files must be readable by the CLI user; they are
not modified.

On NixOS, run commands as root or the service user:

```sh
sudo -u bbbscores env STATE_DIRECTORY=/var/lib/bbbscores bbbscores list game1
```

## Storage and recovery

Run exactly one process per state directory. Do not edit live JSON files or
start a second writer. Startup refuses an active admin socket, reclaims a
stale socket after an unclean exit, and refuses non-socket files at that path.
SIGINT and SIGTERM stop both listeners and drain active requests.

`state.json` is authoritative. It contains the version, boards, update time
and import markers. `scores.json` contains only the public aggregate. Both
are written using a temporary file, file sync, rename and directory sync.
The canonical state is committed first, then the aggregate. Startup and
subsequent reads repair a missing or stale aggregate from canonical state.
Corrupt canonical data fails closed; it is never replaced with an empty
board. Missing canonical state with an existing aggregate also fails closed.

A crash or disk error after the canonical commit but before publication or
HTTP acknowledgement may save a score even though its caller sees failure.
Check the board before retrying; this API has no idempotency key and a retry
can create a duplicate. The service returns success only after both writes
complete. An aggregate read will not knowingly serve an out-of-date file
when repair fails.

Back up `/var/lib/bbbscores/state.json` with the normal fleet backups. Its
atomic rename allows a backup to read a complete old or new version. The
aggregate is disposable and regenerated; the socket is not backup data.
Restore canonical state only while the service is stopped. Keep directory
ownership `bbbscores:bbbscores`, directory mode 0700, and JSON mode 0600.
Never expose the state directory through a static file server. Proxy the
public HTTP port instead.

## NixOS deployment

The flake exports `packages.<system>.bbbscores` (also `default`),
`devShells.<system>.default`, and `nixosModules.default` (also `bbbscores`) for
x86_64-linux and aarch64-linux. Tests and builds have been run on x86_64-linux;
aarch64 is declared but not runtime-tested.

In `/etc/nixos/flake.nix`, add an input and import its module on `dot`:

```nix
inputs.bbbscores.url = "github:suderman/bbbscores";
inputs.bbbscores.inputs.nixpkgs.follows = "nixpkgs";

# In dot's module imports:
imports = [ inputs.bbbscores.nixosModules.default ];

services.bbbscores = {
  enable = true;
  port = 3000;
  clientIpHeader = "x-real-ip";
};
```

The module installs the CLI, creates a dedicated user, manages
`/var/lib/bbbscores` with systemd `StateDirectory`, and restarts on failure.
Options mirror the environment settings: `host`, `port`, `allowedOrigins`,
`clientIpHeader`, `rateLimit`, `rateWindowMs`, plus `package`. No firewall port
is opened. Hardening keeps the system read-only outside state, hides home
and device files, drops capabilities, restricts system calls and address
families, and limits memory to 256 MB.

Caddy should terminate HTTPS and reverse proxy every score-host request:

```caddyfile
scores.boomboombaby.ca {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {client_ip}
    }
}
```

For Cloudflare, configure Caddy's `trusted_proxies` with Cloudflare's current
published CIDRs, enable strict proxy parsing, and set `client_ip_headers` to
`CF-Connecting-IP`. Restrict origin HTTP(S) access to Cloudflare at the
firewall. Without those settings, `{client_ip}` is a Cloudflare edge IP and
players share its quota. Never forward a client-supplied IP header unchanged.

At Cloudflare, bypass cache for `/*/high-scores` and `/health`. Keep
`scores.json` caching near 60 seconds and use Full (strict) TLS. Add canonical
state to fleet backups. Deployment and activation belong to the `/etc/nixos`
launch task, not this repository's build.

After deployment, verify public HTTPS reads and submissions for both games,
CORS from game and itch origins, real client-IP separation through
Cloudflare/Caddy, removal and aggregate refresh, backups, and persistence
through the normal NixOS restart. Local tests do not prove those paths.
