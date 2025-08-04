import { Plugin, Notice, MarkdownView, TFile } from 'obsidian';
import { create, all } from 'mathjs';

const math = create(all, {});

interface VariableMap {
    [name: string]: any;
}

export default class ObCalcaPlugin extends Plugin {
    private globalVariables: VariableMap = {};
    private globalFunctions: VariableMap = {};
    private lastVariables: VariableMap = {};
    private isEvaluating = false;
    private evaluateTimer: number | null = null;

    async onload() {
        await this.loadVariablesFile();

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

    private parseDocument(text: string): { lines: string[]; vars: VariableMap } {
        const vars: VariableMap = { ...this.globalVariables };
        const funcs: VariableMap = { ...this.globalFunctions };
        const result: string[] = [];
        const lines = text.split(/\r?\n/);

        for (let line of lines) {
            const evalIndex = line.indexOf('=>');
            let base = line;
            if (evalIndex !== -1) base = line.slice(0, evalIndex).trimEnd();

            const funcMatch = base.match(/^(\w+)\(([^)]*)\)\s*=\s*(.+)$/);
            if (funcMatch) {
                const [, name, paramsStr, expr] = funcMatch;
                const params = paramsStr.split(',').map(p => p.trim()).filter(p => p.length);
                funcs[name] = (...args: any[]) => {
                    const scope: any = { ...vars };
                    params.forEach((p, i) => scope[p] = args[i]);
                    return this.evaluateExpression(expr, scope, funcs);
                };
                result.push(base);
                continue;
            }

            const assignMatch = base.match(/^(\w+)\s*=\s*(.+)$/);
            if (assignMatch) {
                const [, name, expr] = assignMatch;
                const value = this.evaluateExpression(expr, vars, funcs);
                vars[name] = value;
                if (evalIndex !== -1) {
                    result.push(`${base} => ${value}`);
                } else {
                    result.push(base);
                }
                continue;
            }

            if (evalIndex !== -1) {
                const expr = base.trim();
                const value = this.evaluateExpression(expr, vars, funcs);
                result.push(`${expr} => ${value}`);
            } else {
                result.push(base);
            }
        }

        return { lines: result, vars };
    }

    private async evaluateActiveFile() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const cursor = editor.getCursor();
        const text = editor.getValue();
        const { lines, vars } = this.parseDocument(text);
        this.lastVariables = vars;
        const newText = lines.join('\n');
        if (newText === text) return;
        this.isEvaluating = true;
        editor.setValue(newText);
        editor.setCursor(cursor);
        this.isEvaluating = false;
    }

    private scheduleEvaluate() {
        if (this.isEvaluating) return;
        if (this.evaluateTimer) window.clearTimeout(this.evaluateTimer);
        this.evaluateTimer = window.setTimeout(() => {
            this.evaluateTimer = null;
            this.evaluateActiveFile();
        }, 300);
    }

    private showVariables() {
        const vars = Object.entries(this.lastVariables).map(([k, v]) => `${k} = ${v}`);
        new Notice(vars.join('\n') || 'No variables defined');
    }

}
