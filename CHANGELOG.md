# Changelog

## 0.1.0 — 2026-10-13

First home. Doto's den shows everything the companion learned about you, and lets you edit or forget any of it by pointing.

- **Nine cards:**
  - persona: rename, tagline, six colours plus the default, *Reset to defaults* with a local confirm;
  - traits: six sliders with their meanings and default ticks;
  - likes and dislikes;
  - nicknames;
  - memory: newest first, kind filter, relative dates;
  - special skills: triggers, confidence, playbook, thumbs, forget;
  - secret moves: found ones lit, the rest a mystery;
  - profile: stat tiles and a regions grid.
- **Optimistic edits.**
  - Every edit shows at once, marked pending until Claude applies it with the `entity` tool and sends `den.refresh` or `den.load`.
  - When Claude is not listening, den shows a "Doto is away" hint at most once per 30 s.
  - A 20-step local undo emits the inverse event.
- **Events:** `den.persona.set|reset`, `den.like.add|forget`, `den.dislike.add|forget`, `den.nickname.set|forget`, `den.memory.forget`, `den.skill.forget|rate`, `den.ask`, `den.export`, `den.snapshot`.
- **Commands:** `den.load` (with `merge`), `den.refresh`, `den.highlight`, `den.focus`, `den.snapshot`.
- **Send to Claude** is a handoff (`session: {export: den.export, snapshot: den.snapshot, restore: den.load}`). A resumed den shows the live state.
- **Doto's menu** offers "What do you know about me?", plus "Why this?" and "Forget this" for the row under the pointer, and "Open chat". The page plays a wink on a forget, a blush on a rename, a nod when Claude confirms, and a sparkle for the seventh secret.
- **Keyboard and layout:** keyboard reachable throughout, with a `?` shortcuts overlay. Checked at 800×600 and at 375 px wide. Needs lets 0.6.0 (`GET /lip/entity`).
