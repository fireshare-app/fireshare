# Users, Permissions, and Profiles

Fireshare supports multiple user accounts. An administrator creates them, grants
each one a set of permissions, and every account gets a shareable profile page
listing what they uploaded.

## Permissions

Every account is either an **administrator** — who can do everything, including
change server settings and manage users — or a regular account holding a set of
individual permissions.

| Permission | What it allows |
| --- | --- |
| `view_private` | See private videos and images in feeds, folders, tags, and games |
| `upload` | Upload videos and images |
| `edit_own` | Edit titles, descriptions, privacy, crops, and posters on **their own** uploads |
| `delete_own` | Delete **their own** uploads |
| `edit_any` | Edit any media, including content with no uploader |
| `delete_any` | Delete any media, including content with no uploader |
| `manage_tags` | Create, rename, delete, and assign tags |
| `manage_games` | Manage game metadata and artwork, add custom games, and manage folder rules |
| `transcode` | Start and cancel transcoding jobs |
| `manage_library` | Use the bulk File Manager and trigger library scans |

Server configuration and user management are administrator-only and cannot be
granted individually — that is what keeps "administrator" a meaningful role.

### Presets

The Add User dialog offers three presets. They are only shortcuts for ticking
boxes; nothing about a preset is stored, so you can adjust any account freely
afterwards.

| Preset | Permissions |
| --- | --- |
| **Viewer** | `view_private` |
| **Contributor** | `view_private`, `upload`, `edit_own`, `delete_own`, `manage_tags` |
| **Curator** | Contributor plus `edit_any`, `delete_any`, `manage_games`, `transcode`, `manage_library` |

### Upgrading an existing install

Accounts that already existed before permissions were introduced could do
everything a signed-in user could do. The upgrade grants each of them the full
Curator permission set, so nobody loses access. Narrow them afterwards if you
want to.

## Adding users

**Settings → Users → Add User** (administrators only).

Choose a username, pick a preset or individual permissions, and choose how the
person gets their password:

- **Send a setup link** (recommended) — Fireshare generates a one-time link you
  copy and hand over. You never see or choose their password. The link expires
  after 7 days and works once.
- **Set a password now** — you type an initial password. The account is flagged
  to require a change at next sign-in.

Fireshare has no mail server, so setup links are copied from the dialog rather
than emailed.

Usernames may contain letters, numbers, dots, dashes, and underscores, must be
2–32 characters, and must start and end with a letter or number. A short list of
reserved names (`admin`, `api`, `settings`, and similar) is rejected because they
would collide with a URL or read as a system account.

## Passwords

Anyone can change their own password under **Settings → Security**. Changing it
requires the current password.

An account created with a password an administrator typed is asked to replace it
the first time it signs in, before the rest of Fireshare becomes available.

An administrator can reset someone's password, or issue a fresh setup link, from
**Settings → Users**. An administrator can also clear a stuck two-factor
enrollment there — the same recovery the `fireshare disable-mfa` command performs.

## Profiles

Every account has a profile page at `/u/<username>` showing what they uploaded,
their upload counts, and total views. The link renders Open Graph metadata, so it
previews properly when pasted into Discord or similar.

What a visitor sees:

- **Anyone with the link** sees only that account's **public** uploads. Private
  media stays link-only, exactly as it does everywhere else in Fireshare.
- **The account owner** always sees their own private uploads on their profile.
- **Other signed-in users** need `view_private` to see someone else's private
  uploads.

`view_private` governs *discovery* — the feeds, folder and tag listings, game
pages, and profiles. It does not change what a share link does: private media
stays link-only, so anyone holding a link to one item can still open that item.

Users can set a display name, a short bio, and a profile picture from **Edit
profile** on their own page. Turning off **Share my profile page** makes the page
return "not found" to visitors; individual video and image share links keep
working.

Profile pictures are re-encoded to a 256×256 WebP on upload. Only the decoded
image survives, which strips camera metadata and makes it impossible to hide
anything in the file. Accounts with no picture get a lettered placeholder in a
colour derived from the username.

Uploads show a clickable uploader byline on the main video and image pages, which
links to that person's profile.

## Media ownership

Videos and images record who uploaded them. Ownership is what makes `edit_own`
and `delete_own` meaningful.

On upgrade, everything already in the library is attributed to the administrator
account — the one `ADMIN_USERNAME` manages. Nothing in the old schema recorded
who uploaded what, and on the single-admin install that describes most upgrades
the administrator is the accurate owner. Reassign anything that belongs to
someone else from **File Manager → Uploader**; the upgrade prints how many items
it attributed.

Files a library scan finds on disk are attributed to that same administrator
account as they are indexed. Nothing on the server's own filesystem can say who
put it there, and the person who runs the server is the one who did, so the
administrator is the accurate owner; hand anything that belongs to someone else
to them from **File Manager → Uploader**. Uploads made while signed in belong to
the account that made them.

Media has **no uploader** when it was:

- uploaded through the public (unauthenticated) upload form, or
- had its uploader deliberately cleared.

Unowned media appears on no profile, and `edit_own` / `delete_own` deliberately
do **not** grant access to it — only `edit_any` / `delete_any` do. Otherwise
every account with "own uploads only" access would implicitly control the entire
pre-existing library.

**Deleting a user never deletes their media.** The uploader link is cleared and
the content stays in the library as unowned.

### Adopting existing content

To give a pre-existing library an owner, select files in **File Manager** and use
**Uploader**. Pick an account to attribute them to, or "No uploader" to clear the
link again. Once attributed, the media appears on that person's profile and comes
under their `edit_own` / `delete_own` permissions.

## Guardrails

Fireshare refuses, server-side, to:

- remove administrator access from the last enabled administrator,
- disable or delete the last enabled administrator,
- let anyone disable, delete, or demote their own account,
- demote or delete the account managed by `ADMIN_USERNAME` / `ADMIN_PASSWORD`,
  since startup would reinstate it on the next restart.

Disabling an account ends its access immediately, including any active session
and any "remember me" cookie.

## Sign in with Discord

Members of your Discord server can sign in with their Discord account instead of a
password. A Fireshare account is created for them the first time they sign in, so
you don't hand out passwords or create accounts by hand.

### Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application. Under **OAuth2**, copy the client ID and secret, and add
   `https://<your DOMAIN>/api/auth/discord/callback` as a redirect. No bot is needed.
2. Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `DOMAIN` (or
   `DISCORD_REDIRECT_URI`) in the environment and restart.
3. In **Settings → Integrations → Sign in with Discord**:
   - enter your **Server ID** (Discord Developer Mode, then right-click the server → Copy ID),
   - optionally a **Role ID** that people must have,
   - choose the permission preset for new accounts (Contributor by default),
   - tick **Enable**, then save.

The login page then shows a **Sign in with Discord** button. Fireshare asks Discord
for the `identify` and `guilds.members.read` scopes and only keeps the Discord user
ID. The access token is revoked straight after sign-in.

### How accounts are matched

- Accounts are matched only by Discord user ID, never by username. A Discord user
  called `nick` does not get into an existing local account `nick`; they get `nick-2`.
- The username comes from the Discord username, limited to letters, digits, `_`,
  `.` and `-`. If that leaves nothing usable or a reserved name, it becomes
  `discord-<last 6 digits of the ID>`. It is never renamed later.
- New accounts are never administrators. Change permissions afterwards in
  **Settings → Users** like any other account.
- Discord accounts have no password, so password login doesn't work for them, and
  **Change password** is hidden. Two-factor authentication still works if they set it up.

### When someone leaves the server

Membership and the required role are checked at every sign-in. A Discord session
also expires after 24 hours, which forces a fresh check (one click if they're still
a member). With **Disable the account when someone leaves** ticked, a failed check
disables the account. That also stops its upload tokens, and an admin has to
re-enable it. Without it, sign-in is refused but the account stays enabled, so its
upload tokens keep working until it is disabled by hand.

## LDAP has been removed

LDAP authentication is gone. Every account is a local account.

To make sure the change is never a surprise, Fireshare **refuses to start**
while any `LDAP_*` variable is still set, and it does this before touching the
database. Removing those variables is how you confirm the upgrade:

```
LDAP has been discontinued
---------------------------------------------------------------------
LDAP authentication has been removed from Fireshare in this version
and all later versions. This instance still has an LDAP
configuration, so Fireshare has not started and your database has
not been modified.
```

Remove the variables from your compose file and start Fireshare again. On that
first start, each directory account is converted to a local account:

- Uploads, profile, display name and permissions are kept. Nothing is deleted,
  and every account keeps its database id, so media stays attributed to whoever
  uploaded it.
- The account has no password, so it cannot sign in yet. Set one, or send an
  invite, from **Settings → Users**.
- Administrator status is left exactly as it was at that account's last
  sign-in. It used to be re-derived from `LDAP_ADMIN_GROUP` on every login;
  now it is an ordinary flag you manage yourself. Worth reviewing once after
  the upgrade, since it is no longer maintained for you.

If you still depend on a directory server, do not remove the variables. Pin
your image to the release you were running before the upgrade and stay there.

## Command line

```bash
# Create a non-admin account with the Contributor preset (the default)
fireshare add-user -u alice

# Create an administrator
fireshare add-user -u bob --admin

# Create an account with specific permissions
fireshare add-user -u carol --permissions upload,edit_own,delete_own

# Review who exists and what they can do
fireshare list-users

# Two-factor lockout recovery
fireshare disable-mfa -u alice
```

> **Note:** `add-user` now creates **non-admin** accounts by default. Before
> permissions existed it created administrators, because the underlying admin
> flag defaulted to true. Pass `--admin` if you want the old behaviour.
