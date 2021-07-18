// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { CancellationToken, NotebookCell, NotebookDocument, Position, TextDocument, Uri, ViewColumn } from 'vscode';
import { Commands as DSCommands } from '../../datascience/constants';
import { IShowDataViewerFromVariablePanel } from '../../datascience/interactive-common/interactiveWindowTypes';
import { KernelConnectionMetadata } from '../../datascience/jupyter/kernels/types';
import { INotebookModel, ISwitchKernelOptions } from '../../datascience/types';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { CommandSource } from '../../testing/common/constants';
import { Channel } from './types';

export type CommandsWithoutArgs = keyof ICommandNameWithoutArgumentTypeMapping;

/**
 * Mapping between commands and list or arguments.
 * These commands do NOT have any arguments.
 * @interface ICommandNameWithoutArgumentTypeMapping
 */
interface ICommandNameWithoutArgumentTypeMapping {
    ['workbench.action.showCommands']: [];
    ['workbench.action.debug.continue']: [];
    ['workbench.action.debug.stepOver']: [];
    ['workbench.action.debug.stop']: [];
    ['workbench.action.reloadWindow']: [];
    ['workbench.action.closeActiveEditor']: [];
    ['editor.action.formatDocument']: [];
    ['editor.action.rename']: [];
    ['jupyter.selectJupyterInterpreter']: [];
    ['jupyterViewVariables.focus']: [];
    [DSCommands.RunCurrentCell]: [];
    [DSCommands.RunCurrentCellAdvance]: [];
    [DSCommands.CreateNewInteractive]: [];
    [DSCommands.UndoCells]: [];
    [DSCommands.RedoCells]: [];
    [DSCommands.RemoveAllCells]: [];
    [DSCommands.InterruptKernel]: [{ notebookEditor: { notebookUri: Uri } } | undefined];
    [DSCommands.RestartKernel]: [{ notebookEditor: { notebookUri: Uri } } | undefined];
    [DSCommands.NotebookEditorUndoCells]: [];
    [DSCommands.NotebookEditorRedoCells]: [];
    [DSCommands.NotebookEditorRemoveAllCells]: [];
    [DSCommands.NotebookEditorRestartKernel]: [];
    [DSCommands.NotebookEditorRunAllCells]: [];
    [DSCommands.NotebookEditorAddCellBelow]: [];
    [DSCommands.ExpandAllCells]: [];
    [DSCommands.CollapseAllCells]: [];
    [DSCommands.ExportOutputAsNotebook]: [];
    [DSCommands.AddCellBelow]: [];
    [DSCommands.CreateNewNotebook]: [];
    [DSCommands.EnableDebugLogging]: [];
    [DSCommands.ResetLoggingLevel]: [];
    [DSCommands.OpenVariableView]: [];
    [DSCommands.NotebookEditorToggleOutput]: [];
    [DSCommands.NotebookEditorKeybindExecuteCell]: [];
    [DSCommands.NotebookEditorKeybindRenderMarkdownAndSelectBelow]: [];
    [DSCommands.InteractiveClearAll]: [{ notebookEditor: { notebookUri: Uri } }];
    [DSCommands.InteractiveRemoveCell]: [NotebookCell];
    [DSCommands.InteractiveGoToCode]: [NotebookCell];
    [DSCommands.InteractiveCopyCell]: [NotebookCell];
    [DSCommands.InteractiveExportAsNotebook]: [{ notebookEditor: { notebookUri: Uri } }];
    [DSCommands.InteractiveExportAs]: [{ notebookEditor: { notebookUri: Uri } }];
    ['notebook.cell.quitEdit']: [];
    ['notebook.cell.executeAndSelectBelow']: [];
    ['notebook.cell.collapseCellOutput']: [];
    ['notebook.cell.expandCellOutput']: [];
}

/**
 * Mapping between commands and list of arguments.
 * Used to provide strong typing for command & args.
 * @export
 * @interface ICommandNameArgumentTypeMapping
 * @extends {ICommandNameWithoutArgumentTypeMapping}
 */
export interface ICommandNameArgumentTypeMapping extends ICommandNameWithoutArgumentTypeMapping {
    ['vscode.openWith']: [Uri, string];
    ['workbench.action.quickOpen']: [string];
    ['workbench.extensions.installExtension']: [Uri | 'ms-toolsai.jupyter'];
    ['workbench.action.files.openFolder']: [];
    ['workbench.action.openWorkspace']: [];
    ['extension.open']: [string];
    ['setContext']: [string, boolean] | ['jupyter.vscode.channel', Channel];
    ['jupyter.reloadVSCode']: [string];
    ['revealLine']: [{ lineNumber: number; at: 'top' | 'center' | 'bottom' }];
    ['python._loadLanguageServerExtension']: {}[];
    ['python.SelectAndInsertDebugConfiguration']: [TextDocument, Position, CancellationToken];
    ['vscode.open']: [Uri];
    ['notebook.execute']: [];
    ['notebook.cell.execute']:
        | []
        | [{ ranges: { start: number; end: number }[]; document?: Uri; autoReveal?: boolean }]; // TODO update this
    ['notebook.cell.insertCodeCellBelow']: [];
    ['notebook.undo']: [];
    ['notebook.redo']: [];
    ['notebook.toggleBreakpointMargin']: [NotebookDocument];
    ['vscode.open']: [Uri];
    ['workbench.action.files.saveAs']: [Uri];
    ['workbench.action.files.save']: [Uri];
    ['notebook.selectKernel']: [{ id: string; extension: string }] | [];
    ['undo']: [];
    ['interactive.open']: [{ preserveFocus?: boolean; viewColumn?: ViewColumn }, Uri | undefined, string | undefined];
    ['interactive.execute']: [string];
    [DSCommands.NotebookEditorInterruptKernel]: [Uri];
    [DSCommands.ExportFileAndOutputAsNotebook]: [Uri];
    [DSCommands.RunAllCells]: [Uri];
    [DSCommands.RunCell]: [Uri, number, number, number, number];
    [DSCommands.RunAllCellsAbove]: [Uri, number, number];
    [DSCommands.RunCellAndAllBelow]: [Uri, number, number];
    [DSCommands.RunAllCellsAbovePalette]: [];
    [DSCommands.RunCellAndAllBelowPalette]: [];
    [DSCommands.DebugCurrentCellPalette]: [];
    [DSCommands.RunToLine]: [Uri, number, number];
    [DSCommands.RunFromLine]: [Uri, number, number];
    [DSCommands.ImportNotebook]: [undefined | Uri, undefined | CommandSource];
    [DSCommands.ImportNotebookFile]: [undefined | Uri, undefined | CommandSource];
    [DSCommands.OpenNotebook]: [undefined | Uri, undefined | string, undefined | CommandSource];
    [DSCommands.OpenNotebookInPreviewEditor]: [undefined | Uri];
    [DSCommands.ExportFileAsNotebook]: [undefined | Uri, undefined | CommandSource];
    [DSCommands.ExecSelectionInInteractiveWindow]: [string | undefined];
    [DSCommands.RunFileInInteractiveWindows]: [Uri];
    [DSCommands.DebugFileInInteractiveWindows]: [Uri];
    [DSCommands.DebugCell]: [Uri, number, number, number, number];
    [DSCommands.DebugStepOver]: [];
    [DSCommands.DebugStop]: [];
    [DSCommands.DebugContinue]: [];
    [DSCommands.RunCurrentCellAndAddBelow]: [Uri];
    [DSCommands.InsertCellBelowPosition]: [];
    [DSCommands.InsertCellBelow]: [];
    [DSCommands.InsertCellAbove]: [];
    [DSCommands.DeleteCells]: [];
    [DSCommands.SelectCell]: [];
    [DSCommands.SelectCellContents]: [];
    [DSCommands.ExtendSelectionByCellAbove]: [];
    [DSCommands.ExtendSelectionByCellBelow]: [];
    [DSCommands.MoveCellsUp]: [];
    [DSCommands.MoveCellsDown]: [];
    [DSCommands.ChangeCellToMarkdown]: [];
    [DSCommands.ChangeCellToCode]: [];
    [DSCommands.GotoNextCellInFile]: [];
    [DSCommands.GotoPrevCellInFile]: [];
    [DSCommands.ScrollToCell]: [Uri, string];
    [DSCommands.ViewJupyterOutput]: [];
    [DSCommands.ExportAsPythonScript]: [string | undefined, Uri | undefined, PythonEnvironment | undefined];
    [DSCommands.ExportToHTML]: [string | undefined, Uri | undefined, string | undefined, PythonEnvironment | undefined];
    [DSCommands.ExportToPDF]: [string | undefined, Uri | undefined, string | undefined, PythonEnvironment | undefined];
    [DSCommands.Export]: [string | undefined, Uri | undefined, string | undefined, PythonEnvironment | undefined];
    [DSCommands.NativeNotebookExport]: [Uri | undefined];
    [DSCommands.SetJupyterKernel]: [KernelConnectionMetadata, Uri, undefined | Uri];
    [DSCommands.SwitchJupyterKernel]: [ISwitchKernelOptions | undefined] | [];
    [DSCommands.SelectJupyterCommandLine]: [undefined | Uri];
    [DSCommands.SaveNotebookNonCustomEditor]: [INotebookModel];
    [DSCommands.SaveAsNotebookNonCustomEditor]: [INotebookModel, Uri];
    [DSCommands.OpenNotebookNonCustomEditor]: [Uri];
    [DSCommands.LatestExtension]: [string];
    [DSCommands.EnableLoadingWidgetsFrom3rdPartySource]: [];
    [DSCommands.NotebookEditorExpandAllCells]: [];
    [DSCommands.NotebookEditorCollapseAllCells]: [];
    [DSCommands.CreateGitHubIssue]: [];
    [DSCommands.SubmitGitHubIssue]: [];
    [DSCommands.ShowDataViewer]: [IShowDataViewerFromVariablePanel];
    [DSCommands.RefreshDataViewer]: [];
    [DSCommands.ClearSavedJupyterUris]: [];
    [DSCommands.SelectJupyterURI]: [undefined, 'toolbar' | 'nativeNotebookStatusBar' | undefined];
    [DSCommands.SelectNativeJupyterUriFromToolBar]: [];
    [DSCommands.NotebookEditorKeybindSave]: [];
    [DSCommands.NotebookEditorKeybindUndo]: [];
    [DSCommands.DebugNotebook]: [];
    [DSCommands.RunByLine]: [NotebookCell];
    [DSCommands.RunByLineContinue]: [NotebookCell];
    [DSCommands.RunByLineStop]: [NotebookCell];

    // Data Wrangler
    [DSCommands.OpenDataWrangler]: [];
    [DSCommands.UpdateOrCreateDataWrangler]: [];
    [DSCommands.RefreshDataWrangler]: [];
    [DSCommands.UndoDataWrangler]: [];
}
