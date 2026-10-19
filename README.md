# Studiolo

A studiolo was the small private study of Renaissance palaces, a room kept for focused work. This
plugin gives you one for each day: it turns your daily note into the page where you organize the
day's work or study, laid out in the order a day goes:

- a timer at the top (pomodoro, countdown or stopwatch)
- under Catch up, the tasks you left unfinished on earlier days, oldest first, and the notes you
  left yourself for today (the section only appears when there is something to catch up on)
- under Plan, an optional brainstorm and a To do / Doing / Done board split into categories such as
  Work or Study
- under Notes, notes for today, an end-of-day recap and notes for the next days, each added only
  when you want it

Everything is stored as ordinary Markdown in the note itself, so it works with git, Syncthing,
Obsidian Sync and any script that can append a line to a file.

## Install

Until the plugin is in the Community directory, install it by hand:

1. In your vault, open the hidden `.obsidian/plugins/` folder (create `plugins` if it isn't there).
2. Create a `studiolo` folder inside it and copy `main.js`, `manifest.json` and `styles.css` into it.
3. In Obsidian, go to Settings > Community plugins, turn off Restricted mode if needed, click the
   refresh icon next to "Installed plugins" and enable Studiolo.

Today's page opens right away, in a folder called `Journal`.

If your `.obsidian` folder syncs to your phone, the plugin files arrive there too. You still have to
enable it in the phone's settings.

You don't need the core Daily notes plugin. If it's set to open the daily note on startup, turn that
off so the two don't fight over which page opens.

## Moving between days

Obsidian opens today's page at startup and creates it if it doesn't exist yet. The calendar icon in
the ribbon and the "Open today" command also take you there. At the top of each page you can step to
the previous or next page; days without a page are skipped.

If Obsidian is still open at midnight, the new page is created for you. Older pages show a banner
with a link back to today.

## The task board

On a new page, pick a category to start (or "Other..." for a new one). Only the categories you use
that day are shown. Each lane has its own color; change them under Settings > Studiolo > Board.
On a phone, or when the note is in a narrow pane, the three lanes stack on top of each other.

Type in "Add a task" and press Enter to add a card. The box keeps focus, so you can add several in a
row. Drag cards between lanes, positions and categories, or tick the checkbox to mark one done. Drag
and drop doesn't exist on phones, so every move is also in the card's menu (the "..." button, or
right-click on desktop). The menu can also edit, archive and delete a card, and the category menu
can rename it, archive its done tasks, or remove it when it's empty.

Links and tags work inside cards: `Read [[Paper X]] #reading`.

## Catch up: unfinished tasks

Any task still in To do or Doing on an earlier page shows up under Catch up, grouped by category. The badge is
its age in days: yellow for 1 day, orange for 2 or 3, red for 4 to 6, solid red after a week.

- Move to today puts it on today's board. It keeps its original date, written as
  `(since 2026-10-14)`, so its age keeps counting until you finish it.
- Done means you did finish it that day and forgot to tick it.
- Archive drops it. It stays in the old page, marked as archived.

"Move all to today" moves every task in the list.

## Catch up: notes from earlier days

Anything you write as a bullet under "Notes for next days" shows up on every later page until you
deal with it, even if you skip a few days. You can add it to today's "Notes for today", turn it into
a task (you pick the category), or dismiss it. Handled notes are ticked (`- [x]`) in the old page.
Nothing is deleted.

## Notes

A new page starts without any note sections; you add the ones you need.

At the top of Plan, "Brainstorm first" adds a brainstorm right there, above the task board, for
thinking through the day before deciding what to do. Under Notes you can add:

- Notes for today
- End of day, for what you got done and what you learned
- Notes for next days, whose bullets show up on the following pages
- Other..., a note with a title of your choice

Each one is an Obsidian callout, so it's ordinary Markdown: links, tags and search work inside it,
and you edit it in place. The cursor jumps into the new section when you add it.

The X in a section's title removes it, along with everything written in it, and its button comes
back. If the section has any text, you're asked to confirm first.

## Timer

- Pomodoro: 25 minutes of focus, then a 5 minute break, with a 15 minute break after every fourth
  session. All of these can be changed in settings.
- Timer: any number of minutes, or one of the presets. Pressing Enter in the minutes box starts it.
- Stopwatch: counts up.

The buttons next to the time are, from left to right: start or pause, restart the current phase,
skip to the next phase, and restart the whole cycle (back to the first 25 minute focus session,
even from a break). Hover over one to see its name.

There is one timer for the whole vault. It keeps going when you switch pages and survives a restart.
While it runs, it also shows in the status bar on desktop, where a click pauses or resumes it. When
it ends you get a notice, a beep and a system notification; each can be turned off.

The commands "Start / pause timer", "Reset timer" and "Restart pomodoro cycle" are worth binding to
hotkeys.

## Settings

| Setting                                  | Default                         |
| ---------------------------------------- | ------------------------------- |
| Journal folder                           | `Journal`                       |
| Custom template                          | none, uses the built-in page    |
| Open today on startup                    | on                              |
| Create the page automatically every day  | on                              |
| Categories                               | Work, Study, Personal           |
| To do, Doing, Done colors                | the theme's blue, orange, green |
| Focus, short break, long break (minutes) | 25, 5, 15                       |
| Long break after this many sessions      | 4                               |
| Start the next phase automatically       | off                             |
| Sound, system notification               | on, on                          |

To use your own template, create a note, put its path in settings, and use `{{date}}` and
`{{title}}` where you want the date. Keep the code blocks (`studiolo-nav`, `studiolo-timer`,
`studiolo-catchup`, `studiolo-board` and `studiolo-notes`). A freshly created page is a good
starting point.

## How it's stored

A daily page is a file like `Journal/2026-10-19.md`. The board is the content of its code block:

````markdown
```studiolo-board
## Work
- [ ] Fix login bug
- [/] Write report
- [x] Standup
- [-] Something archived

## Study
- [ ] Chapter 3 (since 2026-10-16)
```
````

`[ ]` is to do, `[/]` doing, `[x]` done, `[-]` archived and `[>]` moved to a later day. You can edit
the block by hand in Source mode, and other tools can write to it. A Telegram bot could add
`- [ ] task` under `## Work`, for example. Other lines you write inside the block are kept.

Note sections are callouts:

```markdown
> [!studiolo-next] Notes for next days
> - Ask about the deadline
```

A plain `## Notes for next days` heading works too, if your template uses headings instead.

## Tips

- If two devices both create today's page before they sync, Syncthing keeps both as a
  `.sync-conflict` copy. To avoid that, turn off automatic page creation on your phone and only open
  today's page there once it has synced.
- With git, add `.obsidian/workspace*.json` to `.gitignore`. Daily pages diff well, since each task
  is one line.
- Pages are ordinary notes, so search, backlinks, graph view and Dataview all work on them.
