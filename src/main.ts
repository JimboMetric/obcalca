import { Plugin, Notice, MarkdownView, TFile, Editor } from 'obsidian';
import { create, all } from 'mathjs';

const math = create(all, {});

interface VariableMap {
    [name: string]: any;
}

export default class ObCalcaPlugin extends Plugin {
    private globalVariables: VariableMap = {};
    private globalFunctions: VariableMap = {};
    private lastVariables: VariableMap = {};
    private lastFunctions: VariableMap = {};
    private isEvaluating = false;
    private evaluateTimer: number | null = null;
    private resultMarks: any[] = [];
    private variableMarks: any[] = [];

    async onload() {
        await this.loadVariablesFile();

        const style = document.createElement('style');
        style.textContent = `
            .obcalca-variable { color: red; font-weight: bold; }
            .obcalca-result { color: green; font-weight: bold; }
        `;
        document.head.appendChild(style);
        this.register(() => style.remove());

        this.addCommand({
            id: 'evaluate-document',
            name: 'Evaluate Document',
            callback: () => this.evaluateActiveFile()
        });

        this.registerDomEvent(document, 'keyup', (evt: KeyboardEvent) => {
            if (evt.key === '?') {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return;
                const editor = view.editor;
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                if (cursor.ch >= 2 && line.substring(cursor.ch - 2, cursor.ch) === '@?') {
                    this.showVariables();
                }
            }
        });

        this.registerEvent(this.app.workspace.on('editor-change', () => this.scheduleEvaluate()));
    }

    private async loadVariablesFile() {
        const file = this.app.vault.getAbstractFileByPath('variables.md');
        if (file instanceof TFile) {
            const data = await this.app.vault.read(file);
            const lines = data.split(/\r?\n/);
            this.parseDefinitions(lines, this.globalVariables, this.globalFunctions);
        }
    }

    private parseDefinitions(lines: string[], vars: VariableMap, funcs: VariableMap) {
        for (let line of lines) {
            const idx = line.indexOf('=>');
            if (idx !== -1) line = line.slice(0, idx).trim();
            const funcMatch = line.match(/^(\w+)\(([^)]*)\)\s*=\s*(.+)$/);
            if (funcMatch) {
                const [, name, paramsStr, expr] = funcMatch;
                const params = paramsStr.split(',').map(p => p.trim()).filter(p => p.length);
                funcs[name] = (...args: any[]) => {
                    const scope: any = { ...vars };
                    params.forEach((p, i) => scope[p] = args[i]);
                    return this.evaluateExpression(expr, scope, funcs);
                };
                continue;
            }
            const assignMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
            if (assignMatch) {
                const [, name, expr] = assignMatch;
                vars[name] = this.evaluateExpression(expr, vars, funcs);
            }
        }
    }

    private evaluateExpression(expr: string, vars: VariableMap, funcs: VariableMap): any {
        try {
            return math.evaluate(expr, { ...vars, ...funcs });
        } catch (e) {
            return 'Error';
        }
    }

    private parseDocument(text: string): { lines: string[]; vars: VariableMap; funcs: VariableMap; evals: Map<number, string> } {
        const vars: VariableMap = { ...this.globalVariables };
        const funcs: VariableMap = { ...this.globalFunctions };
        const result: string[] = [];
        const evals: Map<number, string> = new Map();
        const lines = text.split(/\r?\n/);

        lines.forEach((line, index) => {
            const evalIndex = line.indexOf('=>');
            let exprPart = line;
            let base = line;
            if (evalIndex !== -1) {
                exprPart = line.slice(0, evalIndex).trimEnd();
                base = line.slice(0, evalIndex + 2).trimEnd();
            }

            const funcMatch = exprPart.match(/^(\w+)\(([^)]*)\)\s*=\s*(.+)$/);
            if (funcMatch) {
                const [, name, paramsStr, expr] = funcMatch;
                const params = paramsStr.split(',').map(p => p.trim()).filter(p => p.length);
                funcs[name] = (...args: any[]) => {
                    const scope: any = { ...vars };
                    params.forEach((p, i) => scope[p] = args[i]);
                    return this.evaluateExpression(expr, scope, funcs);
                };
                result.push(base);
                return;
            }

            const assignMatch = exprPart.match(/^(\w+)\s*=\s*(.+)$/);
            if (assignMatch) {
                const [, name, expr] = assignMatch;
                const value = this.evaluateExpression(expr, vars, funcs);
                vars[name] = value;
                if (evalIndex !== -1) {
                    evals.set(index, String(value));
                }
                result.push(base);
                return;
            }

            if (evalIndex !== -1) {
                const expr = exprPart.trim();
                const value = this.evaluateExpression(expr, vars, funcs);
                evals.set(index, String(value));
                result.push(base);
            } else {
                result.push(base);
            }
        });

        return { lines: result, vars, funcs, evals };
    }

    private clearResultMarks(editor: Editor) {
        this.resultMarks.forEach(m => m.clear());
        this.resultMarks = [];
    }

    private clearVariableMarks(editor: Editor) {
        this.variableMarks.forEach(m => m.clear());
        this.variableMarks = [];
    }

    private showResults(editor: Editor, evals: Map<number, string>) {
        const cm: any = (editor as any).cm;
        if (!cm) return;
        evals.forEach((value, line) => {
            const span = document.createElement('span');
            span.textContent = ` ${value}`;
            span.className = 'obcalca-result';
            const mark = cm.setBookmark({ line, ch: cm.getLine(line).length }, { widget: span });
            this.resultMarks.push(mark);
        });
    }

    private highlightVariables(editor: Editor) {
        const cm: any = (editor as any).cm;
        if (!cm) return;
        const names = [
            ...Object.keys(this.lastVariables),
            ...Object.keys(this.lastFunctions)
        ];
        for (let i = 0; i < editor.lineCount(); i++) {
            const lineText = editor.getLine(i);
            names.forEach(name => {
                const regex = new RegExp(`\\b${name}\\b`, 'g');
                let match: RegExpExecArray | null;
                while ((match = regex.exec(lineText)) !== null) {
                    const mark = cm.markText({ line: i, ch: match.index }, { line: i, ch: match.index + name.length }, {
                        className: 'obcalca-variable'
                    });
                    this.variableMarks.push(mark);
                }
            });
        }
    }

    private async evaluateActiveFile() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const cursor = editor.getCursor();
        const text = editor.getValue();
        const { lines, vars, funcs, evals } = this.parseDocument(text);
        this.lastVariables = vars;
        this.lastFunctions = funcs;
        const currentLines = text.split(/\r?\n/);
        let changed = false;
        this.isEvaluating = true;
        const max = Math.max(currentLines.length, lines.length);
        for (let i = 0; i < max; i++) {
            const curr = currentLines[i] ?? '';
            const next = lines[i] ?? '';
            if (curr !== next) {
                changed = true;
                editor.replaceRange(next, { line: i, ch: 0 }, { line: i, ch: curr.length });
            }
        }
        if (currentLines.length > lines.length) {
            editor.replaceRange('', { line: lines.length, ch: 0 }, { line: currentLines.length, ch: 0 });
            changed = true;
        }
        editor.setCursor(cursor);
        this.clearResultMarks(editor);
        this.clearVariableMarks(editor);
        this.showResults(editor, evals);
        this.highlightVariables(editor);
        this.isEvaluating = false;
        if (changed) {
            // trigger a refresh without showing external edit notice
        }
    }

    private scheduleEvaluate() {
        if (this.isEvaluating) return;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const immediate = line.trimEnd().endsWith('=>');
        if (this.evaluateTimer) window.clearTimeout(this.evaluateTimer);
        this.evaluateTimer = window.setTimeout(() => {
            this.evaluateTimer = null;
            this.evaluateActiveFile();
        }, immediate ? 0 : 300);
    }

    private showVariables() {
        const vars = Object.entries(this.lastVariables).map(([k, v]) => `${k} = ${v}`);
        new Notice(vars.join('\n') || 'No variables defined');
    }

}
