# Linki — operator handover

For whoever runs this system. It assumes no knowledge of how it was built.

---

## 1. What Linki does

Linki runs LinkedIn outreach campaigns on your behalf, from your own LinkedIn
account, on your own server.

You build a **campaign**: a list of steps such as *visit a profile*, *send a
connection request*, *wait three days*, *send a message*. You add **prospects**.
Linki then works through them on a schedule, using a real browser signed in as
you, staying inside daily limits you set.

**What it will not do:**

- It will not message someone who has not accepted your connection request.
- It will not act outside the working hours and daily limits you configure.
- It will not sign in for you. When LinkedIn logs the session out, Linki stops
  and waits for a human — it cannot re-authenticate itself.
- It will not recover a campaign you delete. Deletion is permanent.
- It is not a way around LinkedIn's rules. It automates what you would otherwise
  do by hand, at a human pace, and the account risk is yours.

## 2. What protects you, and what each thing prevents

These exist because each one was, at some point, an actual failure.

| Protection | What it prevents |
|---|---|
| **Send-once ledger** | Sending the same message to the same person twice. Every message is recorded *before* it is sent, so if the server dies mid-send, the restart does not send it again. |
| **Refusal on doubt** | If Linki cannot tell whether a message was delivered, it **stops and asks you** rather than guessing. Guessing means either a duplicate or a silent gap, and a duplicate reaches a real person. |
| **Connection check** | A message step will not run unless the person is actually a 1st-degree connection at that moment. |
| **Identity checks on profiles** | A prospect row with a broken or foreign web address is refused instead of being visited. Prevents inviting the wrong person, or pointing your signed-in browser at a site that is not LinkedIn. |
| **Stable campaign steps** *(new)* | Editing a campaign no longer renumbers its steps. Previously, reordering could make someone who had *already connected* receive their message immediately, with no delay. |
| **Edit lock while running** | You cannot edit a campaign's steps while its run is active. The system refuses, rather than moving the ground under work in progress. |
| **Health monitor + auto-restart** | A stuck background worker is detected and restarted automatically, instead of a campaign silently doing nothing for days. |
| **Alerting** | When something goes wrong you are told — in the app, and to a webhook if you set one. Previously the system recorded problems accurately and told nobody. |
| **Encrypted session storage** | Your LinkedIn session is encrypted at rest. A copy stored unencrypted is refused rather than quietly used. |
| **Closed registration** | Only the first account can sign up. Everyone after gets refused. |
| **Verified backups** | Every backup is opened and checked after it is written. A backup that has never been opened is a hope, not a backup. |

## 3. What an operator must never do

Four things. Each has caused, or would cause, real damage.

**1. Do not edit a campaign while its run is `running`.**
Pause the run first, edit, then resume. The system now refuses the edit outright,
so this is mostly enforced — but do not go looking for a way around it.

**2. Do not add an account in a timezone other than UTC.**
This is a known, **unfixed** defect. The daily sending limit is counted against
UTC days while the account's working hours are counted in its own timezone. For a
non-UTC account the day boundaries do not line up and the account can send up to
**double** its configured daily limit, silently. There is no warning. Until this
is fixed, every account must be UTC.

**3. Do not let a second person sign up.**
Registration closes after the first account. If someone needs access, they use the
existing login. A second account would share the same data with no separation
between them.

**4. Do not delete a run whose log contains today's date while a campaign is
active.** Those rows are the record of what was actually sent to whom. Deleting
them removes the evidence that prevents a duplicate later.

## 4. Health states — what to do about each

Check the app banner, or `/api/health`.

| State | Means | What to do |
|---|---|---|
| **healthy** | The worker is running and making progress. | Nothing. |
| **degraded** | The worker is running but its recent attempts keep failing. | Look at the app banner for the error type. Often a LinkedIn session that has expired — sign in again from Settings. It will keep retrying; it is not stuck. |
| **dead** | The worker is not progressing at all. | The system tries to restart itself first. If it comes back healthy, no action. If it stays dead, the restart cannot fix it — check disk space and that the database file is readable, then read the container log. |

**One important subtlety.** If the system reports `dead` and also says a restart
will not help, it will **deliberately not restart** — and it now says so in the
log. That is correct behaviour, not a fault: repeatedly restarting a problem a
restart cannot fix would destroy in-progress work every few minutes while fixing
nothing. It needs a person.

**If you see a message step "waiting for a human"**, it means Linki sent something
and could not confirm delivery. Check LinkedIn yourself. If it arrived, mark it
delivered; if it did not, tell Linki to resend. Only you can see the real answer,
which is why it asks.

## 5. Backups and restore

- A backup script runs from the host on a schedule (cron). Each snapshot is
  written, then **opened and verified** before the oldest is pruned.
- Snapshots live in `data/backups/`, keeping the most recent **7** by default.
- **By default all snapshots sit on the same disk as the live database.** If that
  disk fails you lose both. Set `BACKUP_OFFSITE_DIR` to a second location — until
  you do, the backup script warns on every run, and that warning is accurate.

**The one blunt sentence about `NEXTAUTH_SECRET`:** your LinkedIn session is
encrypted with a key derived from `NEXTAUTH_SECRET`, so **if you lose that value,
every backup you hold becomes unusable for signing in** — the data restores, the
sessions do not, and every account must be re-authenticated by hand.

**How long a restore takes — measured, not estimated:** copying and verifying the
database takes well under a second, and the application is serving again about
**3 seconds** after that. That is the software. It is *not* the whole recovery:
restoring a day-old snapshot may still require signing in to every LinkedIn
account by hand through the UI, and **that is the part that actually takes time**.
It was never measured because it depends on you and on LinkedIn.

## 6. Residual risks — stated plainly

**Some messages will need a human.** When a send cannot be confirmed, Linki
refuses to guess and waits. This is the design working, but it means a campaign
can pause on one prospect until someone looks. Check for these.

**LinkedIn can change its website at any time, and no test will warn you first.**
Linki finds buttons and profile details by reading LinkedIn's page structure. When
LinkedIn changes that structure, steps start failing. The tests confirm Linki
behaves correctly against the structure as it was *last observed* — they cannot
predict a change LinkedIn has not made yet. Expect this periodically; it shows up
as steps failing suddenly and in bulk, and it needs a developer.

**Account risk is operational, not technical.** Linki paces itself and respects
limits, but LinkedIn restricts accounts at its own discretion. No setting removes
that risk. Keep daily limits conservative, especially on a new or lightly-used
account.

**The system assumes exactly one copy of itself is running.** Running a second
container against the same data would drive one LinkedIn account from two
browsers and send duplicates. Do not scale it up.

**One known defect is unfixed and listed above:** the non-UTC timezone limit
doubling. It is not dangerous if you keep every account on UTC.
