<p align="center"><img src="icon.svg" width="72" alt=""></p>
<h1 align="center">den</h1>
<p align="center"><b>Doto's home.</b><br>The second default <a href="https://github.com/TikoTikTok/lets">lets</a> unique: see everything the companion learned about you, and edit or forget any of it by pointing. Nothing is inferred silently in lets, and den is where you can check that.</p>

---

## Install

It comes with `lets` 0.6.0. The engine installs `den` into `~/.lets/uniques/den` the first time it runs, because it is listed in the engine's `defaults.json`. Then:

```
/lets:lets den          # or /lets den with the alias
```

Manual: `/lets store den` (inspect → confirm), or clone this repo into `~/.lets/uniques/den`, or set `LETS_UNIQUES_DIRS=<parent folder>` while developing. den needs the engine's `GET /lip/entity` (lets ≥ 0.6.0). On an older engine it says so and shows only the persona.

## What you can do

| card | what it shows and what you can do |
|---|---|
| **Persona** | Click his name or tagline to rename him (Enter saves, Esc cancels). Pick one of six colours or the default. *Reset to defaults* asks first. |
| **Traits** | Six sliders: speed, distance, chatty, playful, formality, curiosity. Each has its two ends spelled out (calm ↔ snappy, quiet ↔ talks…) and a tick at the default. |
| **Likes, Dislikes** | Chips with ×, and an input to add one. |
| **Nicknames** | What you call things → what you mean. Edit a value inline, × to forget. |
| **Memory** | Every line he wrote about you, newest first, with its kind and date. Filter by kind, × to forget a line. |
| **Special skills** | The playbooks he taught himself: triggers, confidence, uses, the full text. Thumbs up or down, or forget one. |
| **Secret moves** | Seven dots. The ones you found are lit, and the rest stay a mystery. |
| **Profile** | How you move: pace, clicks per minute, dwell, idle, menu summons / picks / dismisses, sessions, last seen, favourite screen regions. |

How edits work:

- Every edit is instant and marked **pending** until Claude applies it with the `entity` tool and refreshes the den.
- If Claude is not listening right then, den says so, and the edit is applied with your next message in Claude Code.
- **Ctrl+Z** undoes your last edit; Claude gets the inverse and treats it as a no.

The rest of the page:

- **Ask**, or Doto's click menu ("What do you know about me?", "Why this?", "Forget this"), sends a question about the row you are pointing at. Claude answers in the chat panel and highlights what it cites.
- **Send to Claude** hands everything over for a review. The window closes and Claude answers in Claude Code: a short summary of what Doto knows, stale or contradictory lines, and a cleanup list you can say yes to. Say *continue* to bring den back with the live state.
- Keyboard: Tab reaches every row. Delete on a focused × forgets, 1–9 jump to a card, `?` lists the shortcuts, and Esc closes things.

## How Claude drives it

Events (up): `den.persona.set`, `den.persona.reset`, `den.like.add|forget`, `den.dislike.add|forget`, `den.nickname.set|forget`, `den.memory.forget`, `den.skill.forget`, `den.skill.rate`, `den.ask`, `den.export`, `den.snapshot`.
Commands (down): `den.load`, `den.refresh`, `den.highlight`, `den.focus`, `den.snapshot`.

The manifest's `session` block (`export: den.export`, `snapshot: den.snapshot`, `restore: den.load`) lets the engine save and resume a review.

- [GUIDE.md](GUIDE.md) is what Claude reads when it opens den: which `entity` action applies each event, the commands, the etiquette.
- [CONTRACT.md](CONTRACT.md) is the behaviour spec.
- `schemas/` holds JSON Schemas for the entity payload and the main messages.

## Layout

```
unique.json    LIP manifest (name, entry, domains, events, commands, session, permissions)
GUIDE.md       instructions for Claude
CONTRACT.md    behaviour spec
icon.svg
schemas/       entity.json (the GET /lip/entity payload), persona.set, ask, load, highlight; unique.schema.json (vendored)
ui/            index.html, den.js (the home), style.css
scripts/       validate.mjs — manifest + schema check (zero dependencies)
```

The UI imports the engine's SDK at runtime (`/sdk/lets-client.js`, `/sdk/lets-shell.js`). It has no build step and no dependencies, and it stores nothing but two view preferences (collapsed cards, memory filter) in `localStorage`.

## Develop

```bash
# from a lets checkout; the registry looks for <dir>/den/unique.json,
# so point it at the PARENT of a folder named "den" (symlink or junction this repo there)
LETS_UNIQUES_DIRS=/path/to/parent node engine/bin/lets.mjs serve --open den --verbose

node engine/bin/lets.mjs send den.highlight '{"section":"likes","ttl":3000}'   # drive it from the CLI
node engine/bin/lets.mjs events                                                # drain what den emitted
```

Validate with `node scripts/validate.mjs` here, or `node engine/bin/lets.mjs validate <this folder>` from the engine.

## License

MIT © TikoTikTok
