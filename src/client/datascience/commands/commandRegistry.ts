// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable, multiInject, named, optional } from 'inversify';
import { CodeLens, ConfigurationTarget, env, Range, Uri } from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import { ICommandNameArgumentTypeMapping } from '../../common/application/commands';
import {
    IApplicationShell,
    ICommandManager,
    IDataWranglerProvider,
    IDebugService,
    IDocumentManager,
    IWorkspaceService
} from '../../common/application/types';
import { UseVSCodeNotebookEditorApi } from '../../common/constants';
import { traceError } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';

import { IConfigurationService, IDisposable, IOutputChannel } from '../../common/types';
import { DataScience } from '../../common/utils/localize';
import { isUri, noop } from '../../common/utils/misc';
import { LogLevel } from '../../logging/levels';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { Commands, Identifiers, JUPYTER_OUTPUT_CHANNEL, Telemetry } from '../constants';
import { IDataViewerFactory } from '../data-viewing/types';
import { DataViewerChecker } from '../interactive-common/dataViewerChecker';
import { IShowDataViewerFromVariablePanel } from '../interactive-common/interactiveWindowTypes';
import { convertDebugProtocolVariableToIJupyterVariable } from '../jupyter/debuggerVariables';
import { NotebookCreator } from '../notebook/creation/notebookCreator';
import {
    ICodeWatcher,
    IDataScienceCodeLensProvider,
    IDataScienceCommandListener,
    IJupyterServerUriStorage,
    IJupyterVariableDataProviderFactory,
    IJupyterVariables,
    INotebookEditor,
    INotebookEditorProvider
} from '../types';
import { JupyterCommandLineSelectorCommand } from './commandLineSelector';
import { ExportCommands } from './exportCommands';
import { NotebookCommands } from './notebookCommands';
import { JupyterServerSelectorCommand } from './serverSelector';

@injectable()
export class CommandRegistry implements IDisposable {
    private readonly disposables: IDisposable[] = [];
    private dataViewerChecker: DataViewerChecker;
    constructor(
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IDataScienceCodeLensProvider) private dataScienceCodeLensProvider: IDataScienceCodeLensProvider,
        @multiInject(IDataScienceCommandListener)
        @optional()
        private commandListeners: IDataScienceCommandListener[] | undefined,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(JupyterServerSelectorCommand) private readonly serverSelectedCommand: JupyterServerSelectorCommand,
        @inject(NotebookCommands) private readonly notebookCommands: NotebookCommands,
        @inject(JupyterCommandLineSelectorCommand)
        private readonly commandLineCommand: JupyterCommandLineSelectorCommand,
        @inject(INotebookEditorProvider) private notebookEditorProvider: INotebookEditorProvider,
        @inject(IDebugService) private debugService: IDebugService,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private appShell: IApplicationShell,
        @inject(IOutputChannel) @named(JUPYTER_OUTPUT_CHANNEL) private jupyterOutput: IOutputChannel,
        @inject(ExportCommands) private readonly exportCommand: ExportCommands,
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(IJupyterVariableDataProviderFactory)
        private readonly jupyterVariableDataProviderFactory: IJupyterVariableDataProviderFactory,
        @inject(IDataViewerFactory) private readonly dataViewerFactory: IDataViewerFactory,
        @inject(IJupyterServerUriStorage) private readonly serverUriStorage: IJupyterServerUriStorage,
        @inject(IJupyterVariables) @named(Identifiers.DEBUGGER_VARIABLES) private variableProvider: IJupyterVariables,
        @inject(UseVSCodeNotebookEditorApi) private readonly useNativeNotebook: boolean,
        @inject(NotebookCreator) private readonly nativeNotebookCreator: NotebookCreator,
        @inject(IWorkspaceService) private readonly workspace: IWorkspaceService,
        @inject(IDataWranglerProvider) private readonly dataWrangler: IDataWranglerProvider
    ) {
        this.disposables.push(this.serverSelectedCommand);
        this.disposables.push(this.notebookCommands);
        this.dataViewerChecker = new DataViewerChecker(configService, appShell);
        if (!this.workspace.isTrusted) {
            this.workspace.onDidGrantWorkspaceTrust(this.registerCommandsIfTrusted, this, this.disposables);
        }
    }
    public register() {
        this.registerCommandsIfTrusted();
        this.registerCommand(Commands.InsertCellBelowPosition, this.insertCellBelowPosition);
        this.registerCommand(Commands.InsertCellBelow, this.insertCellBelow);
        this.registerCommand(Commands.InsertCellAbove, this.insertCellAbove);
        this.registerCommand(Commands.DeleteCells, this.deleteCells);
        this.registerCommand(Commands.SelectCell, this.selectCell);
        this.registerCommand(Commands.SelectCellContents, this.selectCellContents);
        this.registerCommand(Commands.ExtendSelectionByCellAbove, this.extendSelectionByCellAbove);
        this.registerCommand(Commands.ExtendSelectionByCellBelow, this.extendSelectionByCellBelow);
        this.registerCommand(Commands.MoveCellsUp, this.moveCellsUp);
        this.registerCommand(Commands.MoveCellsDown, this.moveCellsDown);
        this.registerCommand(Commands.ChangeCellToMarkdown, this.changeCellToMarkdown);
        this.registerCommand(Commands.ChangeCellToCode, this.changeCellToCode);
        this.registerCommand(Commands.GotoNextCellInFile, this.gotoNextCellInFile);
        this.registerCommand(Commands.GotoPrevCellInFile, this.gotoPrevCellInFile);
        this.registerCommand(Commands.AddCellBelow, this.addCellBelow);
        this.registerCommand(Commands.CreateNewNotebook, this.createNewNotebook);
        this.registerCommand(Commands.ViewJupyterOutput, this.viewJupyterOutput);
        this.registerCommand(Commands.LatestExtension, this.openPythonExtensionPage);
        this.registerCommand(Commands.EnableDebugLogging, this.enableDebugLogging);
        this.registerCommand(Commands.ResetLoggingLevel, this.resetLoggingLevel);
        this.registerCommand(
            Commands.EnableLoadingWidgetsFrom3rdPartySource,
            this.enableLoadingWidgetScriptsFromThirdParty
        );
        this.registerCommand(Commands.ClearSavedJupyterUris, this.clearJupyterUris);
        this.registerCommand(Commands.OpenDataWrangler, this.openDataWrangler);
        if (this.commandListeners) {
            this.commandListeners.forEach((listener: IDataScienceCommandListener) => {
                listener.register(this.commandManager);
            });
        }
    }
    public dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
    private registerCommandsIfTrusted() {
        if (!this.workspace.isTrusted) {
            return;
        }
        this.commandLineCommand.register();
        this.serverSelectedCommand.register();
        this.notebookCommands.register();
        this.exportCommand.register();
        this.registerCommand(Commands.RunAllCells, this.runAllCells);
        this.registerCommand(Commands.RunCell, this.runCell);
        this.registerCommand(Commands.RunCurrentCell, this.runCurrentCell);
        this.registerCommand(Commands.RunCurrentCellAdvance, this.runCurrentCellAndAdvance);
        this.registerCommand(Commands.ExecSelectionInInteractiveWindow, (textOrUri: string | undefined | Uri) => {
            void this.runSelectionOrLine(textOrUri);
        });
        this.registerCommand(Commands.RunAllCellsAbove, this.runAllCellsAbove);
        this.registerCommand(Commands.RunCellAndAllBelow, this.runCellAndAllBelow);
        this.registerCommand(Commands.RunAllCellsAbovePalette, this.runAllCellsAboveFromCursor);
        this.registerCommand(Commands.RunCellAndAllBelowPalette, this.runCellAndAllBelowFromCursor);
        this.registerCommand(Commands.RunCurrentCellAndAddBelow, this.runCurrentCellAndAddBelow);
        this.registerCommand(Commands.DebugCell, this.debugCell);
        this.registerCommand(Commands.DebugStepOver, this.debugStepOver);
        this.registerCommand(Commands.DebugContinue, this.debugContinue);
        this.registerCommand(Commands.DebugStop, this.debugStop);
        this.registerCommand(Commands.DebugCurrentCellPalette, this.debugCurrentCellFromCursor);
        this.registerCommand(Commands.OpenVariableView, this.openVariableView);
        this.registerCommand(Commands.ShowDataViewer, this.onVariablePanelShowDataViewerRequest);
        this.registerCommand(Commands.RunToLine, this.runToLine);
        this.registerCommand(Commands.RunFromLine, this.runFromLine);
        this.registerCommand(Commands.RunFileInInteractiveWindows, this.runFileInteractive);
        this.registerCommand(Commands.DebugFileInInteractiveWindows, this.debugFileInteractive);
    }
    private registerCommand<
        E extends keyof ICommandNameArgumentTypeMapping,
        U extends ICommandNameArgumentTypeMapping[E]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    >(command: E, callback: (...args: U) => any) {
        const disposable = this.commandManager.registerCommand(command, callback, this);
        this.disposables.push(disposable);
    }

    private getCodeWatcher(file: Uri | undefined): ICodeWatcher | undefined {
        if (file) {
            const possibleDocuments = this.documentManager.textDocuments.filter((d) =>
                this.fs.arePathsSame(d.uri, file)
            );
            if (possibleDocuments && possibleDocuments.length === 1) {
                return this.dataScienceCodeLensProvider.getCodeWatcher(possibleDocuments[0]);
            } else if (possibleDocuments && possibleDocuments.length > 1) {
                throw new Error(DataScience.documentMismatch().format(file.fsPath));
            }
        }

        return undefined;
    }

    private async enableDebugLogging() {
        const previousValue = this.configService.getSettings().logging.level;
        if (previousValue !== LogLevel.Debug) {
            await this.configService.updateSetting('logging.level', 'debug', undefined, ConfigurationTarget.Global);
            this.commandManager.executeCommand('jupyter.reloadVSCode', DataScience.reloadRequired()).then(noop, noop);
        }
    }

    private async resetLoggingLevel() {
        const previousValue = this.configService.getSettings().logging.level;
        if (previousValue !== LogLevel.Error) {
            await this.configService.updateSetting('logging.level', 'error', undefined, ConfigurationTarget.Global);
            this.commandManager.executeCommand('jupyter.reloadVSCode', DataScience.reloadRequired()).then(noop, noop);
        }
    }

    private enableLoadingWidgetScriptsFromThirdParty(): void {
        if (this.configService.getSettings(undefined).widgetScriptSources.length > 0) {
            return;
        }
        // Update the setting and once updated, notify user to restart kernel.
        this.configService
            .updateSetting('widgetScriptSources', ['jsdelivr.com', 'unpkg.com'], undefined, ConfigurationTarget.Global)
            .then(() => {
                // Let user know they'll need to restart the kernel.
                this.appShell
                    .showInformationMessage(DataScience.loadThirdPartyWidgetScriptsPostEnabled())
                    .then(noop, noop);
            })
            .catch(noop);
    }

    private async clearJupyterUris(): Promise<void> {
        return this.serverUriStorage.clearUriList();
    }

    private async runAllCells(file: Uri | undefined): Promise<void> {
        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.runAllCells();
        } else {
            return;
        }
    }

    private async runFileInteractive(file: Uri): Promise<void> {
        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.runFileInteractive();
        } else {
            return;
        }
    }

    private async debugFileInteractive(file: Uri): Promise<void> {
        let codeWatcher = this.getCodeWatcher(file);
        if (!codeWatcher) {
            codeWatcher = this.getCurrentCodeWatcher();
        }
        if (codeWatcher) {
            return codeWatcher.debugFileInteractive();
        } else {
            return;
        }
    }

    // Note: see codewatcher.ts where the runcell command args are attached. The reason we don't have any
    // objects for parameters is because they can't be recreated when passing them through the LiveShare API
    private async runCell(
        file: Uri,
        startLine: number,
        startChar: number,
        endLine: number,
        endChar: number
    ): Promise<void> {
        const codeWatcher = this.getCodeWatcher(file);
        if (codeWatcher) {
            return codeWatcher.runCell(new Range(startLine, startChar, endLine, endChar));
        }
    }

    private async runAllCellsAbove(file: Uri, stopLine: number, stopCharacter: number): Promise<void> {
        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.runAllCellsAbove(stopLine, stopCharacter);
            }
        }
    }

    private async runCellAndAllBelow(file: Uri | undefined, startLine: number, startCharacter: number): Promise<void> {
        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.runCellAndAllBelow(startLine, startCharacter);
            }
        }
    }

    private async runToLine(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        const textEditor = this.documentManager.activeTextEditor;

        if (activeCodeWatcher && textEditor && textEditor.selection) {
            return activeCodeWatcher.runToLine(textEditor.selection.start.line);
        }
    }

    private async runFromLine(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        const textEditor = this.documentManager.activeTextEditor;

        if (activeCodeWatcher && textEditor && textEditor.selection) {
            return activeCodeWatcher.runFromLine(textEditor.selection.start.line);
        }
    }

    private async runCurrentCell(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCell();
        } else {
            return;
        }
    }

    private async runCurrentCellAndAdvance(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runCurrentCellAndAdvance();
        } else {
            return;
        }
    }

    private async runSelectionOrLine(textOrUri: string | undefined | Uri): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runSelectionOrLine(
                this.documentManager.activeTextEditor,
                // If this is a URI, the runSelectionOrLine is not expecting a URI, so act like nothing was sent.
                isUri(textOrUri) ? undefined : textOrUri
            );
        } else {
            return;
        }
    }

    private async debugCell(
        file: Uri,
        startLine: number,
        startChar: number,
        endLine: number,
        endChar: number
    ): Promise<void> {
        if (file) {
            const codeWatcher = this.getCodeWatcher(file);

            if (codeWatcher) {
                return codeWatcher.debugCell(new Range(startLine, startChar, endLine, endChar));
            }
        }
    }

    @captureTelemetry(Telemetry.DebugStepOver)
    private async debugStepOver(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            void this.commandManager.executeCommand('workbench.action.debug.stepOver');
        }
    }

    @captureTelemetry(Telemetry.DebugStop)
    private async debugStop(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            void this.commandManager.executeCommand('workbench.action.debug.stop');
        }
    }

    @captureTelemetry(Telemetry.DebugContinue)
    private async debugContinue(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            void this.commandManager.executeCommand('workbench.action.debug.continue');
        }
    }

    @captureTelemetry(Telemetry.AddCellBelow)
    private async addCellBelow(): Promise<void> {
        await this.getCurrentCodeWatcher()?.addEmptyCellToBottom();
    }

    private async runCurrentCellAndAddBelow(): Promise<void> {
        void this.getCurrentCodeWatcher()?.runCurrentCellAndAddBelow();
    }

    private async insertCellBelowPosition(): Promise<void> {
        void this.getCurrentCodeWatcher()?.insertCellBelowPosition();
    }

    private async insertCellBelow(): Promise<void> {
        void this.getCurrentCodeWatcher()?.insertCellBelow();
    }

    private async insertCellAbove(): Promise<void> {
        void this.getCurrentCodeWatcher()?.insertCellAbove();
    }

    private async deleteCells(): Promise<void> {
        void this.getCurrentCodeWatcher()?.deleteCells();
    }

    private async selectCell(): Promise<void> {
        void this.getCurrentCodeWatcher()?.selectCell();
    }

    private async selectCellContents(): Promise<void> {
        void this.getCurrentCodeWatcher()?.selectCellContents();
    }

    private async extendSelectionByCellAbove(): Promise<void> {
        void this.getCurrentCodeWatcher()?.extendSelectionByCellAbove();
    }

    private async extendSelectionByCellBelow(): Promise<void> {
        void this.getCurrentCodeWatcher()?.extendSelectionByCellBelow();
    }

    private async moveCellsUp(): Promise<void> {
        void this.getCurrentCodeWatcher()?.moveCellsUp();
    }

    private async moveCellsDown(): Promise<void> {
        void this.getCurrentCodeWatcher()?.moveCellsDown();
    }

    private async changeCellToMarkdown(): Promise<void> {
        this.getCurrentCodeWatcher()?.changeCellToMarkdown();
    }

    private async changeCellToCode(): Promise<void> {
        this.getCurrentCodeWatcher()?.changeCellToCode();
    }

    private async gotoNextCellInFile(): Promise<void> {
        this.getCurrentCodeWatcher()?.gotoNextCell();
    }

    private async gotoPrevCellInFile(): Promise<void> {
        this.getCurrentCodeWatcher()?.gotoPreviousCell();
    }

    private async runAllCellsAboveFromCursor(): Promise<void> {
        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.runAllCellsAbove(
                    currentCodeLens.range.start.line,
                    currentCodeLens.range.start.character
                );
            }
        } else {
            return;
        }
    }

    private async runCellAndAllBelowFromCursor(): Promise<void> {
        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.runCellAndAllBelow(
                    currentCodeLens.range.start.line,
                    currentCodeLens.range.start.character
                );
            }
        } else {
            return;
        }
    }

    private async debugCurrentCellFromCursor(): Promise<void> {
        const currentCodeLens = this.getCurrentCodeLens();
        if (currentCodeLens) {
            const activeCodeWatcher = this.getCurrentCodeWatcher();
            if (activeCodeWatcher) {
                return activeCodeWatcher.debugCurrentCell();
            }
        } else {
            return;
        }
    }

    private async createNewNotebook(): Promise<INotebookEditor | undefined> {
        if (this.useNativeNotebook) {
            return await this.nativeNotebookCreator.createNewNotebook();
        } else {
            return await this.notebookEditorProvider.createNew();
        }
    }

    private async openDataWrangler(): Promise<void> {
        await this.dataWrangler.open();
    }

    private viewJupyterOutput() {
        this.jupyterOutput.show(true);
    }

    private getCurrentCodeLens(): CodeLens | undefined {
        const activeEditor = this.documentManager.activeTextEditor;
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeEditor && activeCodeWatcher) {
            // Find the cell that matches
            return activeCodeWatcher.getCodeLenses().find((c: CodeLens) => {
                if (
                    c.range.end.line >= activeEditor.selection.anchor.line &&
                    c.range.start.line <= activeEditor.selection.anchor.line
                ) {
                    return true;
                }
                return false;
            });
        }
    }
    // Get our matching code watcher for the active document
    private getCurrentCodeWatcher(): ICodeWatcher | undefined {
        const activeEditor = this.documentManager.activeTextEditor;
        if (!activeEditor || !activeEditor.document) {
            return undefined;
        }

        // Ask our code lens provider to find the matching code watcher for the current document
        return this.dataScienceCodeLensProvider.getCodeWatcher(activeEditor.document);
    }

    private openPythonExtensionPage() {
        void env.openExternal(Uri.parse(`https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter`));
    }

    // Open up our variable viewer using the command that VS Code provides for this
    private async openVariableView(): Promise<void> {
        // For all contributed views vscode creates a command with the format [view ID].focus to focus that view
        // It's the given way to focus a single view so using that here, note that it needs to match the view ID
        return this.commandManager.executeCommand('jupyterViewVariables.focus');
    }

    private async onVariablePanelShowDataViewerRequest(request: IShowDataViewerFromVariablePanel) {
        sendTelemetryEvent(EventName.OPEN_DATAVIEWER_FROM_VARIABLE_WINDOW_REQUEST);
        if (this.debugService.activeDebugSession) {
            try {
                const variable = convertDebugProtocolVariableToIJupyterVariable(
                    request.variable as DebugProtocol.Variable
                );
                const jupyterVariable = await this.variableProvider.getFullVariable(variable);
                const jupyterVariableDataProvider = await this.jupyterVariableDataProviderFactory.create(
                    jupyterVariable
                );
                const dataFrameInfo = await jupyterVariableDataProvider.getDataFrameInfo();
                const columnSize = dataFrameInfo?.columns?.length;
                if (columnSize && (await this.dataViewerChecker.isRequestedColumnSizeAllowed(columnSize))) {
                    const title: string = `${DataScience.dataExplorerTitle()} - ${jupyterVariable.name}`;
                    await this.dataViewerFactory.create(jupyterVariableDataProvider, title);
                    sendTelemetryEvent(EventName.OPEN_DATAVIEWER_FROM_VARIABLE_WINDOW_SUCCESS);
                }
            } catch (e) {
                sendTelemetryEvent(EventName.OPEN_DATAVIEWER_FROM_VARIABLE_WINDOW_ERROR, undefined, undefined, e);
                traceError(e);
                void this.appShell.showErrorMessage(e.toString());
            }
        }
    }
}
