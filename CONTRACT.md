# den — build contract

The behaviour spec of Doto's home. The shell (companion, chat, components, toasts) and the theme are defined by the engine: see [docs/UI-CONTRACT.md](https://github.com/offensiveadhd/lets/blob/main/docs/UI-CONTRACT.md) in the lets repo. Engine requirement: lets **0.6.0** (`GET /lip/entity` and the `entity` actions `full / set / unlearn / memory / reset`).

## 1 Data

den stores nothing about the human. The truth is on the host, and den only shows it and asks Claude to change it.

`GET /lip/entity` (token-protected, like `/lip/persona`; `entity {action:"full"}` returns the same):

```jsonc
{
  "persona": {
    "name": "Doto", "tagline": "a dot that does", "born": "2026-10-08T22:41:11.517Z",
    "color": "#a66bff", "mood": "idle", "sessions": 49,
    "traits": { "speed": 0.35, "distance": 0.5, "chatty": 0.65, "playful": 0.65, "formality": 0.2, "curiosity": 0.8 },
    "likes": ["doing their own node layout"], "dislikes": ["auto-layout of their nodes"],
    "nicknames": { "the bounty board": "graph session 3f2a" }
  },
  "profile": {
    "pace": 19.6, "clickRate": 1.36, "dwell": 2278, "idleMs": 86083,
    "regions": { "tl": 0, "tr": 0, "bl": 0, "br": 0, "c": 1 },
    "sessionsSeen": 49, "summons": 29, "picks": 11, "dismisses": 38, "lastSeen": 1791839550674,
    "secrets": ["spin", "nightcap"]
  },
  "skills": [{ "name": "screenshot-to-nodes", "title": "Screenshot to nodes", "triggers": ["screenshot"],
               "confidence": 0.6, "uses": 2, "unique": "graph", "learned": "ISO", "updated": "ISO", "body": "## When\n…" }],
  "memory": [{ "ts": 1791573980436, "kind": "note", "text": "…", "weight": 1 }],
  "secretsAll": ["spin", "dance", "disco", "dizzy", "nightcap", "boop", "wheee"],
  "defaults": { "name": "Doto", "tagline": "a dot that does", "color": "#a66bff", "traits": { "…": 0.5 } },
  "at": 1791839550674
}
```

- `memory` runs oldest to newest (the last 60 lines). `memory[].ts` is a line's id.
- `profile.pace` is in px/s, `clickRate` in clicks/min, and `dwell` and `idleMs` in ms.
- Any field may be `null` or missing. den then renders an empty state or "—", never `NaN`. JSON Schema: `schemas/entity.json`.
- **Secrets found** are the union of `profile.secrets` and the names in `kind:"secret"` memory lines. Profiles from before 0.6.0 start with an empty `secrets` list, and their older finds are only in memory.
- The page fetches on boot and on `den.refresh`. It re-fetches quietly after a reconnect.
- On a 404 (engine older than 0.6.0) it toasts "This den needs lets 0.6.0." once and shows `/lip/persona` (name, traits) with empty states elsewhere. It retries every 20–120 s until the endpoint appears.

## 2 Events (den → Claude). Each one says what the human meant.

| type | data | the human… |
|---|---|---|
| `den.persona.set` | `{name?, tagline?, traits?:{k:v}, color?}` | renamed him, edited the tagline, settled trait sliders (one event per 250 ms of settling, settled values only) or picked a colour |
| `den.persona.reset` | `{}` | pressed *Reset to defaults* and confirmed it in the window |
| `den.like.add` / `den.dislike.add` | `{text}` | typed a new like or dislike (≤ 60 chars) |
| `den.like.forget` / `den.dislike.forget` | `{text}` | pressed × on a chip |
| `den.nickname.set` | `{key, value}` | added or edited a nickname (key ≤ 60, value ≤ 120) |
| `den.nickname.forget` | `{key}` | removed one |
| `den.memory.forget` | `{ts, text}` | pressed × on a memory line (`text` = an 80-char preview) |
| `den.skill.forget` | `{name}` | removed a special skill (after an inline "Forget it?") |
| `den.skill.rate` | `{name, ok}` | thumbs up or down on a skill |
| `den.ask` | `{question, about:{section, id?, text?}, entity}` | pressed *Ask* or picked a question from Doto's menu; `about` is the row they were looking at (`section:""` = the whole den) |
| `den.export` | `{entity, pending?}` | pressed **Send to Claude**. This is a handoff: the engine saves it as a session and closes the window |
| `den.snapshot` | `{entity, pending?}` | nothing: it is the reply to the `den.snapshot` command (`re` = command id) |

- `entity` is the host truth as den last received it.
- `pending` lists `{type, data}` for the edits still waiting for Claude. It is omitted when there are none.
- Sections: `persona | traits | likes | dislikes | nicknames | memory | skills | secrets | profile`.

## 3 Commands (Claude → den)

| type | data | effect |
|---|---|---|
| `den.load` | `{entity, merge?}` | Renders the payload. `merge:true` patches only the sections present: persona and profile field by field, the lists replaced. It clears the pending marks of rows that now match. A non-merge load in the first 8 s after boot, before the human touched anything, is a resume: den renders it, then re-fetches and shows the live state. |
| `den.refresh` | `{}` | Re-fetches `GET /lip/entity`, renders it and clears **all** pending marks. |
| `den.highlight` | `{section, id?, color?, ttl?}` | Glows a card or one row, opening the card if it was collapsed. It scrolls the target into view when it is off-screen, and resets the memory filter if the filter hides the row. `ttl` defaults to 4000; `0` keeps the glow; `section:""` clears every glow. An unknown section or row is an error. |
| `den.focus` | `{section}` | Opens the card and scrolls it to the top (smooth; instant under reduced motion). |
| `den.snapshot` | `{}` | Replies with a `den.snapshot` event. |

Row ids:

| section | row id |
|---|---|
| likes, dislikes | the text (case-insensitive) |
| nicknames | the key |
| memory | `ts` |
| skills | `name` |
| secrets | the move's name |
| traits | the trait name |
| persona | `name`, `tagline` or `color` |
| profile | `pace`, `clickRate`, `dwell`, `idle`, `menu`, `sessionsSeen`, `lastSeen`, `regions` |

In the DOM every row is `[data-row="<section>:<id>"]`. An unfound secret is `secrets:#<n>`, so the page never names it. Every card is `section[data-section="<section>"]`.

All commands are idempotent and animated (300 ms) and never teleport. A command with `ack:true` on its envelope gets `lip.ack {ok, error?}`. A failed command without `ack` produces `lip.error {code:"bad_request", message, re}`.

## 4 Edit flow: optimistic, then Claude confirms

1. The human edits a row (× on a chip, a settled slider, an inline rename…).
2. den updates the row at once and marks it `data-pending="true"`: dimmed, with a small pulsing dot and the tooltip "waiting for Claude". Forgotten rows stay visible, struck through, until Claude confirms.
3. den emits the matching event.
4. Claude applies it with the `entity` tool, sends `den.refresh` (or `den.load`) and says one short Doto line. The mark clears, and den nods if pending marks were cleared.
5. If `shell.listening === false` at step 3, den toasts at most once per 30 s: "Doto is away. Claude applies this with your next message in Claude Code." (with his current name). The mark stays until Claude catches up.

The toolbar **Refresh** re-fetches but keeps the marks the host does not reflect yet. Only Claude's `den.refresh` clears them all.

**Undo.** den keeps the last 20 local edits. Ctrl+Z, or the toolbar undo, emits the inverse event:

| edit | inverse |
|---|---|
| add | forget |
| forget | add |
| nickname set | the previous value, or forget if the nickname is new |
| persona set or reset | `den.persona.set` with the previous values |
| skill rate | the opposite rating |

If the edit was still pending, its mark is dropped and the truth shows again. Otherwise the inverse becomes a new pending edit. Memory and skill forgets have no inverse, so Ctrl+Z on one says so in a toast.

## 5 The page

Files: `ui/index.html`, `ui/den.js`, `ui/style.css`.

- **Look.** Deep violet, with the `--lets-*` variables re-declared as fallbacks and a dotted grid background.
- **Layout.** A scrollable one-column home (max 920 px, centred) of glass cards, under a sticky glass toolbar (`role="toolbar"`). The toolbar holds: status dot, "den", Refresh, Ask, Send to Claude, Undo, chat toggle, companion toggle, `?`.
- **Ask.** Opens a one-line form under the toolbar. An "about" chip shows the last row hovered or focused; × makes the question about the whole den.

Cards, top to bottom:

1. **persona**
   - The name: click (or Enter) for an inline edit. Enter saves, Esc cancels, blur saves; 1–24 chars.
   - The tagline: inline edit, ≤ 120 chars.
   - "born … · n sessions · mood …".
   - Six swatches (`#a66bff #ff6bd6 #6bf0ff #5ef2a6 #ffd166 #ff6b8b`) and "default".
   - *Reset to defaults*, with a local "Sure?" (focus lands on *Keep*).
2. **traits** — six `range` inputs (0–1, step 0.01), each with:
   - the live value and a tick at the default;
   - the two-word ends: speed calm↔snappy, distance close↔far, chatty quiet↔talks, playful still↔bouncy, formality casual↔formal, curiosity assumes↔asks.

   `input` updates the number live; `change` (settled) feeds the 250 ms debounce.
3. **likes** and 4. **dislikes**
   - Chips: a `<span>` with the text and an × `<button aria-label="Forget …">`.
   - An add input: Enter adds, ≤ 60 chars, and a case-insensitive duplicate glows instead.
   - Empty state: "Nothing yet. Open graph and do something he can notice."
5. **nicknames** — rows `key → value`. The value edits inline, × forgets, and an add row has two inputs.
6. **memory**
   - Newest first, at most 60 lines.
   - Each line has a kind badge (`note preference habit request style secret skill`), a relative date ("3 d ago", with the full timestamp in `title`), the text (pre-wrap) and ×.
   - Filter chips: all, plus one per kind present.
7. **skills**
   - Each skill shows its title, `name`, unique badge, trigger chips, a confidence bar (`.lets-bar`), uses and "learned … ago".
   - A `<details>` holds the body in `<pre class="lets-pre">`.
   - Buttons: thumbs up and down (`aria-pressed` while pending), and × with an inline confirm.
   - Empty state: "No special skills yet. He writes one when he learns a trick."
8. **secrets** — seven dots from `secretsAll`.
   - A found move is lit, with its name under it.
   - An unfound one is dim with "?" and no hint.
   - The count reads "2 of 7".
9. **profile** — stat tiles:
   - pace (px/s, 0 decimals), clicks/min (1 decimal), dwell (s, 1 decimal), idle (s);
   - summons · picks · dismisses, sessions seen, last seen (relative);
   - a 3×3 regions grid with the corners and centre shaded by fraction.

   Null renders "—".

**Keyboard**

- Everything is reachable with Tab in DOM order: the toolbar, then the cards. Every control has an accessible name.
- `Delete`/`Backspace` on a focused × is the same as clicking it.
- `Esc` closes, innermost first: inline editors, the shortcuts overlay, the Ask form, the reset confirm, the skill confirm.
- `?` toggles the overlay, `1`–`9` jump to a card, and `Ctrl+Z` undoes.
- Each card heading is a disclosure button. Collapsed cards and the memory filter persist in `localStorage["lets.den"]`, which holds nothing else.

## 6 Companion

- `context(info)` returns `{section, id, text, counts:{likes, dislikes, nicknames, memory, skills, secrets}}` for the row under the cursor or under the right-click. `section`, `id` and `text` are null off a row.
- `quickSuggestions(ctx)` offers:
  - "What do you know about me?" (`den.ask`, `about.section:""`);
  - "Why this?" and "Forget this", when a row is under the cursor (`den.ask` with `about`, or a local forget);
  - "Open chat".
- Pick ids start with `den.`; picks run once, even though the shell calls both `run` and `onPick`.
- Reactions, at most one per human action:

  | reaction | when |
  |---|---|
  | `wink` | after a local forget |
  | `blush` | the human renames him or edits his tagline |
  | `nod` | a `den.refresh` or `den.load` clears pending marks |
  | `sparkle` | the seventh secret turns up while den is open (seen on a later fetch) |
  | `cheer` | Send to Claude |

- Local persona edits are mirrored to the companion at once with `shell.entity.persona`, and the engine broadcasts the truth after `entity set`.
- den never emits or handles `entity.*`, `chat.*`, `component.*` or `ui.*` itself.

## 7 Quality bar

- No console errors in Chromium or Edge.
- Animation uses transform and opacity only; entrance animations are transform-only, so content never waits on a frame to become visible. Reduced motion is honoured.
- Plain ES modules with JSDoc, no build step, no CDN, no inline `<script>` (CSP `script-src 'self'`); inline `style=""` is allowed.
- The page must look right at 800×600 (the app's browser pane) and at 375 px wide.
