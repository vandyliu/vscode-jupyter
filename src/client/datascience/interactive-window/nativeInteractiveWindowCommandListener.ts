// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import { inject, injectable } from 'inversify';
import * as uuid from 'uuid/v4';
import {
    NotebookCell,
    NotebookRange,
    Position,
    Range,
    Selection,
    TextDocument,
    TextEditor,
    Uri,
    ViewColumn,
    workspace,
    WorkspaceEdit
} from 'vscode';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';
import { IApplicationShell, IClipboard, ICommandManager, IDocumentManager } from '../../common/application/types';
import { CancellationError } from '../../common/cancellation';
import { PYTHON_LANGUAGE } from '../../common/constants';
import { traceError, traceInfo } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';
import { IConfigurationService, IDisposableRegistry } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { captureTelemetry } from '../../telemetry';
import { CommandSource } from '../../testing/common/constants';
import { generateCellRangesFromDocument, generateCellsFromDocument } from '../cellFactory';
import { Commands, Telemetry } from '../constants';
import { ExportFormat, IExportDialog, IExportManager } from '../export/types';
import { JupyterInstallError } from '../jupyter/jupyterInstallError';
import {
    IDataScienceCommandListener,
    IDataScienceErrorHandler,
    IInteractiveBase,
    IInteractiveWindowProvider,
    IJupyterExecution,
    INotebook,
    INotebookEditorProvider,
    INotebookExporter,
    INotebookProvider,
    IStatusProvider
} from '../types';
import { createExportInteractiveIdentity } from './identity';

@injectable()
export class NativeInteractiveWindowCommandListener implements IDataScienceCommandListener {
    constructor(
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IInteractiveWindowProvider) private interactiveWindowProvider: IInteractiveWindowProvider,
        @inject(INotebookExporter) private jupyterExporter: INotebookExporter,
        @inject(IJupyterExecution) private jupyterExecution: IJupyterExecution,
        @inject(INotebookProvider) private notebookProvider: INotebookProvider,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IApplicationShell) private applicationShell: IApplicationShell,
        @inject(IFileSystem) private fileSystem: IFileSystem,
        @inject(IConfigurationService) private configuration: IConfigurationService,
        @inject(IStatusProvider) private statusProvider: IStatusProvider,
        @inject(IDataScienceErrorHandler) private dataScienceErrorHandler: IDataScienceErrorHandler,
        @inject(INotebookEditorProvider) protected ipynbProvider: INotebookEditorProvider,
        @inject(IExportManager) private exportManager: IExportManager,
        @inject(IExportDialog) private exportDialog: IExportDialog,
        @inject(IClipboard) private clipboard: IClipboard
    ) {}

    public register(commandManager: ICommandManager): void {
        let disposable = commandManager.registerCommand(Commands.CreateNewInteractive, () =>
            this.createNewInteractiveWindow()
        );
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(
            Commands.ImportNotebook,
            (file?: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
                return this.listenForErrors(() => {
                    if (file) {
                        return this.importNotebookOnFile(file);
                    } else {
                        return this.importNotebook();
                    }
                });
            }
        );
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(
            Commands.ImportNotebookFile,
            (file?: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
                return this.listenForErrors(() => {
                    if (file) {
                        return this.importNotebookOnFile(file);
                    } else {
                        return this.importNotebook();
                    }
                });
            }
        );
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(
            Commands.ExportFileAsNotebook,
            (file?: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
                return this.listenForErrors(() => {
                    if (file) {
                        return this.exportFile(file);
                    } else {
                        const activeEditor = this.documentManager.activeTextEditor;
                        if (activeEditor && activeEditor.document.languageId === PYTHON_LANGUAGE) {
                            return this.exportFile(activeEditor.document.uri);
                        }
                    }

                    return Promise.resolve();
                });
            }
        );
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(
            Commands.ExportFileAndOutputAsNotebook,
            (file: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
                return this.listenForErrors(() => {
                    if (file) {
                        return this.exportFileAndOutput(file);
                    } else {
                        const activeEditor = this.documentManager.activeTextEditor;
                        if (activeEditor && activeEditor.document.languageId === PYTHON_LANGUAGE) {
                            return this.exportFileAndOutput(activeEditor.document.uri);
                        }
                    }
                    return Promise.resolve();
                });
            }
        );
        this.disposableRegistry.push(disposable);
        this.disposableRegistry.push(commandManager.registerCommand(Commands.UndoCells, () => this.undoCells()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.RedoCells, () => this.redoCells()));
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.RemoveAllCells, () => this.removeAllCells())
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(
                Commands.InterruptKernel,
                (context?: { notebookEditor: { notebookUri: Uri } }) =>
                    this.interruptKernel(context?.notebookEditor.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(
                Commands.RestartKernel,
                (context?: { notebookEditor: { notebookUri: Uri } }) =>
                    this.restartKernel(context?.notebookEditor.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(
                Commands.ExpandAllCells,
                (context?: { notebookEditor: { notebookUri: Uri } }) =>
                    this.expandAllCells(context?.notebookEditor.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(
                Commands.CollapseAllCells,
                (context?: { notebookEditor: { notebookUri: Uri } }) =>
                    this.collapseAllCells(context?.notebookEditor.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.ExportOutputAsNotebook, () => this.exportCells())
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(
                Commands.InteractiveExportAsNotebook,
                (context?: { notebookEditor: { notebookUri: Uri } }) => this.export(context?.notebookEditor.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(
                Commands.InteractiveExportAs,
                (context?: { notebookEditor: { notebookUri: Uri } }) =>
                    this.exportAs(context?.notebookEditor.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.ScrollToCell, (file: Uri, id: string) =>
                this.scrollToCell(file, id)
            )
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.InteractiveClearAll, this.clearAllCellsInInteractiveWindow, this)
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.InteractiveRemoveCell, this.removeCellInInteractiveWindow, this)
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.InteractiveGoToCode, this.goToCodeInInteractiveWindow, this)
        );
        this.disposableRegistry.push(
            commandManager.registerCommand(Commands.InteractiveCopyCell, this.copyCellInInteractiveWindow, this)
        );
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    private async listenForErrors(promise: () => Promise<any>): Promise<any> {
        let result: any;
        try {
            result = await promise();
            return result;
        } catch (err) {
            if (!(err instanceof CancellationError)) {
                if (err.message) {
                    traceError(err.message);
                    void this.applicationShell.showErrorMessage(err.message);
                } else {
                    traceError(err.toString());
                    void this.applicationShell.showErrorMessage(err.toString());
                }
            } else {
                traceInfo('Canceled');
            }
        }
        return result;
    }

    private showInformationMessage(message: string, question?: string): Thenable<string | undefined> {
        if (question) {
            return this.applicationShell.showInformationMessage(message, question);
        } else {
            return this.applicationShell.showInformationMessage(message);
        }
    }

    @captureTelemetry(Telemetry.ExportPythonFileInteractive, undefined, false)
    private async exportFile(file: Uri): Promise<void> {
        if (file && file.fsPath && file.fsPath.length > 0) {
            // If the current file is the active editor, then generate cells from the document.
            const activeEditor = this.documentManager.activeTextEditor;
            if (activeEditor && this.fileSystem.arePathsSame(activeEditor.document.uri, file)) {
                const cells = generateCellsFromDocument(
                    activeEditor.document,
                    this.configuration.getSettings(activeEditor.document.uri)
                );
                if (cells) {
                    // Bring up the export dialog box
                    const uri = await this.exportDialog.showDialog(ExportFormat.ipynb, file);
                    await this.waitForStatus(
                        async () => {
                            if (uri) {
                                let directoryChange;
                                const settings = this.configuration.getSettings(activeEditor.document.uri);
                                if (settings.changeDirOnImportExport) {
                                    directoryChange = uri;
                                }

                                const notebook = await this.jupyterExporter.translateToNotebook(
                                    cells,
                                    directoryChange?.fsPath
                                );
                                await this.fileSystem.writeFile(uri, JSON.stringify(notebook));
                            }
                        },
                        localize.DataScience.exportingFormat(),
                        file.fsPath
                    );
                    // When all done, show a notice that it completed.
                    if (uri && uri.fsPath) {
                        const openQuestion1 = localize.DataScience.exportOpenQuestion1();
                        const selection = await this.applicationShell.showInformationMessage(
                            localize.DataScience.exportDialogComplete().format(uri.fsPath),
                            openQuestion1
                        );
                        if (selection === openQuestion1) {
                            await this.ipynbProvider.open(uri);
                        }
                    }
                }
            }
        }
    }

    @captureTelemetry(Telemetry.ExportPythonFileAndOutputInteractive, undefined, false)
    private async exportFileAndOutput(file: Uri): Promise<Uri | undefined> {
        if (file && file.fsPath && file.fsPath.length > 0 && (await this.jupyterExecution.isNotebookSupported())) {
            // If the current file is the active editor, then generate cells from the document.
            const activeEditor = this.documentManager.activeTextEditor;
            if (
                activeEditor &&
                activeEditor.document &&
                this.fileSystem.arePathsSame(activeEditor.document.uri, file)
            ) {
                const ranges = generateCellRangesFromDocument(activeEditor.document);
                if (ranges.length > 0) {
                    // Ask user for path
                    const output = await this.showExportDialog(file);

                    // If that worked, we need to start a jupyter server to get our output values.
                    // In the future we could potentially only update changed cells.
                    if (output) {
                        // Create a cancellation source so we can cancel starting the jupyter server if necessary
                        const cancelSource = new CancellationTokenSource();

                        // Then wait with status that lets the user cancel
                        await this.waitForStatus(
                            () => {
                                try {
                                    return this.exportCellsWithOutput(
                                        ranges,
                                        activeEditor.document,
                                        output,
                                        cancelSource.token
                                    );
                                } catch (err) {
                                    if (!(err instanceof CancellationError)) {
                                        void this.showInformationMessage(
                                            localize.DataScience.exportDialogFailed().format(err)
                                        );
                                    }
                                }
                                return Promise.resolve();
                            },
                            localize.DataScience.exportingFormat(),
                            file.fsPath,
                            () => {
                                cancelSource.cancel();
                            }
                        );

                        // When all done, show a notice that it completed.
                        const openQuestion1 = localize.DataScience.exportOpenQuestion1();
                        const selection = await this.applicationShell.showInformationMessage(
                            localize.DataScience.exportDialogComplete().format(output.fsPath),
                            openQuestion1
                        );
                        if (selection === openQuestion1) {
                            await this.ipynbProvider.open(output);
                        }
                        return output;
                    }
                }
            }
        } else {
            await this.dataScienceErrorHandler.handleError(
                new JupyterInstallError(
                    localize.DataScience.jupyterNotSupported().format(await this.jupyterExecution.getNotebookError()),
                    localize.DataScience.pythonInteractiveHelpLink()
                )
            );
        }
    }

    private async exportCellsWithOutput(
        ranges: { range: Range; title: string }[],
        document: TextDocument,
        file: Uri,
        cancelToken: CancellationToken
    ): Promise<void> {
        let notebook: INotebook | undefined;
        try {
            const settings = this.configuration.getSettings(document.uri);
            // Create a new notebook
            notebook = await this.notebookProvider.getOrCreateNotebook({
                identity: createExportInteractiveIdentity(),
                resource: file
            });
            // If that works, then execute all of the cells.
            const cells = Array.prototype.concat(
                ...(await Promise.all(
                    ranges.map((r) => {
                        const code = document.getText(r.range);
                        return notebook
                            ? notebook.execute(code, document.fileName, r.range.start.line, uuid(), cancelToken)
                            : [];
                    })
                ))
            );
            // Then save them to the file
            let directoryChange;
            if (settings.changeDirOnImportExport) {
                directoryChange = file;
            }
            const notebookJson = await this.jupyterExporter.translateToNotebook(cells, directoryChange?.fsPath);
            await this.fileSystem.writeFile(file, JSON.stringify(notebookJson));
        } finally {
            if (notebook) {
                await notebook.dispose();
            }
        }
    }

    private async showExportDialog(file: Uri): Promise<Uri | undefined> {
        // Bring up the save file dialog box
        return this.exportDialog.showDialog(ExportFormat.ipynb, file);
    }

    private undoCells() {
        const interactiveWindow = this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.undoCells();
        }
    }

    private redoCells() {
        const interactiveWindow = this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.redoCells();
        }
    }

    private removeAllCells() {
        const interactiveWindow = this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.removeAllCells();
        }
    }

    private interruptKernel(uri?: Uri) {
        const interactiveWindow = uri
            ? this.interactiveWindowProvider.windows.find((window) => window.notebookUri?.toString() === uri.toString())
            : this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.interruptKernel().ignoreErrors();
        }
    }

    private restartKernel(uri?: Uri) {
        const interactiveWindow = uri
            ? this.interactiveWindowProvider.windows.find((window) => window.notebookUri?.toString() === uri.toString())
            : this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.restartKernel().ignoreErrors();
        }
    }

    private expandAllCells(uri?: Uri) {
        const interactiveWindow = uri
            ? this.interactiveWindowProvider.windows.find((window) => window.notebookUri?.toString() === uri.toString())
            : this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.expandAllCells();
        }
    }

    private collapseAllCells(uri?: Uri) {
        const interactiveWindow = uri
            ? this.interactiveWindowProvider.windows.find((window) => window.notebookUri?.toString() === uri.toString())
            : this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.collapseAllCells();
        }
    }

    private exportCells() {
        const interactiveWindow = this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.exportCells();
        }
    }

    private exportAs(uri?: Uri) {
        const interactiveWindow = uri
            ? this.interactiveWindowProvider.windows.find((window) => window.notebookUri?.toString() === uri.toString())
            : this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.exportAs();
        }
    }

    private export(uri?: Uri) {
        const interactiveWindow = uri
            ? this.interactiveWindowProvider.windows.find((window) => window.notebookUri?.toString() === uri.toString())
            : this.interactiveWindowProvider.activeWindow;
        if (interactiveWindow) {
            interactiveWindow.export();
        }
    }

    @captureTelemetry(Telemetry.CreateNewInteractive, undefined, false)
    private async createNewInteractiveWindow(): Promise<void> {
        await this.interactiveWindowProvider.getOrCreate(undefined);
    }

    private waitForStatus<T>(
        promise: () => Promise<T>,
        format: string,
        file?: string,
        canceled?: () => void,
        interactiveWindow?: IInteractiveBase
    ): Promise<T> {
        const message = file ? format.format(file) : format;
        return this.statusProvider.waitWithStatus(promise, message, true, undefined, canceled, interactiveWindow);
    }

    @captureTelemetry(Telemetry.ImportNotebook, { scope: 'command' }, false)
    private async importNotebook(): Promise<void> {
        const filtersKey = localize.DataScience.importDialogFilter();
        const filtersObject: { [name: string]: string[] } = {};
        filtersObject[filtersKey] = ['ipynb'];

        const uris = await this.applicationShell.showOpenDialog({
            openLabel: localize.DataScience.importDialogTitle(),
            filters: filtersObject
        });

        if (uris && uris.length > 0) {
            // Don't call the other overload as we'll end up with double telemetry.
            await this.waitForStatus(
                async () => {
                    const contents = await this.fileSystem.readFile(uris[0]);
                    await this.exportManager.export(ExportFormat.python, contents, uris[0]);
                },
                localize.DataScience.importingFormat(),
                uris[0].fsPath
            );
        }
    }

    @captureTelemetry(Telemetry.ImportNotebook, { scope: 'file' }, false)
    private async importNotebookOnFile(file: Uri): Promise<void> {
        if (file.fsPath && file.fsPath.length > 0) {
            await this.waitForStatus(
                async () => {
                    const contents = await this.fileSystem.readFile(file);
                    await this.exportManager.export(ExportFormat.python, contents, file);
                },
                localize.DataScience.importingFormat(),
                file.fsPath
            );
        }
    }

    private async scrollToCell(file: Uri, id: string): Promise<void> {
        if (id && file) {
            // Find the interactive windows that have this file as a submitter
            const possibles = this.interactiveWindowProvider.windows.filter(
                (w) => w.submitters.findIndex((s) => this.fileSystem.areLocalPathsSame(s.fsPath, file.fsPath)) >= 0
            );

            // Scroll to cell in the one that has the cell. We need this so
            // we don't activate all of them.
            // eslint-disable-next-line @typescript-eslint/prefer-for-of
            for (let i = 0; i < possibles.length; i += 1) {
                if (await possibles[i].hasCell(id)) {
                    possibles[i].scrollToCell(id);
                    break;
                }
            }
        }
    }

    private async clearAllCellsInInteractiveWindow(context?: { notebookEditor: { notebookUri: Uri } }): Promise<void> {
        // Use the context if invoked from interactive/toolbar
        // Then fallback to the active interactive window
        const uri = context?.notebookEditor.notebookUri ?? this.interactiveWindowProvider.activeWindow?.notebookUri;
        if (!uri) {
            return;
        }

        // Look for the matching notebook document to add cells to
        const document = workspace.notebookDocuments.find((document) => document.uri.toString() === uri.toString());
        if (!document) {
            return;
        }

        // Remove the cells from the matching notebook document
        const edit = new WorkspaceEdit();
        edit.replaceNotebookCells(document.uri, new NotebookRange(0, document.cellCount), []);
        await workspace.applyEdit(edit);
    }

    private async removeCellInInteractiveWindow(context?: NotebookCell) {
        if (context) {
            const edit = new WorkspaceEdit();
            edit.replaceNotebookCells(context.notebook.uri, new NotebookRange(context.index, context.index + 1), []);
            await workspace.applyEdit(edit);
        }
    }

    private async goToCodeInInteractiveWindow(context?: NotebookCell) {
        if (context && context.metadata?.interactive) {
            const file = context.metadata.interactive.file;
            const line = context.metadata.interactive.line;

            let editor: TextEditor | undefined;

            if (await this.fileSystem.localFileExists(file)) {
                editor = await this.documentManager.showTextDocument(Uri.file(file), { viewColumn: ViewColumn.One });
            } else {
                // File URI isn't going to work. Look through the active text documents
                editor = this.documentManager.visibleTextEditors.find((te) => te.document.fileName === file);
                if (editor) {
                    editor.show();
                }
            }

            // If we found the editor change its selection
            if (editor) {
                editor.revealRange(new Range(line, 0, line, 0));
                editor.selection = new Selection(new Position(line, 0), new Position(line, 0));
            }
        }
    }

    private async copyCellInInteractiveWindow(context?: NotebookCell) {
        if (context) {
            const settings = this.configuration.getSettings(context.notebook.uri);
            const source = [
                // Prepend cell marker to code
                context.metadata.interactiveWindowCellMarker ?? settings.defaultCellMarker,
                context.document.getText()
            ].join('\n');
            await this.clipboard.writeText(source);
        }
    }
}
