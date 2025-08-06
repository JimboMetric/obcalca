ObCalca is an Obsidian plugin that performs inline calculations anywhere in a
markdown file using `math.js`. Define variables or functions in the current
note or in the global `variables.md` file. Each line ending with `=>`
automatically displays its value as you edit. Lines ending with `=+>` show the
sum of all numeric results since the previous `=+>` token. Results appear in
green after the arrow and are not saved to the document, so they remain read-only.

```
x = 10 => 10
y = x + 5 => 15
=+> 25
```
Documents are re-evaluated automatically whenever a line changes. You can also
run **Evaluate Document** from the command palette to force an update.
Typing `@?` in the editor will display all current variables in a popup.
