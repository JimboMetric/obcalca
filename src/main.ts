import { Plugin, Notice, MarkdownView, TFile, Editor } from 'obsidian';
import { create, all } from 'mathjs';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType, hoverTooltip, Tooltip } from "@codemirror/view";
import { StateField, StateEffect, Range } from "@codemirror/state";

// Initialize mathjs instance
const math = create(all, {});

// All type definitions and state management remain the same
type VariableMap = Record<string, any>;
type EvaluationMap = Map<number, string>;
interface CalcState {
	evals: EvaluationMap;
	variables: VariableMap;
	functions: VariableMap;
}

// ResultWidget is correct and does not need changes
class ResultWidget extends WidgetType {
	constructor(readonly value: string) { super(); }
	toDOM(): HTMLElement {
		const container = createSpan({ text: ' ' });
		const currencyMatch = this.value.match(/^(\$)(.*)/s);
		const standardMatch = this.value.match(/^(-?[\d.]+)\s*(.*)$/s);

		if (currencyMatch) {
			const [, symbol, number] = currencyMatch;
			container.createSpan({ text: symbol, cls: 'obcalca-unit' });
			container.createSpan({ text: number, cls: 'obcalca-result' });
		} else if (standardMatch) {
			const [, numberPart, unitPart] = standardMatch;
			container.createSpan({ text: numberPart, cls: 'obcalca-result' });
			if (unitPart.trim()) {
				container.createSpan({ text: ` ${unitPart.trim()}`, cls: 'obcalca-unit' });
			}
		} else {
			container.createSpan({ text: this.value, cls: 'obcalca-result' });
		}
		return container;
	}
}


const setCalculations = StateEffect.define<CalcState>();

const calculationState = StateField.define<CalcState>({
	create: () => ({ evals: new Map(), variables: {}, functions: {} }),
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setCalculations)) { return effect.value; }
		}
		return value;
	},
});


// === Main Plugin Class ===
export default class ObCalcaPlugin extends Plugin {
	private globalVariables: VariableMap = {};
	private globalFunctions: VariableMap = {};
	private isEvaluating = false;
	private evaluateTimer: number | null = null;
	private knownUnits: Set<string> = new Set();
	private readonly CURRENCY_UNIT_NAME = 'OBCURRENCY';

	async onload() {
		(math as any).createUnit(this.CURRENCY_UNIT_NAME, { definition: '1' });
		this.knownUnits = new Set(Object.keys((math as any).Unit.UNITS));
		this.knownUnits.add('$');
		
		await this.loadVariablesFile();
		this.registerCommands();
		this.registerEvents();
		this.registerEditorExtension([
			calculationState,
			this.buildViewPlugin(this.knownUnits),
			this.buildTooltipExtension()
		]);

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file.path === 'variables.md') {
				this.loadVariablesFile().then(() => this.evaluateActiveFile());
			}
		}));
	}

    private registerCommands() {
		this.addCommand({
			id: 'evaluate-document',
			name: 'Evaluate Document',
			callback: () => this.evaluateActiveFile()
		});
	}

	private registerEvents() {
		this.registerDomEvent(document, 'keyup', (evt: KeyboardEvent) => {
			if (evt.key === '?') {
				const editor = this.getActiveEditor();
				if (!editor) return;
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				if (cursor.ch >= 2 && line.substring(cursor.ch - 2, cursor.ch) === '=>') {
					this.showVariables();
				}
			}
		});

		this.registerEvent(this.app.workspace.on('editor-change', () => this.scheduleEvaluate()));
	}
	
	private formatResult(value: any, precision: number | null): string {
		const p = precision ?? 2;
	
		if (value && value.isUnit) {
			const defaultFormatted = math.format(value, { notation: 'fixed', precision: p });
			const currencyRegex = new RegExp(`\\b${this.CURRENCY_UNIT_NAME}\\b`, 'g');
			return defaultFormatted.replace(currencyRegex, '$');
		}
	
		if (typeof value === 'number') {
			if (p < 0) {
				const factor = Math.pow(10, -p);
				return String(Math.round(value / factor) * factor);
			}
			return math.format(value, { notation: 'fixed', precision: p });
		}
	
		return String(value);
	}

	private preProcessExpression(expr: string): string {
		return expr.replace(/\$(\d+\.?\d*)/g, `unit($1, "${this.CURRENCY_UNIT_NAME}")`);
	}

	private async loadVariablesFile() {
		this.globalVariables = {};
		this.globalFunctions = {};
		const file = this.app.vault.getAbstractFileByPath('variables.md');
		if (file instanceof TFile) {
			const data = await this.app.vault.read(file);
			this.parseDefinitions(data.split(/\r?\n/), this.globalVariables, this.globalFunctions);
		}
	}

	private parseDefinitions(lines: string[], vars: VariableMap, funcs: VariableMap) {
		const scope = { vars, funcs };
		let currentPrecision: number | null = null;
		for (const line of lines) {
			const { cleanLine, newPrecision } = this.processLineForPrecision(line);
			if (newPrecision !== null) {
				currentPrecision = newPrecision;
			}
			this._parseDefinitionLine(cleanLine, scope, currentPrecision);
		}
	}
	
	private processLineForPrecision(line: string): { cleanLine: string, newPrecision: number | null } {
		const precisionRegex = /@p=(-?\d+)/;
		const match = line.match(precisionRegex);
		if (match && match[1]) {
			const newPrecision = parseInt(match[1], 10);
			const cleanLine = line.replace(precisionRegex, '').trim();
			return { cleanLine, newPrecision };
		}
		return { cleanLine: line, newPrecision: null };
	}
	
	private _parseDefinitionLine(line: string, scope: { vars: VariableMap, funcs: VariableMap }, precision: number | null) {
		let cleanLine = line;
		const idx = cleanLine.indexOf('=>');
		if (idx !== -1) {
			cleanLine = cleanLine.slice(0, idx).trim();
		}

		const funcMatch = cleanLine.match(/^(\w+)\(([^)]*)\)\s*=\s*(.+)$/);
		if (funcMatch) {
			const [, name, paramsStr, expr] = funcMatch;
			const params = paramsStr.split(',').map(p => p.trim()).filter(Boolean);
			scope.funcs[name] = (...args: any[]) => {
				const localScope = { ...scope.vars };
				params.forEach((p, i) => localScope[p] = args[i]);
				return this.evaluateExpression(expr, localScope, scope.funcs);
			};
			return;
		}

		const assignMatch = cleanLine.match(/^(\w+)\s*=\s*(.+)$/);
		if (assignMatch) {
			const [, name, expr] = assignMatch;
			try {
                scope.vars[name] = this.evaluateExpression(expr, scope.vars, scope.funcs);
            } catch (e: unknown) { /* ignore */ }
		}
	}

	private evaluateExpression(expr: string, vars: VariableMap, funcs: VariableMap): any {
		try {
			const processedExpr = this.preProcessExpression(expr);
			const fullScope = { ...vars, ...funcs };
	
			const node = math.parse(processedExpr);
			let involvesCurrency = false;
	
			node.traverse((node: any, path: any, parent: any) => {
				if (node.isSymbolNode) {
					const variableName = node.name;
					if (fullScope[variableName]) {
						const variableValue = fullScope[variableName];
						if (variableValue && variableValue.isUnit && variableValue.hasBase(this.CURRENCY_UNIT_NAME)) {
							involvesCurrency = true;
						}
					}
				}
				if(node.isUnit && node.units.length > 0 && node.units[0].unit.name === this.CURRENCY_UNIT_NAME) {
					involvesCurrency = true;
				}
			});
	
			const result = node.evaluate(fullScope);
	
			if (involvesCurrency && typeof result === 'number') {
				return math.unit(result, this.CURRENCY_UNIT_NAME);
			}
	
			return result;
			
		} catch (e: unknown) {
			if (e instanceof Error) {
				if (e.message.startsWith('Unit') && e.message.includes('not found')) {
					return 'Unknown unit';
				}
				return e.message;
			}
			return 'Error';
		}
	}

	// --- MODIFIED: parseDocument now detects and collects global assignments ---
	private parseDocument(text: string) {
		const vars: VariableMap = { ...this.globalVariables };
		const funcs: VariableMap = { ...this.globalFunctions };
		const lines = text.split(/\r?\n/);
		const evals: EvaluationMap = new Map();
		const scope = { vars, funcs };

		let currentPrecision: number | null = null;
		let sumBuffer: (number | any)[] = []; 
		const globalUpdates = new Map<string, any>(); // Collect variables to update
        let runningSum = 0;

		lines.forEach((line, index) => {
			const lineNo = index + 1;
			
			const { cleanLine, newPrecision } = this.processLineForPrecision(line);
			if (newPrecision !== null) {
				currentPrecision = newPrecision;
			}
			
			const globalAssignRegex = /^\s*!(\w+)\s*=\s*(.+)/;
			const globalMatch = cleanLine.match(globalAssignRegex);
			const sumOpRegex = /^\s*(\w+)\s*\+=>\s*$/;
			const sumMatch = cleanLine.match(sumOpRegex);

			if (globalMatch) {
				const [, varName, expr] = globalMatch;
				const value = this.evaluateExpression(expr, vars, funcs);
				// Also update the variable in the current scope for immediate feedback
				vars[varName] = value;
				globalUpdates.set(varName, value);

			} else if (sumMatch) {
				const varName = sumMatch[1];
				const total = sumBuffer.length > 0 ? math.sum(...sumBuffer) : 0;
				vars[varName] = total;
				evals.set(lineNo, this.formatResult(total, currentPrecision));
				sumBuffer = [];

			} else {
				this._parseDefinitionLine(cleanLine, scope, currentPrecision);
				const evalIndex = cleanLine.indexOf('=>');

				if (evalIndex !== -1) {
					const exprPart = cleanLine.slice(0, evalIndex).trimEnd();
					const rawValue = this.evaluateExpression(exprPart.trim(), vars, funcs);

					if (typeof rawValue === 'number' || (rawValue && rawValue.isUnit)) {
						sumBuffer.push(rawValue);
					}
					evals.set(lineNo, this.formatResult(rawValue, currentPrecision));
				}
			}
		});
		return { vars, funcs, evals, globalUpdates };
	}

	// --- NEW: A dedicated function to handle reading, modifying, and writing variables.md ---
	private async updateGlobalVariableFile(varName: string, value: any) {
		const filePath = 'variables.md';
		const file = this.app.vault.getAbstractFileByPath(filePath);
		const newDef = `${varName} = ${String(value)}`;

		// Case 1: The file doesn't exist yet.
		if (!file || !(file instanceof TFile)) {
			await this.app.vault.create(filePath, newDef + '\n');
			return;
		}

		// Case 2: The file exists.
		const content = await this.app.vault.read(file);
		const lines = content.split(/\r?\n/);
		const varRegex = new RegExp(`^\\s*${varName}\\s*=\\s*.*`);
		let found = false;

		for (let i = 0; i < lines.length; i++) {
			if (varRegex.test(lines[i])) {
				lines[i] = newDef; // Update the existing line
				found = true;
				break;
			}
		}

		if (!found) {
			lines.push(newDef); // Add the new variable if it wasn't found
		}

		await this.app.vault.modify(file, lines.join('\n'));
	}

	private getActiveEditor(): Editor | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
	}

	// --- MODIFIED: evaluateActiveFile now orchestrates the file updates ---
	private async evaluateActiveFile() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.editor) return;

		this.isEvaluating = true;
		const editor = view.editor;
		const text = editor.getValue();
		// Get the global updates from the parsing step
		const { vars, funcs, evals, globalUpdates } = this.parseDocument(text);

		// If there are updates, write them to the file and reload state
		if (globalUpdates.size > 0) {
			for (const [name, value] of globalUpdates.entries()) {
				await this.updateGlobalVariableFile(name, value);
			}
			// Reload the global state so it's immediately available
			await this.loadVariablesFile();
		}

		const cm = (editor as any).cm as EditorView;
		cm.dispatch({
			effects: setCalculations.of({
				evals,
				// Use the locally parsed vars for immediate visual feedback
				variables: vars, 
				functions: funcs
			})
		});
		
		this.isEvaluating = false;
	}

	private scheduleEvaluate() {
		if (this.isEvaluating) return;

		if (this.evaluateTimer) clearTimeout(this.evaluateTimer);
		this.evaluateTimer = window.setTimeout(() => {
			this.evaluateTimer = null;
			this.evaluateActiveFile();
		}, 300);
	}

	private showVariables() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		
		const cm = (view.editor as any).cm as EditorView;
		const state = cm.state.field(calculationState);
		
		const varEntries = Object.entries(state.variables).map(([key, value]) => `${key} = ${this.formatResult(value, null)}`);
		const funcEntries = Object.keys(state.functions).map((key: string) => `${key}(...)`);

		const textToShow = [...varEntries, ...funcEntries].join('\n');
		new Notice(textToShow || 'No variables or functions defined in this note.', 10000);
	}
	
	// --- MODIFIED: ViewPlugin now styles the `!` in global assignments ---
	private buildViewPlugin(knownUnits: Set<string>): ViewPlugin<any> {
		return ViewPlugin.fromClass(class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.buildDecorations(view, knownUnits);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged || update.state.field(calculationState) !== update.startState.field(calculationState)) {
					this.decorations = this.buildDecorations(update.view, knownUnits);
				}
			}

			buildDecorations(view: EditorView, knownUnits: Set<string>): DecorationSet {
				const builder: Range<Decoration>[] = [];
				const state = view.state.field(calculationState);
				const functionNames = new Set(Object.keys(state.functions));
				const variableNames = new Set(Object.keys(state.variables));

				const mathjsKeywords = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sqrt', 'log', 'log10', 'exp', 'pow', 'abs', 'round', 'ceil', 'floor', 'mod', 'det', 'inv', 'cross', 'dot', 'to', 'in', 'and', 'or', 'not', 'xor'];
				
				const fullOperatorRegex = new RegExp(`(@p=-?\\d+)|\\b(${mathjsKeywords.join('|')})\\b|[\\+\\-\\*\\/\\^%=\\(\\)\\[\\],:!]`, 'g');
				const identifierRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
				const currencyRegex = /\$/g;
				const sumOpRegex = /\s*\+=>\s*/g;
				const globalAssignRegex = /^\s*!/gm; // Regex to find the '!' at the start of a line

				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to; ) {
						const line = view.state.doc.lineAt(pos);
						
						if (state.evals.has(line.number)) {
							const value = state.evals.get(line.number)!;
							builder.push(Decoration.widget({ widget: new ResultWidget(value), side: 1 }).range(line.to));
						}

						const lineText = line.text;
						let match;
						
						const styledRanges: {from: number, to: number}[] = [];

						// Style the '!' in global assignments
						while ((match = globalAssignRegex.exec(lineText)) !== null) {
							const start = line.from + match.index;
							const end = start + 1; // Just the '!' character
							builder.push(Decoration.mark({ class: 'obcalca-operator' }).range(start, end));
							styledRanges.push({from: start, to: end});
						}

						while ((match = currencyRegex.exec(lineText)) !== null) {
							const start = line.from + match.index;
							const end = start + match[0].length;
							builder.push(Decoration.mark({ class: 'obcalca-unit' }).range(start, end));
							styledRanges.push({from: start, to: end});
						}
						
						while ((match = sumOpRegex.exec(lineText)) !== null) {
							const start = line.from + match.index;
							const end = start + match[0].length;
							builder.push(Decoration.mark({ class: 'obcalca-operator' }).range(start, end));
							styledRanges.push({from: start, to: end});
						}

						while ((match = fullOperatorRegex.exec(lineText)) !== null) {
							const start = line.from + match.index;
							const end = start + match[0].length;
							if (styledRanges.some(r => start < r.to && end > r.from)) continue;
							builder.push(Decoration.mark({ class: 'obcalca-operator' }).range(start, end));
							styledRanges.push({from: start, to: end});
						}

						while ((match = identifierRegex.exec(lineText)) !== null) {
							const name = match[0];
							const start = line.from + match.index;
							const end = start + name.length;
							
							if (styledRanges.some(r => start < r.to && end > r.from)) continue;
							
							let decoClass = '';
							if (functionNames.has(name)) {
								decoClass = 'obcalca-function';
							} else if (variableNames.has(name)) {
								decoClass = 'obcalca-variable';
							} else if (knownUnits.has(name)) {
								decoClass = 'obcalca-unit';
							}
							
							if (decoClass) {
								builder.push(Decoration.mark({ class: decoClass }).range(start, end));
							}
						}
						
						pos = line.to + 1;
					}
				}
        

				return Decoration.set(builder, true);
			}
		}, {
            decorations: v => v.decorations
        });
	}

	private buildTooltipExtension() {
		return hoverTooltip((view, pos, side): Tooltip | null => {
			const state = view.state.field(calculationState);
			const range = view.state.wordAt(pos);
	
			if (!range) { return null; }
	
			const variableName = view.state.doc.sliceString(range.from, range.to);
	
			if (variableName in state.variables) {
				const value = state.variables[variableName];
				return {
					pos: range.from,
					end: range.to,
					above: true,
					create: () => {
						const dom = document.createElement("div");
						dom.className = "cm-tooltip-obcalca";
						dom.textContent = `${variableName} = ${this.formatResult(value, null)}`;
						return { dom };
					},
				};
			}
			return null;
		});
	}
}