// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../common/extensions';

import { inject, injectable, named } from 'inversify';
import { EOL } from 'os';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import { Disposable, EventEmitter, Memento, NotebookCell, ViewColumn, WebviewPanel } from 'vscode';

import {
    IApplicationShell,
    ICommandManager,
    IWebviewPanelProvider,
    IWorkspaceService,
    IDocumentManager
} from '../../../common/application/types';
import { EXTENSION_ROOT_DIR, PYTHON_LANGUAGE, UseCustomEditorApi } from '../../../common/constants';
import { traceError } from '../../../common/logger';
import { GLOBAL_MEMENTO, IConfigurationService, IDisposable, IMemento } from '../../../common/types';
import * as localize from '../../../common/utils/localize';
import { Commands, Identifiers } from '../../constants';
import {
    ICell,
    ICodeCssGenerator,
    IJupyterVariableDataProvider,
    IJupyterVariableDataProviderFactory,
    IJupyterVariables,
    INotebook,
    IThemeFinder,
    WebViewViewChangeEventArgs
} from '../../types';
import { updateCellCode } from '../../notebook/helpers/executionHelpers';
import { CssMessages } from '../../messages';
import { ColumnType, DataViewerMessages, IDataFrameInfo, IDataViewerDataProvider } from '../types';
import {
    IDataWrangler,
    DataWranglerMessages,
    DataWranglerCommands,
    IRenameColumnsRequest,
    IHistoryItem,
    IDropRequest,
    INormalizeColumnRequest,
    IFillNaRequest,
    IDropDuplicatesRequest,
    IDropNaRequest,
    ICoerceColumnRequest,
    IReplaceAllColumnsRequest,
    IRemoveHistoryItemRequest,
    SidePanelSections,
    IGetColumnStatsRequest,
    ICellCssStylesHash,
    IGetHistoryItemRequest,
    IRespondToPreviewRequest,
    DataWranglerCommandArgs
} from './types';
import { DataScience } from '../../../common/utils/localize';
import { DataViewer } from '../dataViewer';
import { nbformat } from '@jupyterlab/coreutils';

// Where in the VS Code screen to have the data wrangler opened up
const PREFERRED_VIEWGROUP = 'JupyterDataWranglerPreferredViewColumn';
const dataWranglerDir = path.join(EXTENSION_ROOT_DIR, 'out', 'datascience-ui', 'viewers');

// Keeps track of all the transformations called on the data wrangler
// Runs the transformations, communicates with the data wrangler UI through onMessage and postMessage
@injectable()
export class DataWrangler extends DataViewer implements IDataWrangler, IDisposable {
    private existingDisposable: Disposable | undefined;
    private historyList: IHistoryItem[] = [];
    private sourceFile: string | undefined;
    private commands = new Map<
        DataWranglerCommands,
        <T extends DataWranglerCommands>(
            args: DataWranglerCommandArgs<T>,
            currentVariableName: string
        ) => Promise<IHistoryItem | void>
    >();

    public get visible() {
        return !!this.webPanel?.isVisible();
    }

    public get onDidDisposeDataWrangler() {
        return this._onDidDisposeDataWrangler.event;
    }

    public get onDidChangeDataWranglerViewState() {
        return this._onDidChangeDataWranglerViewState.event;
    }

    private _onDidDisposeDataWrangler = new EventEmitter<IDataWrangler>();
    private _onDidChangeDataWranglerViewState = new EventEmitter<void>();

    constructor(
        @inject(IConfigurationService) configuration: IConfigurationService,
        @inject(IWebviewPanelProvider) provider: IWebviewPanelProvider,
        @inject(ICodeCssGenerator) cssGenerator: ICodeCssGenerator,
        @inject(IThemeFinder) themeFinder: IThemeFinder,
        @inject(IWorkspaceService) workspaceService: IWorkspaceService,
        @inject(IApplicationShell) applicationShell: IApplicationShell,
        @inject(UseCustomEditorApi) useCustomEditorApi: boolean,
        @inject(IMemento) @named(GLOBAL_MEMENTO) readonly globalMemento: Memento,
        @inject(ICommandManager) private commandManager: ICommandManager,
        @inject(IDocumentManager) private readonly documentManager: IDocumentManager,
        @inject(IJupyterVariables)
        @named(Identifiers.KERNEL_VARIABLES)
        private kernelVariableProvider: IJupyterVariables,
        @inject(IJupyterVariableDataProviderFactory)
        private dataProviderFactory: IJupyterVariableDataProviderFactory
    ) {
        super(
            configuration,
            provider,
            cssGenerator,
            themeFinder,
            workspaceService,
            applicationShell,
            useCustomEditorApi,
            globalMemento,
            dataWranglerDir,
            [path.join(dataWranglerDir, 'commons.initial.bundle.js'), path.join(dataWranglerDir, 'dataWrangler.js')],
            localize.DataScience.dataWranglerTitle(),
            PREFERRED_VIEWGROUP,
            ViewColumn.One
        );
        this.commands.set(DataWranglerCommands.Describe, this.getColumnStats.bind(this));
        this.commands.set(DataWranglerCommands.ExportToPythonScript, this.generatePythonCode.bind(this));
        this.commands.set(DataWranglerCommands.ExportToNotebook, this.generateNotebook.bind(this));
        this.commands.set(DataWranglerCommands.RenameColumn, this.renameColumn.bind(this));
        this.commands.set(DataWranglerCommands.Drop, this.drop.bind(this));
        this.commands.set(DataWranglerCommands.DropDuplicates, this.dropDuplicates.bind(this));
        this.commands.set(DataWranglerCommands.DropNa, this.dropNa.bind(this));
        this.commands.set(DataWranglerCommands.NormalizeColumn, this.normalizeColumn.bind(this));
        this.commands.set(DataWranglerCommands.FillNa, this.fillNa.bind(this));
        this.commands.set(DataWranglerCommands.GetHistoryItem, this.getHistoryItem.bind(this));
        this.commands.set(DataWranglerCommands.CoerceColumn, this.coerceColumn.bind(this));
        this.commands.set(DataWranglerCommands.ReplaceAllColumn, this.replaceAllColumn.bind(this));
        this.commands.set(DataWranglerCommands.RemoveHistoryItem, this.removeHistoryItem.bind(this));
        this.commands.set(DataWranglerCommands.ExportToCsv, this.exportToCsv.bind(this));
        this.commands.set(DataWranglerCommands.RespondToPreview, this.respondToPreview.bind(this));

        this.onDidDispose(this.dataWranglerDisposed, this);
    }

    public async showData(
        dataProvider: IDataViewerDataProvider,
        title: string,
        webviewPanel?: WebviewPanel
    ): Promise<void> {
        if (!this.isDisposed) {
            // Save the data provider
            this.dataProvider = dataProvider;

            // Load the web panel using our current directory as we don't expect to load any other files
            await super.loadWebview(process.cwd(), webviewPanel).catch(traceError);
            const settings = this.configService.getSettings();
            if (settings && settings.dataWrangler && settings.dataWrangler.sidePanelSections) {
                const wantedPanels = settings.dataWrangler.sidePanelSections;
                this.postMessage(
                    DataWranglerMessages.SetSidePanels,
                    wantedPanels as SidePanelSections[]
                ).ignoreErrors();
            }

            // Use Data Viewer logic to show initial data
            const dataFrameInfo = await this.showInitialData(title);
            this.sourceFile = dataFrameInfo.sourceFile;

            this.addToHistory({
                description: DataScience.dataWranglerImportDescription(),
                code: this.createCode(['import pandas as pd', `df = pd.read_csv(r'${this.sourceFile ?? ''}')`]),
                variableName: 'df'
            });
        }
    }

    protected async showInitialData(title: string): Promise<IDataFrameInfo> {
        super.setTitle(title);

        // Show our web panel. Eventually we need to consume the data
        await super.show(true);

        let dataFrameInfo = await this.prepDataFrameInfo();

        // Send a message with our data
        this.postMessage(DataViewerMessages.InitializeData, dataFrameInfo).ignoreErrors();

        // Return for data wrangler to use
        return dataFrameInfo;
    }

    private dataWranglerDisposed() {
        this._onDidDisposeDataWrangler.fire(this as IDataWrangler);
    }

    // Shows the dataframe in data viewer associated with newVariableName
    public async updateWithNewVariable(newVariableName: string) {
        const notebook = (this.dataProvider as IJupyterVariableDataProvider).notebook;

        // Generate a variable
        const jupyterVariable = await this.kernelVariableProvider.getFullVariable(
            {
                name: newVariableName,
                value: '',
                supportsDataExplorer: true,
                type: 'DataFrame',
                size: 0,
                shape: '',
                count: 0,
                truncated: true
            },
            notebook
        );
        const jupyterVariableDataProvider = await this.dataProviderFactory.create(jupyterVariable);
        // Set dependencies for jupyterVariableDataProvider
        jupyterVariableDataProvider.setDependencies(jupyterVariable, notebook);
        // Get variable info
        this.dataFrameInfoPromise = jupyterVariableDataProvider.getDataFrameInfo();
        this.dataProvider = jupyterVariableDataProvider;
        const dataFrameInfo = await this.dataFrameInfoPromise;

        this.postMessage(DataViewerMessages.InitializeData, dataFrameInfo).ignoreErrors();
    }

    protected async onViewStateChanged(args: WebViewViewChangeEventArgs) {
        if (args.current.active && args.current.visible && args.previous.active && args.current.visible) {
            await this.globalMemento.update(PREFERRED_VIEWGROUP, this.webPanel?.viewColumn);
        }
        this._onDidChangeDataWranglerViewState.fire();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected onMessage(message: string, payload: any) {
        let handled = false;
        switch (message) {
            case DataWranglerMessages.SubmitCommand:
                this.handleCommand(payload).ignoreErrors();
                handled = true;
                break;

            case DataWranglerMessages.RefreshDataWrangler:
                this.refreshData().ignoreErrors();
                handled = true;
                break;

            case CssMessages.GetMonacoThemeRequest:
                this.handleMonacoThemeRequest(payload).ignoreErrors();
                handled = true;
                break;

            default:
                break;
        }

        if (!handled) {
            // Some messages will be handled by DataViewer
            super.onMessage(message, payload);
        }
    }

    private addToHistory(newHistoryItem: IHistoryItem) {
        this.historyList.push(newHistoryItem);
        this.postMessage(DataWranglerMessages.UpdateHistoryList, this.historyList).ignoreErrors();
    }

    private getCombinedCode() {
        return this.createCode(this.historyList.map((item) => item.code));
    }

    private async exportToCsv(_req: undefined, currentVariableName: string) {
        const notebook = (this.dataProvider as IJupyterVariableDataProvider).notebook;
        const fileInfo = await this.applicationShell.showSaveDialog({
            saveLabel: DataScience.dataWranglerSaveCsv(),
            filters: { CSV: ['csv'] }
        });
        if (fileInfo) {
            const code = this.createCode([
                `${currentVariableName}.to_csv(path_or_buf=r'${fileInfo.fsPath}', index=False)`
            ]);
            await this.executeNotebookCode(notebook, code);
        }
    }

    private async generatePythonCode() {
        var dataCleanCode = this.getCombinedCode();

        const doc = await this.documentManager.openTextDocument({
            language: PYTHON_LANGUAGE,
            content: dataCleanCode
        });

        await this.documentManager.showTextDocument(doc, 1, true);
    }

    private async generateNotebook() {
        const dataCleanCode = this.getCombinedCode();
        const notebookEditor = await this.commandManager.executeCommand(Commands.CreateNewNotebook);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blankCell = (notebookEditor as any).document.cellAt(0) as NotebookCell;
        await updateCellCode(blankCell, dataCleanCode);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async handleCommand(payload: { command: DataWranglerCommands; args: any }) {
        const notebook = (this.dataProvider as IJupyterVariableDataProvider).notebook;
        let codeToRun;
        const currentVariableName = (await this.dataFrameInfoPromise)!.name ?? '';
        let newVariableName = currentVariableName ?? '';
        let historyItem: IHistoryItem | void;

        // Get and run data wrangler command
        const cmd = this.commands.get(payload.command);
        if (!cmd) {
            return;
        }

        historyItem = await cmd(payload.args, currentVariableName);
        if (historyItem !== undefined) {
            // Preview code adds a neighboring column to the original column
            // If we are doing a preview operation, we will run the preview code instead of the actual code
            // that would change the original column in place
            codeToRun = historyItem.isPreview ? historyItem.previewCode : historyItem.code;
            newVariableName = historyItem.variableName;
        }

        // Execute python command
        if (codeToRun !== undefined && notebook !== undefined) {
            const codeErrored = await this.executeNotebookCode(notebook, codeToRun);
            if (codeErrored) {
                return;
            }
            if (this.existingDisposable) {
                this.existingDisposable.dispose();
            }
            if (newVariableName) {
                await this.updateWithNewVariable(newVariableName);
            }
        }

        if (historyItem) {
            if (historyItem.shouldAdd) {
                // Add the history item to the history list to be displayed
                this.addToHistory(historyItem);
            }

            // Change data wrangler cell stylings if preview operation
            if (historyItem.isPreview && historyItem.type) {
                const stylings = await this.computeCssStylings(historyItem.type);
                if (stylings) {
                    void this.postMessage(DataWranglerMessages.OperationPreview, {
                        type: historyItem.type,
                        cssStylings: stylings
                    });
                }
            }
        }
    }

    public async getHistoryItem(req: IGetHistoryItemRequest) {
        const variableName = this.historyList[req.index].variableName;
        await this.updateWithNewVariable(variableName);
    }

    private async getColumnStats(req: IGetColumnStatsRequest) {
        if (req.targetColumn !== undefined && this.dataProvider && this.dataProvider.getCols) {
            const columnData = await this.dataProvider.getCols(req.targetColumn);
            void this.postMessage(DataWranglerMessages.GetHistogramResponse, {
                cols: columnData,
                columnName: req.targetColumn
            });
        } else {
            // Don't show a specific column in summary panel
            void this.postMessage(DataWranglerMessages.GetHistogramResponse, undefined);
        }
    }

    public async removeLatestHistoryItem() {
        if (this.historyList.length > 1) {
            await this.handleCommand({
                command: DataWranglerCommands.RemoveHistoryItem,
                args: { index: this.historyList.length - 1 }
            });
        }
    }

    public async removeHistoryItem(req: IRemoveHistoryItemRequest, currentVariableName: string): Promise<IHistoryItem> {
        this.historyList.splice(req.index, 1);
        this.postMessage(DataWranglerMessages.UpdateHistoryList, this.historyList).ignoreErrors();
        return {
            type: DataWranglerCommands.RemoveHistoryItem,
            description: '',
            code: this.createCode([`del ${currentVariableName}`]),
            variableName: this.historyList[this.historyList.length - 1].variableName,
            shouldAdd: false
        };
    }

    private async coerceColumn(req: ICoerceColumnRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        const targetColumns = this.generateStringListOfColumns(req.targetColumns);
        const astypeDict = this.generateColumnValueDict(req.targetColumns, req.newType, true);
        const code = this.createCode([`${newVar} = ${currVar}.astype({${astypeDict}})`]);
        const historyItem = {
            type: DataWranglerCommands.CoerceColumn,
            description: DataScience.dataWranglerCoerceColumnDescription().format(targetColumns, req.newType),
            variableName: newVar,
            code: code,
            shouldAdd: true
        };
        return historyItem;
    }

    private async replaceAllColumn(req: IReplaceAllColumnsRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        const oldValue = this.getValueBasedOnType(req.oldValue, req.oldValueType);
        const newValue = this.getValueBasedOnType(req.newValue, req.newValueType);
        const targetColumns = this.generateStringListOfColumns(req.targetColumns);

        // Make a copy of dataframe
        const setupCode = `${newVar} = ${currVar}.copy()`;

        const previewCodeList: string[] = [];
        const codeList: string[] = [];

        // Replace columns that have type string
        codeList.push(
            `${newVar}[[${targetColumns}]] = ${newVar}[[${targetColumns}]].replace(to_replace=${oldValue}, value=${newValue})`
        );

        if (req.isPreview) {
            // Need to go through each column and create a preview column for each of those columns and add it beside the original column
            req.targetColumns.forEach((col) => {
                const singleColumnPreviewCodeList = this.generatePreviewCodeList(
                    newVar,
                    col,
                    `${newVar}[['${col}']].replace(to_replace=${oldValue}, value=${newValue})`
                );
                previewCodeList.push(...singleColumnPreviewCodeList);
            });
        }

        // Create preview code
        const previewCode = this.createCode([setupCode, ...previewCodeList]);

        // Create actual code
        const code = this.createCode([setupCode, ...codeList]);

        const historyItem = {
            type: DataWranglerCommands.ReplaceAllColumn,
            description: DataScience.dataWranglerReplaceAllDescription().format(oldValue, newValue, targetColumns),
            variableName: newVar,
            code: code,
            previewCode: previewCode,
            isPreview: req.isPreview,
            shouldAdd: true
        };
        return historyItem;
    }

    private async renameColumn(req: IRenameColumnsRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        const code = this.createCode([
            `${newVar} = ${currVar}.rename(columns={ '${req.targetColumn}': '${req.newColumnName}' })`
        ]);
        const historyItem = {
            type: DataWranglerCommands.RenameColumn,
            description: DataScience.dataWranglerRenameColumnDescription().format(req.targetColumn, req.newColumnName),
            variableName: newVar,
            code: code,
            shouldAdd: true
        };
        return historyItem;
    }

    private async drop(req: IDropRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        if (req.rowIndices !== undefined) {
            // Drop rows by index
            const rows = req.rowIndices.join(', ');
            const code =
                req.rowIndices.length === 1
                    ? this.createCode([`${newVar} = ${currVar}.drop(index=${req.rowIndices[0]})`])
                    : this.createCode([`${newVar} = ${currVar}.drop(index=[${rows}])`]);
            const historyItem = {
                type: DataWranglerCommands.Drop,
                description: DataScience.dataWranglerDropRowDescription().format(rows),
                variableName: newVar,
                code: code,
                shouldAdd: true
            };
            return historyItem;
        } else if (req.targetColumns) {
            // Drop columns by column name
            const targetColumns = this.generateStringListOfColumns(req.targetColumns);
            const code = this.createCode([`${newVar} = ${currVar}.drop(columns=[${targetColumns}])`]);
            const historyItem = {
                type: DataWranglerCommands.Drop,
                description: DataScience.dataWranglerDropColumnDescription().format(targetColumns),
                variableName: newVar,
                code: code,
                shouldAdd: true
            };
            return historyItem;
        }
        return {} as IHistoryItem;
    }

    private async dropDuplicates(req: IDropDuplicatesRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        if (req.targetColumns !== undefined) {
            // Drop duplicates in a column
            const targetColumns = this.generateStringListOfColumns(req.targetColumns);
            const code = this.createCode([`${newVar} = ${currVar}.drop_duplicates(subset=[${targetColumns}])`]);
            const historyItem = {
                type: DataWranglerCommands.DropDuplicates,
                description: DataScience.dataWranglerDropDuplicatesRowsOnColumnDescription().format(targetColumns),
                variableName: newVar,
                code: code,
                shouldAdd: true
            };
            return historyItem;
        } else {
            // Drop duplicate rows
            const code = this.createCode([`${newVar} = ${currVar}.drop_duplicates()`]);
            const historyItem = {
                type: DataWranglerCommands.DropDuplicates,
                description: DataScience.dataWranglerDropDuplicatesRowsDescription(),
                variableName: newVar,
                code: code,
                shouldAdd: true
            };
            return historyItem;
        }
    }

    private async dropNa(req: IDropNaRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        if (req.targetColumns !== undefined) {
            // Only drop rows where there are Na values in the target columns
            const targetColumns = this.generateStringListOfColumns(req.targetColumns);
            const code = this.createCode([`${newVar} = ${currVar}.dropna(subset=[${targetColumns}])`]);
            const historyItem = {
                type: DataWranglerCommands.DropNa,
                description: DataScience.dataWranglerDropNaRowsOnColumnDescription().format(targetColumns),
                variableName: newVar,
                code: code,
                shouldAdd: true
            };
            return historyItem;
        } else {
            // Drop all rows that contain any Na value or drop all columns that contain any Na value
            const axis = req.target === 'row' ? '0' : '1';
            const code = this.createCode([`${newVar} = ${currVar}.dropna(axis=${axis})`]);
            const historyItem: IHistoryItem = {
                type: DataWranglerCommands.DropNa,
                description:
                    req.target === 'row'
                        ? DataScience.dataWranglerDropNaRowsDescription()
                        : DataScience.dataWranglerDropNaColumnsDescription(),
                variableName: newVar,
                code: code,
                shouldAdd: true
            };
            if (req.isPreview) {
                historyItem.isPreview = req.isPreview;
                // This preview doesn't actually change anything
                historyItem.previewCode = this.createCode([`${newVar} = ${currVar}`]);
            }
            return historyItem;
        }
    }

    private async normalizeColumn(req: INormalizeColumnRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        // MinMaxScaler code in pandas taken from https://stackoverflow.com/a/50028155
        // This setup code is needed for both preview code and normal code
        const setupCode = [
            `new_min, new_max = ${req.start.toString()}, ${req.end.toString()}`,
            `old_min, old_max = ${currVar}[['${req.targetColumn}']].min(), ${currVar}[['${req.targetColumn}']].max()`,
            `${newVar} = ${currVar}.copy()`
        ];

        // Generate the list of code strings that will add the preview column beside the original column
        const previewSpecificCodeList = this.generatePreviewCodeList(
            newVar,
            req.targetColumn,
            `(${currVar}[['${req.targetColumn}']] - old_min) / (old_max - old_min) * (new_max - new_min) + new_min`
        );

        // Create the entire preview code
        const previewCode = req.isPreview ? this.createCode([...setupCode, ...previewSpecificCodeList]) : '';

        // Create the entire real code that modifies the column
        const code = this.createCode([
            ...setupCode,
            `${newVar}['${req.targetColumn}'] = (${currVar}[['${req.targetColumn}']] - old_min) / (old_max - old_min) * (new_max - new_min) + new_min`
        ]);

        const historyItem = {
            type: DataWranglerCommands.NormalizeColumn,
            description: DataScience.dataWranglerNormalizeColumnDescription().format(req.targetColumn),
            variableName: newVar,
            code: code,
            previewCode: previewCode,
            isPreview: req.isPreview,
            shouldAdd: true
        };

        return historyItem;
    }

    private async fillNa(req: IFillNaRequest, currentVariableName: string): Promise<IHistoryItem> {
        const vars = this.cleanHistoryAndGetNewVariableName(currentVariableName);
        const currVar = vars.currentVariableName;
        const newVar = vars.newVariableName;

        const value = this.getValueBasedOnType(req.value, req.valueType);

        const targetColumns = this.generateStringListOfColumns(req.targetColumns);

        const setupCode = `${newVar} = ${currVar}.copy()`;

        // Create preview code
        const previewCodeList: string[] = [];

        // Need to go through each column and create a preview column for each of those columns and add it beside the original column
        if (req.isPreview) {
            req.targetColumns.forEach((col) => {
                const singleColumnPreviewCodeList = this.generatePreviewCodeList(
                    newVar,
                    col,
                    `${newVar}[['${col}']].fillna(value=${value})`
                );
                previewCodeList.push(...singleColumnPreviewCodeList);
            });
        }

        // Create preview code
        const previewCode = this.createCode([setupCode, ...previewCodeList]);

        // Create actual code
        // Create replacement dictionary where key is column and value is the value that will replace Na values
        const fillNaDict = req.targetColumns.map((c) => `'${c}': ${value}`).join(', ');
        const code = this.createCode([`${newVar} = ${currVar}.fillna({${fillNaDict}})`]);

        const historyItem = {
            type: DataWranglerCommands.FillNa,
            description: DataScience.dataWranglerFillNaDescription().format(value, targetColumns),
            variableName: newVar,
            code: code,
            previewCode: previewCode,
            isPreview: req.isPreview,
            shouldAdd: true
        };

        return historyItem;
    }

    private async respondToPreview(req: IRespondToPreviewRequest): Promise<IHistoryItem> {
        // Response to preview came in so we can tell slick grid that there is no preview anymore
        this.postMessage(DataWranglerMessages.OperationPreview, { type: undefined }).ignoreErrors();
        if (!this.historyList[this.historyList.length - 1].isPreview) {
            // Most recent operation was not a preview operation
            return {} as IHistoryItem;
        }
        if (req.doesAccept) {
            // User accepted preview
            // Change latest history item into non-preview and turn shouldAdd to false so we don't add it to history list again
            // Changing isPreview to false will run historyItem.code instead of historyItem.previewCode
            this.historyList[this.historyList.length - 1].isPreview = false;
            this.historyList[this.historyList.length - 1].shouldAdd = false;
            this.postMessage(DataWranglerMessages.UpdateHistoryList, this.historyList).ignoreErrors();
            return this.historyList[this.historyList.length - 1];
        } else {
            // Reject preview
            // Remove history item
            this.historyList.pop();
            this.postMessage(DataWranglerMessages.UpdateHistoryList, this.historyList).ignoreErrors();

            // Go back to latest variable and display its data
            const newVariableName = this.historyList[this.historyList.length - 1].variableName;
            await this.updateWithNewVariable(newVariableName);
            return {} as IHistoryItem;
        }
    }

    // Removes subsequent history items if current variable is an intermediate step
    // Then sets most recent variable to the action performed after that intermediate step
    private cleanHistoryAndGetNewVariableName(
        currentVariableName: string
    ): { currentVariableName: string; newVariableName: string } {
        // Get index from variable name
        const currVarIndex = Number(currentVariableName.substr(2));

        if (this.historyList[this.historyList.length - 1].isPreview) {
            // Latest operation was a preview operation
            this.postMessage(DataWranglerMessages.OperationPreview, { type: undefined }).ignoreErrors();
            const latestHistoryItem = this.historyList.pop();
            if (latestHistoryItem && latestHistoryItem.variableName === currentVariableName) {
                // Newest operation was branched off of the preview operation so we need to instead branch it off of
                // the stable operation before the preview operation
                const newCurrVar = Number(currVarIndex) - 1 === 0 ? 'df' : 'df' + (Number(currVarIndex) - 1).toString();
                return {
                    currentVariableName: newCurrVar,
                    newVariableName: currentVariableName
                };
            }
            // Newest operation was based off an intermediate stable operation
            return { currentVariableName, newVariableName: 'df' + (Number(currVarIndex) + 1).toString() };
        } else if (currentVariableName === 'df') {
            // currentVariableName is the original dataframe so the next one will be df1
            this.historyList = this.historyList.slice(0, 1);
            return { currentVariableName: 'df', newVariableName: 'df1' };
        } else {
            this.historyList = this.historyList.slice(0, currVarIndex + 1);
            return { currentVariableName, newVariableName: 'df' + (Number(currVarIndex) + 1).toString() };
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async computeCssStylings(operation: DataWranglerCommands): Promise<ICellCssStylesHash> {
        if (operation === DataWranglerCommands.DropNa) {
            const dataFrameInfo = await this.dataFrameInfoPromise;
            const columns = dataFrameInfo?.columns?.length;
            const nanRows = dataFrameInfo?.nanRows;

            if (!columns) {
                return {};
            }

            // Create individual row styling that will be given to each row
            // It is an object with the keys as all the column names
            const rowStyling: { [id: number]: string } = {};
            // Need to + 1 because slick grid adds an additional column
            for (let i = 0; i < columns + 1; i++) {
                rowStyling[i] = 'react-grid-cell-before';
            }
            // Create whole styling
            // It is an object with the keys as the rows and the values as the stylings defined above
            if (rowStyling !== undefined) {
                return (
                    nanRows?.reduce((result, row) => {
                        result[row] = rowStyling;
                        return result;
                    }, {} as ICellCssStylesHash) ?? {}
                );
            }
        } else if ([DataWranglerCommands.ReplaceAllColumn, DataWranglerCommands.FillNa].includes(operation)) {
            // These commands have the stylings created on the python side by looking at the diff between
            // a column and its (preview) counterpart
            const dataFrameInfo = await this.dataFrameInfoPromise;
            return dataFrameInfo?.previewDiffs ?? {};
        }
        return {};
    }

    private generateStringListOfColumns(columns: string[]) {
        return columns.map((col) => `'${col}'`).join(', ');
    }

    private generateColumnValueDict(columns: string[], value: string, hasQuotes: boolean) {
        const correctValue = hasQuotes ? `'${value}'` : value;
        return columns.map((col) => `'${col}': ${correctValue}`).join(', ');
    }

    private generatePreviewCodeList(newVar: string, col: string, columnGenerationCode: string) {
        return [
            // Find index of old column
            `idx = ${newVar}.columns.get_loc("${col}")`,
            // Generate preview column
            `data = ${columnGenerationCode}`,
            // Insert new preview column beside old column
            `${newVar}.insert(idx + 1, '${col} (preview)', data)`
        ];
    }

    private async executeNotebookCode(notebook: INotebook | undefined, code: string): Promise<boolean> {
        const cells = await notebook?.execute(code, '', 0, uuid(), undefined, false);
        const error = this.didCellError(cells);
        console.log('cells', cells);
        if (error) {
            void this.applicationShell.showErrorMessage(
                `The previous Data Wrangler operation failed. Running the python code for the operation resulted in a ${error.name}: ${error.description}`
            );
            return true;
        }
        return false;
    }

    private didCellError(cells: ICell[] | undefined): { name: string; description: string } | false {
        // Checks if cell has an error
        // If so, return the name and description of error.
        // If no error, return false
        if (cells === undefined || cells.length < 1) {
            return false;
        }
        const outputs = cells[0].data.outputs as nbformat.IOutput[];
        if (outputs.length > 0 && outputs[0].output_type === 'error') {
            return {
                name: outputs[0].ename as string,
                description: outputs[0].evalue as string
            };
        }
        return false;
    }

    private createCode(codeArr: string[], lineEnding = EOL): string {
        // Make sure to have lineEnding at end as well
        return codeArr.join(lineEnding) + lineEnding;
    }

    private getValueBasedOnType(value: string | number | boolean, type: ColumnType): string {
        switch (type) {
            case ColumnType.String:
                return `'${value}'`;
            case ColumnType.Number:
                return `${value}`;
            case ColumnType.Bool:
                return Boolean(value) ? 'True' : 'False';
        }
    }
}
