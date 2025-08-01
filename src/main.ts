import { Plugin, Notice, MarkdownView, TFile } from 'obsidian';
import { create, all } from 'mathjs';
import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';

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
    private evalEffect = StateEffect.define<DecorationSet>();
    private evalField = StateField.define<DecorationSet>({
        create: () => Decoration.none,
        update: (deco, tr) => {
            for (const e of tr.effects) {
                if (e.is(this.evalEffect)) deco = e.value;
            }
            return deco.map(tr.changes);
        },
        provide: f => EditorView.decorations.from(f)
    });
    private evalExtension = [this.evalField];

    async onload() {
        await this.loadVariablesFile();

        this.registerEditorExtension(this.evalExtension);

        this.addCommand({
            id: 'evaluate-document',
            name: 'Evaluate Document',
            callback: () => this.evaluateActiveFile(true)
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

    private parseDocument(text: string): { results: Map<number, string>; vars: VariableMap } {
        const vars: VariableMap = { ...this.globalVariables };
        const funcs: VariableMap = { ...this.globalFunctions };
        const results = new Map<number, string>();
        const lines = text.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
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
                // function definitions are ignored for output
                continue;
            }

            const assignMatch = base.match(/^(\w+)\s*=\s*(.+)$/);
            if (assignMatch) {
                const [, name, expr] = assignMatch;
                const value = this.evaluateExpression(expr, vars, funcs);
                vars[name] = value;
                if (evalIndex !== -1) {
                    results.set(i, String(value));
                }
                continue;
            }

            if (evalIndex !== -1) {
                const expr = base.trim();
                const value = this.evaluateExpression(expr, vars, funcs);
                results.set(i, String(value));
            }
            // plain text lines have no results
        }

        return { results, vars };
    }

    private async evaluateActiveFile(showNotice: boolean = false) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !(view.file instanceof TFile)) return;
        const file = view.file;
        const text = await this.app.vault.read(file);
        const { results, vars } = this.parseDocument(text);
        this.lastVariables = vars;
        this.updateDecorations(view, results);
        if (showNotice) new Notice('Document evaluated');
    }

    private updateDecorations(view: MarkdownView, results: Map<number, string>) {
        const editor = view.editor as any;
        const cm: EditorView | undefined = editor.cm;
        if (!cm) return;
        const widgets: any[] = [];
        results.forEach((value, line) => {
            const lineObj = cm.state.doc.line(line + 1);
            const text = lineObj.text;
            const idx = text.indexOf('=>');
            const pos = idx === -1 ? lineObj.to : lineObj.from + idx + 2;
            widgets.push(Decoration.widget({
                widget: new EvalWidget(value),
                side: 1
            }).range(pos));
        });
        const deco = Decoration.set(widgets, true);
        cm.dispatch({ effects: this.evalEffect.of(deco) });
    }

    private scheduleEvaluate() {
        if (this.isEvaluating) return;
        if (this.evaluateTimer) window.clearTimeout(this.evaluateTimer);
        this.evaluateTimer = window.setTimeout(() => {
            this.evaluateTimer = null;
            this.evaluateActiveFile(false);
        }, 300);
    }

    private showVariables() {
        const vars = Object.entries(this.lastVariables).map(([k, v]) => `${k} = ${v}`);
        new Notice(vars.join('\n') || 'No variables defined');
    }

}

class EvalWidget extends WidgetType {
    constructor(private value: string) { super(); }
    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'obcalca-result';
        span.textContent = ` ${this.value}`;
        return span;
    }
}
