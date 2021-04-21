// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    Event,
    NotebookDocument,
    NotebookEditor,
    NotebookKernelProvider,
    Uri
} from 'vscode';
import { VSCodeNotebookController } from './notebookExecutionHandler';

export const INotebookContentProvider = Symbol('INotebookContentProvider');

export const INotebookStatusBarProvider = Symbol('INotebookStatusBarProvider');

export const INotebookKernelProvider = Symbol('INotebookKernelProvider');
export interface INotebookKernelProvider extends NotebookKernelProvider {}

export const INotebookKernelResolver = Symbol('INotebookKernelResolver');

export const INotebookControllerManager = Symbol('INotebookControllerManager');
export interface INotebookControllerManager {
    readonly onNotebookControllerSelected: Event<{ notebook: NotebookDocument; controller: VSCodeNotebookController }>;
}

export interface INotebookKernelResolver {
    resolveKernel(document: NotebookDocument, webview: INotebookCommunication, token: CancellationToken): Promise<void>;
}

export enum CellOutputMimeTypes {
    error = 'application/x.notebook.error-traceback',
    stderr = 'application/x.notebook.stderr',
    stdout = 'application/x.notebook.stdout'
}

export interface INotebookCommunication {
    readonly editor: NotebookEditor;
    readonly onDidReceiveMessage: Event<any>;
    postMessage(message: any): Thenable<boolean>;
    asWebviewUri(localResource: Uri): Uri;
}
