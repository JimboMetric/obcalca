ObCalca is an Obsidian plugin that performs inline calculations anywhere in a
markdown file using `math.js`. Define variables or functions in the current
note or in the global `variables.md` file. Use `=>` after an assignment or
variable name to show its value.

x = 10 => 10
y = x + 5 => 15
z => 15
```
Run **Evaluate Document** from the command palette to update all evaluations.
Evaluations also run automatically when you type the `=>` token at the end of a line.
Typing `@?` in the editor will display all current variables in a popup.
