ObCalca is an Obsidian plugin that performs inline calculations anywhere in a
markdown file using `math.js`. Define variables or functions in the current
note or in the global `variables.md` file. Each line ending with `=>`
automatically displays its value as you edit.

x = 10 => 10
y = x + 5 => 15
z => 15
```
Documents are re-evaluated automatically whenever a line changes. You can also
run **Evaluate Document** from the command palette to force an update.
Typing `@?` in the editor will display all current variables in a popup.
