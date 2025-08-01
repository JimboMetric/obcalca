ObCalca is an Obsidian plugin that performs inline calculations anywhere in a
markdown file using `math.js`. Define variables or functions in the current
note or in the global `variables.md` file.

Every line ending with `=>` automatically shows its value right in the editor.
The plugin uses CodeMirror decorations so your notes are not modified.

```
x = 10 => 10
y = x + 5 => 15
z => 15
```

Documents are re-evaluated whenever you edit a line. You can also run
**Evaluate Document** from the command palette to force an update. Typing `@?`
in the editor will display all current variables in a popup.

