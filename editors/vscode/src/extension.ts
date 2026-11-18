/**
 * VS Code extension for `.hana` schema files: diagnostics, formatting, go to definition and
 * completion. The logic lives in `analysis.ts`; this file wires it to the VS Code API.
 */

import * as vscode from "vscode";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { complete, definition, diagnose, format, type Completion, type Workspace } from "./analysis.ts";

const LANGUAGE = "hana";

/** The other `.hana` files of the folder: a schema folder is merged into one schema. */
function siblings(doc: vscode.TextDocument): { file: string; source: string }[] {
  if (doc.uri.scheme !== "file") return [];
  const dir = dirname(doc.uri.fsPath);
  const open = new Map(vscode.workspace.textDocuments.filter((d) => d.languageId === LANGUAGE).map((d) => [d.uri.fsPath, d.getText()]));
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".hana") && statSync(join(dir, n)).isFile());
  } catch {
    return [];
  }
  // a single schema.hana next to other unrelated .hana files is not a folder schema
  if (names.length < 2) return [];
  return names
    .filter((n) => join(dir, n) !== doc.uri.fsPath)
    .map((n) => {
      const path = join(dir, n);
      return { file: path, source: open.get(path) ?? readFileSync(path, "utf8") };
    });
}

function workspaceOf(doc: vscode.TextDocument): Workspace {
  return { file: doc.uri.scheme === "file" ? doc.uri.fsPath : basename(doc.uri.path), text: doc.getText(), siblings: siblings(doc) };
}

const KIND: Record<Completion["kind"], vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  type: vscode.CompletionItemKind.Class,
  attribute: vscode.CompletionItemKind.Property,
  function: vscode.CompletionItemKind.Function,
};

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  context.subscriptions.push(diagnostics);

  const refresh = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== LANGUAGE) return;
    diagnostics.set(
      doc.uri,
      diagnose(workspaceOf(doc)).map((d) => {
        const diag = new vscode.Diagnostic(new vscode.Range(d.start.line, d.start.character, d.end.line, d.end.character), d.message, vscode.DiagnosticSeverity.Error);
        diag.source = "hana-orm";
        return diag;
      }),
    );
  };
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh(e.document), 250);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
  );
  vscode.workspace.textDocuments.forEach(refresh);

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(LANGUAGE, {
      provideDocumentFormattingEdits(doc) {
        const formatted = format(doc.getText(), doc.fileName);
        if (formatted === null || formatted === doc.getText()) return [];
        return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), formatted)];
      },
    }),
    vscode.languages.registerDefinitionProvider(LANGUAGE, {
      provideDefinition(doc, position) {
        const ws = workspaceOf(doc);
        const loc = definition(ws, { line: position.line, character: position.character });
        if (!loc) return null;
        const uri = loc.file === ws.file ? doc.uri : vscode.Uri.file(loc.file);
        return new vscode.Location(uri, new vscode.Range(loc.start.line, loc.start.character, loc.end.line, loc.end.character));
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      LANGUAGE,
      {
        provideCompletionItems(doc, position) {
          return complete(workspaceOf(doc), { line: position.line, character: position.character }).map((c) => {
            const item = new vscode.CompletionItem(c.label, KIND[c.kind]);
            if (c.detail) item.detail = c.detail;
            if (c.insert) item.insertText = new vscode.SnippetString(c.insert);
            // `@db.NVarChar` after a typed `@`: replace from the `@`
            const line = doc.lineAt(position.line).text.slice(0, position.character);
            const at = /@{1,2}[\w.]*$/.exec(line);
            if (at && c.label.startsWith("@")) item.range = new vscode.Range(position.line, position.character - at[0].length, position.line, position.character);
            return item;
          });
        },
      },
      "@",
      ".",
      " ",
    ),
  );
}

export function deactivate(): void {}
