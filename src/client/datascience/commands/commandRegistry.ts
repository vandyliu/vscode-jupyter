// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable, multiInject, named, optional } from 'inversify';
import { CodeLens, ConfigurationTarget, env, QuickPickItem, Range, Uri } from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import { ICommandNameArgumentTypeMapping } from '../../common/application/commands';
import {
    IApplicationEnvironment,
    IApplicationShell,
    ICommandManager,
    IDebugService,
    IDocumentManager
} from '../../common/application/types';
import { traceError } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';

import * as path from 'path';
import { IConfigurationService, IDisposable, IOutputChannel } from '../../common/types';
import { DataScience } from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import {
    IMultiStepInput,
    IMultiStepInputFactory,
    InputStep,
    IQuickPickParameters
} from '../../common/utils/multiStepInput';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { LogLevel } from '../../logging/levels';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { Commands, JUPYTER_OUTPUT_CHANNEL, Telemetry, TemplatesFolder } from '../constants';
import { IDataViewerFactory } from '../data-viewing/types';
import { DataViewerChecker } from '../interactive-common/dataViewerChecker';
import { IShowDataViewerFromVariablePanel } from '../interactive-common/interactiveWindowTypes';
import { convertDebugProtocolVariableToIJupyterVariable } from '../jupyter/debuggerVariables';
import {
    ICodeWatcher,
    IDataScienceCodeLensProvider,
    IDataScienceCommandListener,
    IJupyterServerUriStorage,
    IJupyterVariableDataProviderFactory,
    INotebookEditorProvider
} from '../types';
import { JupyterCommandLineSelectorCommand } from './commandLineSelector';
import { ExportCommands } from './exportCommands';
import { NotebookCommands } from './notebookCommands';
import { JupyterServerSelectorCommand } from './serverSelector';

interface ISelectTemplateQuickPickItem extends QuickPickItem {
    newChoice: boolean;
    delete?: boolean;
    filePath?: Uri;
}

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
        @inject(IMultiStepInputFactory) private readonly multiStepFactory: IMultiStepInputFactory,
        @inject(IApplicationEnvironment) private readonly appEnv: IApplicationEnvironment
    ) {
        this.disposables.push(this.serverSelectedCommand);
        this.disposables.push(this.notebookCommands);
        this.dataViewerChecker = new DataViewerChecker(configService, appShell);
    }
    public register() {
        this.commandLineCommand.register();
        this.serverSelectedCommand.register();
        this.notebookCommands.register();
        this.exportCommand.register();
        this.registerCommand(Commands.RunAllCells, this.runAllCells);
        this.registerCommand(Commands.RunCell, this.runCell);
        this.registerCommand(Commands.RunCurrentCell, this.runCurrentCell);
        this.registerCommand(Commands.RunCurrentCellAdvance, this.runCurrentCellAndAdvance);
        this.registerCommand(Commands.ExecSelectionInInteractiveWindow, this.runSelectionOrLine);
        this.registerCommand(Commands.RunAllCellsAbove, this.runAllCellsAbove);
        this.registerCommand(Commands.RunCellAndAllBelow, this.runCellAndAllBelow);
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
        this.registerCommand(Commands.RunAllCellsAbovePalette, this.runAllCellsAboveFromCursor);
        this.registerCommand(Commands.RunCellAndAllBelowPalette, this.runCellAndAllBelowFromCursor);
        this.registerCommand(Commands.RunToLine, this.runToLine);
        this.registerCommand(Commands.RunFromLine, this.runFromLine);
        this.registerCommand(Commands.RunFileInInteractiveWindows, this.runFileInteractive);
        this.registerCommand(Commands.DebugFileInInteractiveWindows, this.debugFileInteractive);
        this.registerCommand(Commands.AddCellBelow, this.addCellBelow);
        this.registerCommand(Commands.RunCurrentCellAndAddBelow, this.runCurrentCellAndAddBelow);
        this.registerCommand(Commands.DebugCell, this.debugCell);
        this.registerCommand(Commands.DebugStepOver, this.debugStepOver);
        this.registerCommand(Commands.DebugContinue, this.debugContinue);
        this.registerCommand(Commands.DebugStop, this.debugStop);
        this.registerCommand(Commands.DebugCurrentCellPalette, this.debugCurrentCellFromCursor);
        this.registerCommand(Commands.CreateNewNotebook, this.createNewNotebook);
        this.registerCommand(Commands.CreateNotebookFromTemplate, this.createNotebookFromTemplate);
        this.registerCommand(Commands.ViewJupyterOutput, this.viewJupyterOutput);
        this.registerCommand(Commands.LatestExtension, this.openPythonExtensionPage);
        this.registerCommand(Commands.EnableDebugLogging, this.enableDebugLogging);
        this.registerCommand(Commands.ResetLoggingLevel, this.resetLoggingLevel);
        this.registerCommand(Commands.ShowDataViewer, this.onVariablePanelShowDataViewerRequest);
        this.registerCommand(
            Commands.EnableLoadingWidgetsFrom3rdPartySource,
            this.enableLoadingWidgetScriptsFromThirdParty
        );
        this.registerCommand(Commands.ClearSavedJupyterUris, this.clearJupyterUris);
        if (this.commandListeners) {
            this.commandListeners.forEach((listener: IDataScienceCommandListener) => {
                listener.register(this.commandManager);
            });
        }
    }
    public dispose() {
        this.disposables.forEach((d) => d.dispose());
    }
    private registerCommand<
        E extends keyof ICommandNameArgumentTypeMapping,
        U extends ICommandNameArgumentTypeMapping[E]
        // tslint:disable-next-line: no-any
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

    private async runSelectionOrLine(): Promise<void> {
        const activeCodeWatcher = this.getCurrentCodeWatcher();
        if (activeCodeWatcher) {
            return activeCodeWatcher.runSelectionOrLine(this.documentManager.activeTextEditor);
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
            this.commandManager.executeCommand('workbench.action.debug.stepOver');
        }
    }

    @captureTelemetry(Telemetry.DebugStop)
    private async debugStop(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.stop');
        }
    }

    @captureTelemetry(Telemetry.DebugContinue)
    private async debugContinue(): Promise<void> {
        // Make sure that we are in debug mode
        if (this.debugService.activeDebugSession) {
            this.commandManager.executeCommand('workbench.action.debug.continue');
        }
    }

    @captureTelemetry(Telemetry.AddCellBelow)
    private async addCellBelow(): Promise<void> {
        await this.getCurrentCodeWatcher()?.addEmptyCellToBottom();
    }

    private async runCurrentCellAndAddBelow(): Promise<void> {
        this.getCurrentCodeWatcher()?.runCurrentCellAndAddBelow();
    }

    private async insertCellBelowPosition(): Promise<void> {
        this.getCurrentCodeWatcher()?.insertCellBelowPosition();
    }

    private async insertCellBelow(): Promise<void> {
        this.getCurrentCodeWatcher()?.insertCellBelow();
    }

    private async insertCellAbove(): Promise<void> {
        this.getCurrentCodeWatcher()?.insertCellAbove();
    }

    private async deleteCells(): Promise<void> {
        this.getCurrentCodeWatcher()?.deleteCells();
    }

    private async selectCell(): Promise<void> {
        this.getCurrentCodeWatcher()?.selectCell();
    }

    private async selectCellContents(): Promise<void> {
        this.getCurrentCodeWatcher()?.selectCellContents();
    }

    private async extendSelectionByCellAbove(): Promise<void> {
        this.getCurrentCodeWatcher()?.extendSelectionByCellAbove();
    }

    private async extendSelectionByCellBelow(): Promise<void> {
        this.getCurrentCodeWatcher()?.extendSelectionByCellBelow();
    }

    private async moveCellsUp(): Promise<void> {
        this.getCurrentCodeWatcher()?.moveCellsUp();
    }

    private async moveCellsDown(): Promise<void> {
        this.getCurrentCodeWatcher()?.moveCellsDown();
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

    private async createNewNotebook(): Promise<void> {
        await this.notebookEditorProvider.createNew();
    }

    private createNotebookFromTemplate(): Promise<void> {
        const multiStep = this.multiStepFactory.create<{}>();
        return multiStep.run(this.startCreatingNotebookFromTemplate.bind(this), {});
    }

    private async startCreatingNotebookFromTemplate(
        input: IMultiStepInput<{}>,
        state: {}
    ): Promise<InputStep<{}> | void> {
        // First step, show a quick pick to choose a template or create a new one
        const item = await input.showQuickPick<
            ISelectTemplateQuickPickItem,
            IQuickPickParameters<ISelectTemplateQuickPickItem>
        >({
            placeholder: DataScience.createTemplatePlaceholder(),
            items: await this.getTemplatePickList(false),
            title: DataScience.createTemplateTitle()
        });
        if (item.newChoice) {
            return this.askForNewTemplateFile(input, state);
        } else if (item.delete) {
            return this.deleteTemplateFile(input, state);
        } else if (item.filePath) {
            await this.createNewNotebookFrom(item.filePath);
        }
    }

    private async createNewNotebookFrom(file: Uri): Promise<void> {
        const contents = await this.fs.readFile(file);
        await this.notebookEditorProvider.createNew(contents);
    }

    private async askForNewTemplateFile(input: IMultiStepInput<{}>, state: {}): Promise<InputStep<{}> | void> {
        const filtersKey = DataScience.importDialogFilter();
        const filtersObject: { [name: string]: string[] } = {};
        filtersObject[filtersKey] = ['ipynb'];

        const uris = await this.appShell.showOpenDialog({
            openLabel: DataScience.createTemplateNewOpenTitle(),
            filters: filtersObject
        });

        if (uris && uris.length) {
            // Ask for a name
            return this.createNewTemplate(uris, input, state);
        }
    }

    private async deleteTemplateFile(input: IMultiStepInput<{}>, _state: {}): Promise<InputStep<{}> | void> {
        const item = await input.showQuickPick<
            ISelectTemplateQuickPickItem,
            IQuickPickParameters<ISelectTemplateQuickPickItem>
        >({
            placeholder: DataScience.createTemplatePlaceholder(),
            items: await this.getTemplatePickList(true),
            title: DataScience.deleteTemplateTitle()
        });
        if (item && item.filePath) {
            await this.fs.delete(item.filePath);
        }
    }
    private async createNewTemplate(
        uris: Uri[],
        input: IMultiStepInput<{}>,
        _state: {}
    ): Promise<InputStep<{}> | void> {
        const name = await input.showInputBox({
            title: DataScience.createTemplateNewNameTitle(),
            value: '',
            prompt: '',
            validate: (_s) => Promise.resolve(undefined)
        });

        // If  we have a name and an array of files, create the template
        if (name && uris.length) {
            const contents = await this.fs.readFile(uris[0]);
            if (this.appEnv.userSettingsFile) {
                const dir = path.join(path.dirname(this.appEnv.userSettingsFile), TemplatesFolder);
                const filePath = path.join(dir, name);
                await this.fs.createDirectory(Uri.file(dir));
                await this.fs.writeFile(Uri.file(filePath), contents);
            }
            await this.notebookEditorProvider.createNew(contents);
        }
    }

    private async getTemplatePickList(justCustom: boolean): Promise<ISelectTemplateQuickPickItem[]> {
        const items: ISelectTemplateQuickPickItem[] = [];
        let haveCustom = false;

        // Might have a default set in the extension/template folder
        const extensionTemplates = path.join(EXTENSION_ROOT_DIR, TemplatesFolder);
        if (!justCustom && (await this.fs.localDirectoryExists(extensionTemplates))) {
            const files = await this.fs.getFiles(Uri.file(extensionTemplates));
            files.forEach((f) => {
                // Files returned are just the base names.
                items.push({
                    label: `$(notebook-kernel-select) ${path.basename(f.fsPath)}`,
                    filePath: Uri.file(path.join(extensionTemplates, f.fsPath)),
                    newChoice: false
                });
            });
        }

        // Look in the user settings for templates
        const settingsFile = this.appEnv.userSettingsFile;
        if (settingsFile) {
            try {
                const dir = path.join(path.dirname(settingsFile), TemplatesFolder);
                const settingsTemplates = await this.fs.getFiles(Uri.file(dir));
                settingsTemplates.forEach((f) => {
                    haveCustom = true;
                    // Files returned are just the base names.
                    items.push({
                        label: `$(accounts-view-bar-icon) ${path.basename(f.fsPath)}`,
                        filePath: Uri.file(path.join(dir, f.fsPath)).with({ scheme: f.scheme }),
                        newChoice: false
                    });
                });
            } catch {
                // This might fail if the templates folder isn't availabe. VS code doesn't seem
                // to have a 'directory exists' for a remote file system.
            }
        }

        if (!justCustom) {
            // Then always include a 'Create New Template' entry;
            items.push({ label: `$(terminal-new) ${DataScience.createTemplateNew()}`, newChoice: true });

            // Also create a delete entry if there are any custom settings
            if (haveCustom) {
                items.push({
                    label: `$(notebook-delete-cell) ${DataScience.createTemplateDelete()}`,
                    newChoice: false,
                    delete: true
                });
            }
        }
        return items;
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
        env.openExternal(Uri.parse(`https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter`));
    }

    private async onVariablePanelShowDataViewerRequest(request: IShowDataViewerFromVariablePanel) {
        sendTelemetryEvent(EventName.OPEN_DATAVIEWER_FROM_VARIABLE_WINDOW_REQUEST);
        if (this.debugService.activeDebugSession) {
            const jupyterVariable = convertDebugProtocolVariableToIJupyterVariable(
                request.variable as DebugProtocol.Variable
            );
            try {
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
                sendTelemetryEvent(EventName.OPEN_DATAVIEWER_FROM_VARIABLE_WINDOW_ERROR, undefined, e);
                traceError(e);
                this.appShell.showErrorMessage(e.toString());
            }
        }
    }
}
