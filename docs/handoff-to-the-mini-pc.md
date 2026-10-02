# Handoff: moving Lyra to the mini PC

A one-time cutover runbook. After it, the MacBook runs nothing and `bmax-b4-1` is the only Lyra.

`docs/deployment.md` is the reference for each individual step; this is the **order**, and the
things that are only true because you are moving a *running* install with real data in it rather
than setting up a fresh one.

Written 2026-10-02 against the state of that machine on that day. Where it quotes a number — 85
entities, a 2.2 MB WAL — that was measured, not assumed.

---

## Read this part before you start

Four things will cost you the evening if you find them out in the wrong order.

### 1. `LYRA_SECRET_KEY` must move with the database

The `channels` table holds your Discord webhook **sealed**, AES-256-GCM, with the channel row's id
as the AAD. The key lives only in `.env.local` on the MacBook.

**Generate a new key on the box and that stored webhook is permanently unreadable.** Not degraded —
unreadable. The row stays, the UI shows its preview, and every send fails. You would have to delete
the channel and paste the URL again.

So: copy the existing `LYRA_SECRET_KEY` value across. Do not run `openssl rand` again.

### 2. Never copy `lyra.db` on its own

Right now that database is 524 KB and there is **2.2 MB sitting in `lyra.db-wal`** that is not in
it. SQLite runs in WAL mode; the main file is a snapshot of some earlier moment. `cp lyra.db` moves
a database missing four fifths of its recent writes, and it will open cleanly and look fine.

`VACUUM INTO` writes one consistent file with no sidecars. It is the only copy method in this
document for a reason.

### 3. One writer, and the overlap is silent

The Telegram bot long-polls `getUpdates`. Two running instances **fight over updates and drop
them**, and both send the daily digest. There is no error, no log line that says "another Lyra is
answering" — you just get half your replies and two copies of the brief.

The Mac service must be **stopped** before the box is started. Not after. Not at the same time.

### 4. Six commits are not on `master` yet

The box pulls GitHub *Releases*, which are built from `master`. As of writing, the second brain,
the hub, the DeFi schedule and the schedule editor are all on
`feat/agents-office-and-focus-timer` and none of them is in any release. **Phase 0 merges them**,
or you will move everything across and arrive at last week's Lyra.

---

## Phase 0 — on the MacBook, before you touch the box

### 0.1 Merge and release

**Already done, 2026-10-02.** PR #9 merged to `master` as `0acb3c3`, and the release the box will
install is **`build-5-0acb3c3`**. Confirm it is still the newest before you start:

```bash
gh release list --limit 1        # expect build-5-0acb3c3 or newer
```

If you push anything else before the cutover, wait for its release too — the box installs from
`master`, not from your working copy.

### 0.2 Rehearse the database copy — do not use this one

Run it now to prove the method and the counts, then throw the file away. **The copy you actually
move is taken in Phase 2, after the Mac has stopped**, because a `VACUUM INTO` is a consistent
snapshot *of one moment* and the service keeps writing after it. Exporting today and cutting over
tomorrow silently loses a day.

```bash
P="$HOME/Library/Application Support/Lyra"
sqlite3 "$P/data/lyra.db" "VACUUM INTO '$HOME/Desktop/lyra-rehearsal.db'"

# Prove it is complete before you trust it, not after.
sqlite3 ~/Desktop/lyra-rehearsal.db "pragma integrity_check;"         # ok
sqlite3 ~/Desktop/lyra-rehearsal.db "pragma user_version;"            # 13
sqlite3 ~/Desktop/lyra-rehearsal.db "select count(*) from entities;"  # 85
sqlite3 ~/Desktop/lyra-rehearsal.db "select count(*) from jobs;"      # 285
sqlite3 ~/Desktop/lyra-rehearsal.db "select count(*) from crons;"     # 1
sqlite3 ~/Desktop/lyra-rehearsal.db "select count(*) from channels;"  # 1

rm ~/Desktop/lyra-rehearsal.db        # it is already out of date
```

If `integrity_check` says anything but `ok`, stop and ask.

### 0.3 Write down the secrets

You need the **values**, not the names. The allowlist in `ops/service-env.list` has 27 keys; these
are the ones that are actually set on the Mac today:

| Key | Why it matters |
|---|---|
| `JWT_SECRET` | the API refuses to start without one |
| `LYRA_SECRET_KEY` | **must be the same value** — see §1 above |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | the bot and where it writes |
| `ALERT_WALLETS` | the wallets the sweep and the DeFi report read |
| `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, `KUCOIN_API_PASSPHRASE` | the exchange half of the portfolio |

Not set today, and worth adding while you are there: `DISCORD_WEBHOOK_URL`, so reports reach
Discord and not only Telegram. `TELEGRAM_OWNER_USER_ID` too, or the life commands decline until you
sign in on the box.

```bash
cat "$HOME/Desktop/code/home-ai-assistant/lyra/.env.local"
```

Put them somewhere you can retype them on the box. **Not in the repo, not in a chat, not in a
file you then sync** — it is public, and these are live credentials for real money.

---

## Phase 1 — on the mini PC (`bmax-b4-1`)

SSH is closed on that machine, so unless you open it you are typing at the box itself. Opening it
is worth the two minutes if you ever want to deploy without walking over:

```bash
sudo apt install -y openssh-server && sudo systemctl enable --now ssh
```

### 1.1 Prerequisites

```bash
sudo apt update
sudo apt install -y sqlite3 curl rsync ca-certificates git
```

`sqlite3` is not optional: the nightly backup timer and the pre-deploy backup both shell out to it,
and both fail silently-ish without it.

### 1.2 Clone and install

```bash
git clone https://github.com/bondzai/life-os-ui.git ~/lyra
cd ~/lyra
sudo ./ops/lyra-server-linux.sh setup
```

That writes the systemd unit, the update timer and the nightly backup timer, and creates
`/opt/lyra/{bin,ui,data,releases,backups}`.

### 1.3 The environment file

```bash
sudo mkdir -p /etc/lyra
sudo nano /etc/lyra/.env.local        # paste the values from 0.3
sudo chmod 600 /etc/lyra/.env.local
```

**`LYRA_SECRET_KEY` is the one to double-check.** Same value as the Mac, character for character.

If a variable the server reads is missing from `ops/service-env.list`, it works under `cargo run`
and is silently absent in production. A test guards that list; if it ever fires, add the key rather
than deleting the test.

---

## Phase 2 — the cutover

This is the part with an order. Nothing here is hard; doing it out of sequence is how you get two
bots and a lost afternoon.

```
  MacBook                              bmax-b4-1
  ───────                              ─────────
  1. stop the service                  (nothing running yet)
  2. VACUUM INTO, now that
     nothing can write behind you
  3. copy it across        ──────▶     4. put it in /opt/lyra/data
                                       5. start the service
                                       6. verify
  7. uninstall for good
```

### 2.1 Stop the Mac. First.

```bash
cd ~/Desktop/code/home-ai-assistant/lyra
./ops/lyra-server.sh stop
curl -s http://localhost:3030/api/health     # must fail now
```

From this moment Telegram has no Lyra. That is correct and it is the point.

### 2.2 Now take the copy you will actually move

With the service stopped nothing can write behind you, so this file is the last word.

```bash
P="$HOME/Library/Application Support/Lyra"
sqlite3 "$P/data/lyra.db" "VACUUM INTO '$HOME/Desktop/lyra-handoff.db'"
sqlite3 ~/Desktop/lyra-handoff.db "pragma integrity_check; select count(*) from entities;"
```

### 2.3 Move the file

Tailscale is already up on both, and Taildrop needs no SSH:

```bash
# on the Mac
tailscale file cp ~/Desktop/lyra-handoff.db bmax-b4-1:

# on the box
tailscale file get ~/
```

With SSH open, `scp ~/Desktop/lyra-handoff.db bmax-b4-1:~/` does the same thing.

### 2.4 Put it in place

```bash
sudo systemctl stop lyra 2>/dev/null || true
sudo install -o lyra -g lyra -m 644 ~/lyra-handoff.db /opt/lyra/data/lyra.db
# No sidecars to bring: VACUUM INTO produced a single consistent file, and a stale -wal
# or -shm beside it would be read as part of a database it does not belong to.
sudo rm -f /opt/lyra/data/lyra.db-wal /opt/lyra/data/lyra.db-shm
sudo chown -R lyra:lyra /opt/lyra/data
```

The `data/` **directory** must be writable by the service user, not just the file — otherwise the
first write fails with `attempt to write a readonly database`.

### 2.5 Start it

```bash
sudo systemctl start lyra
sudo ./ops/lyra-server-linux.sh status
journalctl -u lyra -n 50 --no-pager
```

The update timer will also pull the newest release within five minutes. If you would rather not
wait:

```bash
sudo /opt/lyra/bin/lyra-update.sh
```

---

## Phase 3 — verify before you burn the boat

Run all of these. The first two prove it started; the rest prove your *data* came with it.

```bash
curl -s http://localhost:3030/api/health                      # {"status":"ok"}
sqlite3 /opt/lyra/data/lyra.db "pragma user_version;"         # 13 or higher
sqlite3 /opt/lyra/data/lyra.db "select count(*) from entities;"   # 85
sqlite3 /opt/lyra/data/lyra.db "select count(*) from crons;"      # 1
sqlite3 /opt/lyra/data/lyra.db "select count(*) from channels;"   # 1
```

Then, in a browser on the tailnet — **http://100.90.153.67:3030**:

- **Settings → Notifications** — your channel is listed, and **Test** on it succeeds. This is the
  real check on `LYRA_SECRET_KEY`: if the key is wrong the test fails and nothing else will have
  told you.
- **Settings → Schedules** — your schedule is there. Press **Run now**.
- **Telegram** — send `/today`. One reply, not two. Two means the Mac is still running.

---

## Phase 4 — shut the MacBook down for good

Only after Phase 3 passes.

```bash
cd ~/Desktop/code/home-ai-assistant/lyra
./ops/lyra-server.sh uninstall       # removes the LaunchAgent so it cannot come back on reboot
```

**Keep these for a fortnight**, and do not delete them the same day:

- `~/Desktop/lyra-handoff.db` — the thing you moved
- `~/Library/Application Support/Lyra/backups/` — the pre-v13 backups, including the v8 one from
  before the upgrade
- the repo itself, which is also just a clone of a public remote

The box now takes its own nightly `VACUUM INTO` into `/opt/lyra/backups`, kept fourteen days, and
`deploy` takes one more immediately before every swap.

---

## If it goes wrong

**The box will not start.** `journalctl -u lyra -n 100`. The usual causes, in order: `JWT_SECRET`
missing, `/opt/lyra/data` not writable by `lyra`, or a stale `-wal` left beside the database.

**It starts but every page is empty.** A missing environment variable, not a crash — see
`docs/deployment.md` §7.1. The API is healthy; something it reads is unset.

**The Discord channel fails its test.** `LYRA_SECRET_KEY` does not match the one that sealed it.
Fix the key and restart; if the original is genuinely lost, delete the channel and add it again
with the webhook URL.

**You want the MacBook back.** It is still there until you uninstall:

```bash
sudo systemctl stop lyra       # on the box, first — one writer
./ops/lyra-server.sh install   # on the Mac
```

Its database is whatever it was when you stopped it in 2.1, which is the same content you copied
across. Anything Lyra recorded on the box after the cutover does not come back.
