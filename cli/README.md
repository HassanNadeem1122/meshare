# meshare

P2P file sharing where every downloader becomes a server.

```
npx meshare ./photo.jpg
```

You get a link and a QR code (link is auto-copied). Anyone who opens the link downloads the file straight from you over WebRTC — nothing to install — and their browser tab immediately starts seeding it to the next person. Close your terminal: as long as any recipient still has the page open (or reopens it later — files are cached), the file stays alive.

## Usage

```
meshare <file>                     share a file (random link)
meshare <file> --name launch-kit   human-readable link: .../#launch-kit
meshare <file> --expires 3         link expires in 3 days (default 7)
meshare <file> --password s3cret   recipients must enter the password
meshare revoke <id>                kill a link you created, for everyone
```

Other flags: `--no-open` (don't auto-open the seeder tab), `--port N`, `--no-backup`.

## How it works

- Transfers are WebRTC data channels (direct when possible, TURN relay through strict NATs).
- Seeders register under deterministic IDs on the signaling network; recipients probe them and download from the first that answers, then join the seeder pool themselves.
- The CLI has no WebRTC (Node limitation), so it opens a local browser tab that does the seeding and reports live peer/transfer counts back to your terminal.
- Share names, expiry, revocation and passwords are enforced by a small Cloudflare Worker registry.

## Honest limitations

- A fully closed browser tab cannot seed (browser platform constraint). Reopening re-seeds instantly from local cache.
- If every seeder is offline at once, the file is unavailable until one returns — backup storage is planned.
- Signaling currently uses PeerJS's free public server (no uptime SLA).

Full docs: https://github.com/HassanNadeem1122/meshare

MIT © Hassan Nadeem
