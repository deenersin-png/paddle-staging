# The pre-run email

Every minute, this checks whether anybody is due to report in the next couple
of minutes. For each operator who is, it works out their run exactly as the app
does, looks up the bus one headway ahead of them and any detour on their
routes, and sends one email.

The switch is in the app: **My run → ALERTS → Email me before my run starts**.
Until the steps below are done, that switch does nothing and the screen says so.

---

## What it costs

Realistically **nothing**, but Google needs a card on file before it will let
any project reach the internet or run on a schedule.

- Switching the project to the **Blaze** plan asks for a credit card. Blaze is
  pay-as-you-go, and it keeps the same free monthly allowance the free plan has.
- This job runs about **43,000 times a month**. The free allowance is
  **2,000,000**. Running memory, the emails themselves and the SEPTA lookups are
  all well inside their free allowances too.
- So the expected bill is **$0.00/month**. Set a budget alert anyway (step 1)
  and Google will email you if anything ever changes.

The card is needed for one specific reason: the free plan blocks outgoing
internet calls, and this has to call SEPTA.

---

## Setting it up, once

**1. Switch the project to Blaze.**
Firebase console → the gear icon → **Usage and billing** → **Details & settings**
→ **Modify plan** → Blaze. While you are there, set a budget alert of a few
dollars so you hear about anything unexpected.

**2. Make a Gmail app password** (so the email comes from your own address and
does not land in spam).
Google account → **Security** → 2-Step Verification must be on → **App passwords**
→ create one called "Paddle App". You get a 16-character password. It is not
your Gmail password and can be revoked at any time.

**3. Install Node.js** (once, on your PC). It is what runs this code, and `npm`
— the command in the next steps — comes with it:

```bash
winget install OpenJS.NodeJS.LTS
```

Then **close the terminal and open a new one**, or Windows will not have picked
up the new command yet. `node --version` should answer with a version number.

**4. Install the Firebase tools** (once):

```bash
npm install -g firebase-tools
```

```bash
firebase login
```

**5. Install this folder's dependencies.** Run this from the project folder
(`septa-scheduler`), not from inside `functions` — the `--prefix` is what says
which folder to install into:

```bash
npm --prefix functions install
```

It downloads into `functions/node_modules` and finishes with a line like
`added 420 packages`. Nothing is committed to git; the folder is ignored.

**6. Give it the Gmail details.** These are stored by Google as secrets, not in
the repo:

```bash
firebase functions:secrets:set GMAIL_USER
firebase functions:secrets:set GMAIL_APP_PASSWORD
```

The first asks for the Gmail address to send from; the second for the
16-character app password from step 2.

**7. Deploy:**

```bash
firebase deploy --only functions,firestore:indexes
```

The deploy copies the app's own schedule modules into `functions/vendor/`
first, so the email can never disagree with the app.

Nothing here touches the website — that stays on GitHub Pages exactly as it is.

---

## Checking it works

- Open **My run → ALERTS**. Under "Email before my run" it says
  *Sender is running · last checked …* within a minute of deploying.
- Turn the switch on, set the minutes, and check the address it sends to.
- To try it without waiting for a real run: on My run → SCHEDULE, tap today and
  give yourself a run with a report time a few minutes from now. The email
  arrives at that time minus your chosen minutes. Remove the day afterwards.
- Logs: `npm --prefix functions run logs`.

---

## How it behaves

- **The send time is the scheduled one.** A leader running late never moves it,
  the same rule the countdown follows.
- **One email per run.** The claim is written to Firestore before sending, so
  two copies of the job cannot both send. If sending fails, the claim is
  dropped and the next minute tries again.
- **A missed minute still sends**, up to 3 minutes late, and the email says how
  far off the report time actually is.
- **Missing live data never stops the email.** No leader, no detour feed, or a
  run the paddle does not know each degrade to a line saying so.
- **Vacation weeks, days off and edited days** are all honoured, because the
  resolver is the app's own (`vendor/pa-resolve.js`).

## Files

| | |
|---|---|
| `index.js` | the every-minute job: who is due, claim, send |
| `lib/plan.js` | works out the run, the leader and the detours |
| `lib/email.js` | the email itself (subject, HTML, plain text) |
| `vendor/` | **generated** — copies of `assets/pa-schedule.js`, `pa-resolve.js`, `pa-live.js`. Never edit; edit the originals |
| `scripts/sync.js` | makes those copies (`npm run sync`, and the deploy does it) |
