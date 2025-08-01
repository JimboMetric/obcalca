import { App, Plugin, PluginManifest, PluginSettingTab, Setting, Notice, MarkdownPostProcessorContext, TFile } from 'obsidian';
import { create, all } from 'mathjs';

const math = create(all, {});

interface VariableMap {
  [name: string]: any;
}

export default class ObCalcaPlugin extends Plugin {
  private variables: VariableMap = {};
  private functions: VariableMap = {};

  async onload() {
    await this.loadVariablesFile();

    this.registerMarkdownPostProcessor((el, ctx) => this.processCode(el, ctx));

    this.registerDomEvent(document, 'keyup', (evt: KeyboardEvent) => {
      if (evt.key === '?' && evt.shiftKey && (evt.ctrlKey || evt.metaKey)) {
        this.showVariables();
      }
    });
  }

  onunload() {
    // Nothing special
  }

  private async loadVariablesFile() {
    const file = this.app.vault.getAbstractFileByPath('variables.md');
    if (file instanceof TFile) {
      const data = await this.app.vault.read(file);
      this.parseLines(data.split(/\r?\n/));
    }
  }

  private processCode(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const lines = el.innerText.split(/\r?\n/);
    const processed = this.parseLines(lines);
    el.innerHTML = processed.join('\n');
  }

  private parseLines(lines: string[]): string[] {
    const result: string[] = [];

    for (let line of lines) {
      const evalIndex = line.indexOf('=>');
      if (evalIndex !== -1) {
        line = line.substring(0, evalIndex).trim();
      }

      const assignMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (assignMatch) {
        const name = assignMatch[1];
        const expr = assignMatch[2];
        try {
          const value = math.evaluate(expr, { ...this.variables, ...this.functions });
          this.variables[name] = value;
          result.push(`${line} => ${value}`);
        } catch (e) {
          result.push(`${line} => Error`);
        }
        continue;
      }

      const funcMatch = line.match(/^(\w+)\(([^)]*)\)\s*=\s*(.+)$/);
      if (funcMatch) {
        const name = funcMatch[1];
        const params = funcMatch[2].split(',').map(p => p.trim());
        const expr = funcMatch[3];
        this.functions[name] = (...args: any[]) => {
          const scope: any = { ...this.variables };
          params.forEach((p, i) => scope[p] = args[i]);
          return math.evaluate(expr, { ...scope, ...this.functions });
        };
        result.push(line);
        continue;
      }

      if (evalIndex !== -1) {
        const name = line.trim();
        const value = this.variables[name];
        result.push(`${name} => ${value}`);
      } else {
        result.push(line);
      }
    }
    return result;
  }

  private showVariables() {
    const lines = Object.entries(this.variables).map(([k, v]) => `${k} = ${v}`);
    new Notice(lines.join('\n') || 'No variables defined');
  }
}
