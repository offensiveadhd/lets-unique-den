# lets-unique-template — "pulse"

A minimal but complete **unique** for [lets](https://github.com/TikoTikTok/lets):
a full-screen dark-violet mood dial. The human drags a ring to set a value
0–100 and picks one of three mode chips (calm / focused / wild); the companion
entity reacts and Claude can move the dial itself. It demonstrates the entire
unique contract — manifest, guide, static UI, LIP events and commands — in a
handful of files you can rename and build on.

Use it as a GitHub **template repo**: "Use this template" → name it
`lets-unique-<name>` → clone → rename `pulse` everywhere (manifest `name`,
`domains`, event/command types, `data-unique`, `Lets.connect`) → build.

## Local development

Uniques are served by the lets host, never opened from disk. Place this
folder (copy or symlink) where the host looks for uniques:

- project-local: `<project>/.lets/uniques/pulse`
- or global: `~/.lets/uniques/pulse`

then run the host standalone from the lets repo checkout:

    node C:/Users/tiko/proj/lets/lets/engine/bin/lets.mjs serve --open pulse

It starts the loopback server, serves the SDK at `/sdk/…`, your folder at
`/u/pulse/…`, and opens the window. Console errors = something is wrong; the
quality bar is zero console errors in Chromium/Edge.

## File layout — what every file is for

    unique.json        the manifest: name, version, entry, domains, events,
                       commands, permissions. Schema-validated by the host
                       BEFORE the unique is served. This is the contract.
    GUIDE.md           prose for Claude: what each event means and how to
                       react, what commands exist, etiquette. The `open` tool
                       returns it. Keep it under ~1,200 words.
    icon.svg           64×64 violet ring shown in listings.
    ui/index.html     the entry page; <body data-unique="pulse">.
    ui/app.js         the unique logic: ring drag, chips, LIP wiring.
    ui/style.css      deep-violet theme; re-declares the --lets-* variables
                      so it survives a missing shell CSS.
    LICENSE           MIT.

## How the UI talks LIP

Every unique does exactly this (see `ui/app.js`):

    import { Lets } from '/sdk/lets-client.js';
    import { Shell } from '/sdk/lets-shell.js';

    const lets  = Lets.connect({ unique: 'pulse', version: '0.1.0',
                                 caps: ['entity', 'chat', 'components'] });
    const shell = Shell.mount(lets, {
      root: document.body,
      context: () => ({ value, mode }),            // what the entity knows
      quickSuggestions: (ctx) => [{ id: 'explain', label: 'What does this value mean?' }],
    });

Checklist your UI must satisfy:

- `<body data-unique="<name>">` in the entry HTML.
- Everything is a static ES module; no build step, no CDN, no bundler.
- Emit events with `lets.emit('<domain>.<thing>', data)` — types must start
  with a domain you declared in the manifest.
- Handle your own commands with `lets.on('<domain>.<cmd>', (data, msg) => …)`.
- Leave `entity.*`, `chat.*`, `component.*`, `ui.*` to the shell — it wires
  them itself; never re-implement them.
- Declare permissions (`fs.write`, `net`) honestly in the manifest; the host
  enforces them and shows them to the user.

## Publishing

1. Push your repo to GitHub (public, or a URL the user can clone).
2. Validate locally:

       node <lets>/engine/bin/lets.mjs validate <this-folder>

3. Open a PR against the `lets-store` repo adding an entry to its
   `index.json`:

       { "name": "pulse", "title": "Pulse — a dial you talk through",
         "description": "…", "repo": "https://github.com/you/lets-unique-pulse.git",
         "ref": "main", "sha": "<commit>", "tags": ["mood", "dial"], "author": "you" }

   Follow that repo's CONTRIBUTING.md checklist. A maintainer reviews the
   manifest and marks the entry verified.

## The rules

- Static only: the host serves files, it never executes your code.
- Domains must be yours: `pulse.*` here; never reserved domains
  (`lip`, `session`, `entity`, `chat`, `component`, `media`, `ui`).
- Keep `GUIDE.md` short (under ~1,200 words); it is read on every window open.
- Declare permissions even when empty — `"fs.write": []` means "writes nothing".
- Bump `version` in the manifest whenever you change events/commands.
- Want "Send to Claude" semantics (the engine saves the window's state, closes
  it, and can bring it back with `/lets <name> resume`)? Declare
  `"session": {"export": "<name>.export", "snapshot": "<name>.snapshot", "restore": "<name>.load"}`
  in the manifest and make your UI emit the export event and handle the
  restore command. Without the block the engine assumes exactly those names.

## License

MIT — see `LICENSE`.
