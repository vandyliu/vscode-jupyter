// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { join } from 'path';
import {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookController,
    NotebookDocument,
    NotebookEditor,
    NotebookKernelPreload,
    NotebookSelector,
    Uri,
    window
} from 'vscode';
import { ICommandManager, IVSCodeNotebook } from '../../common/application/types';
import { disposeAllDisposables } from '../../common/helpers';
import { traceInfo } from '../../common/logger';
import { IDisposable, IDisposableRegistry, IExtensionContext } from '../../common/types';
import { noop } from '../../common/utils/misc';
import { Commands } from '../constants';
import { getDescriptionOfKernelConnection, getDisplayNameOrNameOfKernelConnection } from '../jupyter/kernels/helpers';
import { IKernel, IKernelProvider, KernelConnectionMetadata } from '../jupyter/kernels/types';
import { PreferredRemoteKernelIdProvider } from '../notebookStorage/preferredRemoteKernelIdProvider';
import { KernelSocketInformation } from '../types';
import { JupyterNotebookView } from './constants';
import { traceCellMessage, trackKernelInfoInNotebookMetadata } from './helpers/helpers';
import { INotebookCommunication, INotebookKernelResolver } from './types';

class NotebookCommunication implements INotebookCommunication, IDisposable {
    private eventHandlerListening?: boolean;
    private pendingMessages: any[] = [];
    private readonly disposables: IDisposable[] = [];
    private readonly _onDidReceiveMessage = new EventEmitter<any>();
    constructor(public readonly editor: NotebookEditor, private readonly controller: NotebookController) {
        controller.onDidReceiveMessage(
            (e) => {
                if (e.editor === this.editor) {
                    // If the listeners haven't been hooked up, then dont fire the event (nothing listening).
                    // Instead buffer the messages and fire the events later.
                    if (this.eventHandlerListening) {
                        this.sendPendingMessages();
                        this._onDidReceiveMessage.fire(e.message);
                    } else {
                        this.pendingMessages.push(e.message);
                    }
                }
            },
            this,
            this.disposables
        );
    }
    public dispose() {
        disposeAllDisposables(this.disposables);
    }
    public get onDidReceiveMessage() {
        this.eventHandlerListening = true;
        // Immeidately after the event handler is added, send the pending messages.
        setTimeout(() => this.sendPendingMessages(), 0);
        return this._onDidReceiveMessage.event;
    }
    public postMessage(message: any): Thenable<boolean> {
        return this.controller.postMessage(message, this.editor);
    }
    public asWebviewUri(localResource: Uri): Uri {
        return this.controller.asWebviewUri(localResource);
    }
    private sendPendingMessages(){
        if (this.pendingMessages.length) {
            let message = this.pendingMessages.shift();
            while (message) {
                this._onDidReceiveMessage.fire(message);
                message = this.pendingMessages.shift();
            }
        }
    }
}
// IANHU: Rename file, rename class?
export class VSCodeNotebookController implements Disposable {
    private readonly _onNotebookControllerSelected: EventEmitter<{
        notebook: NotebookDocument;
        controller: VSCodeNotebookController;
    }>;
    private readonly disposables: IDisposable[] = [];
    private selected?: boolean;
    private notebookKernels = new WeakMap<NotebookDocument, IKernel>();
    /**
     * Public & used for purely for testing (in tests) purposes.
     */
    public static Communications = new WeakMap<NotebookDocument, NotebookCommunication[]>();
    private editorsInitailizedForWidgets = new WeakMap<NotebookEditor, NotebookCommunication>();
    private controller: NotebookController;
    private isDisposed = false;
    get id() {
        return this.controller.id;
    }

    get isPreferred() {
        return this.controller.isPreferred;
    }

    get label() {
        return this.controller.label;
    }

    // IANHU: Naming? Shouldn't expose?
    get connection() {
        return this.kernelConnection;
    }

    //get onDidChangeNotebookAssociation(): Event<{ notebook: NotebookDocument, selected: boolean }> {
    //return this.controller.onDidChangeNotebookAssociation;
    //}

    get onNotebookControllerSelected() {
        return this._onNotebookControllerSelected.event;
    }

    // IANHU: Passing the API in here? Not sure if that is right, but I like this class owning the create
    constructor(
        private readonly document: NotebookDocument,
        private readonly kernelConnection: KernelConnectionMetadata,
        private readonly notebookApi: IVSCodeNotebook,
        private readonly commandManager: ICommandManager,
        private readonly kernelProvider: IKernelProvider,
        private readonly preferredRemoteKernelIdProvider: PreferredRemoteKernelIdProvider,
        private readonly context: IExtensionContext,
        disposableRegistry: IDisposableRegistry,
        private readonly kernelResolver: INotebookKernelResolver
    ) {
        disposableRegistry.push(this);
        this._onNotebookControllerSelected = new EventEmitter<{
            notebook: NotebookDocument;
            controller: VSCodeNotebookController;
        }>();

        const selector: NotebookSelector = { viewType: JupyterNotebookView, pattern: document.uri.fsPath };
        const id: string = `${document.uri.toString()} - ${kernelConnection.id}`;
        this.controller = this.notebookApi.createNotebookController(
            id,
            selector,
            getDisplayNameOrNameOfKernelConnection(kernelConnection),
            this.handleExecution.bind(this),
            this.preloads()
        );
        // IANHU: Detail is missing
        this.controller.interruptHandler = this.handleInterrupt.bind(this);
        this.controller.onDidReceiveMessage(this.onDidReceiveMessage, this, this.disposables);
        this.controller.description = getDescriptionOfKernelConnection(kernelConnection);
        this.controller.hasExecutionOrder = true;
        // IANHU: Add our full supported language list here
        this.controller.supportedLanguages = ['python'];
        window.onDidChangeVisibleNotebookEditors(this.onDidChangeVisibleNotebookEditors, this, this.disposables);
        // Hook up to see when this NotebookController is selected by the UI
        this.controller.onDidChangeNotebookAssociation(this.onDidChangeNotebookAssociation, this, this.disposables);
    }

    //public onNotebookControllerSelected(): Event<{ notebook: NotebookDocument, controller: VSCodeNotebookController }> {
    //return this._onNotebookControllerSelected.event;
    //}

    public dispose() {
        // IANHU: Need to make sure to check our disposes here
        if (!this.isDisposed) {
            this.isDisposed = true;
            this.controller.dispose();
        }
        disposeAllDisposables(this.disposables);
    }

    // IANHU: Need this? Felt like I did to surface the right info
    private onDidChangeNotebookAssociation(event: { notebook: NotebookDocument; selected: boolean }) {
        this.selected = event.selected;
        if (event.selected) {
            this.initializeNotebookCommunications();
        } else {
            this.disposeNotebookCommunications();
        }
        // If this NotebookController was selected, fire off the event
        if (event.selected) {
            this._onNotebookControllerSelected.fire({ notebook: event.notebook, controller: this });
        }
    }

    private async onDidChangeVisibleNotebookEditors(e: NotebookEditor[]) {
        if (!this.selected) {
            return;
        }
        // Find any new editors that may be associated with the current notebook.
        // This can happen when users split editors.
        e.filter((item) => item.document === this.document).map((editor) =>
            this.initializeNotebookCommunication(editor)
        );
    }
    private initializeNotebookCommunications() {
        window.visibleNotebookEditors
            .filter((item) => item.document === this.document)
            .map((editor) => this.initializeNotebookCommunication(editor));
    }
    private disposeNotebookCommunications() {
        window.visibleNotebookEditors
            .filter((item) => item.document === this.document)
            .map((editor) => {
                const comms = this.editorsInitailizedForWidgets.get(editor);
                if (comms) {
                    comms.dispose();
                }
            });
    }
    private initializeNotebookCommunication(editor: NotebookEditor) {
        if (this.editorsInitailizedForWidgets.has(editor)) {
            return;
        }
        const comms = new NotebookCommunication(editor, this.controller);
        this.disposables.push(comms);
        this.editorsInitailizedForWidgets.set(editor, comms);
        VSCodeNotebookController.Communications.set(
            this.document,
            VSCodeNotebookController.Communications.get(this.document) || []
        );
        VSCodeNotebookController.Communications.get(this.document)!.push(comms);
        const { token } = new CancellationTokenSource();
        this.kernelResolver.resolveKernel(this.document, comms, token).catch(noop);
    }
    private onDidReceiveMessage(e: { editor: NotebookEditor; message: any }) {
        if (e.editor.document !== this.document) {
            return;
        }
    }
    private preloads(): NotebookKernelPreload[] {
        return [
            { uri: Uri.file(join(this.context.extensionPath, 'out', 'ipywidgets', 'dist', 'ipywidgets.js')) },
            {
                uri: Uri.file(
                    join(this.context.extensionPath, 'out', 'datascience-ui', 'ipywidgetsKernel', 'ipywidgetsKernel.js')
                )
            },
            {
                uri: Uri.file(
                    join(this.context.extensionPath, 'out', 'datascience-ui', 'notebook', 'fontAwesomeLoader.js')
                )
            }
        ];
    }

    private handleInterrupt() {
        this.document.getCells().forEach((cell) => traceCellMessage(cell, 'Cell cancellation requested'));
        this.commandManager
            .executeCommand(Commands.NotebookEditorInterruptKernel, this.document)
            .then(noop, (ex) => console.error(ex));
    }

    // IANHU: Is the async an issue here?
    private async handleExecution(cells: NotebookCell[]) {
        // When we receive a cell execute request, first ensure that the notebook is trusted.
        // If it isn't already trusted, block execution until the user trusts it.
        const isTrusted = await this.commandManager.executeCommand(Commands.TrustNotebook, this.document.uri);
        if (!isTrusted) {
            return;
        }
        // Notebook is trusted. Continue to execute cells
        traceInfo(`Execute Cells request ${cells.length} ${cells.map((cell) => cell.index).join(', ')}`);
        await Promise.all(cells.map((cell) => this.executeCell(this.document, cell)));
    }

    private executeCell(doc: NotebookDocument, cell: NotebookCell) {
        traceInfo(`Execute Cell ${cell.index} ${cell.notebook.uri.toString()} in kernelWithMetadata.ts`);
        const kernel = this.kernelProvider.getOrCreate(cell.notebook.uri, { metadata: this.kernelConnection });
        if (kernel) {
            this.updateKernelInfoInNotebookWhenAvailable(kernel, doc);
            return kernel.executeCell(cell);
        }
    }

    private updateKernelInfoInNotebookWhenAvailable(kernel: IKernel, doc: NotebookDocument) {
        if (this.notebookKernels.get(doc) === kernel) {
            return;
        }
        this.notebookKernels.set(doc, kernel);
        let kernelSocket: KernelSocketInformation | undefined;
        const handlerDisposables: IDisposable[] = [];
        // If the notebook is closed, dispose everything.
        this.notebookApi.onDidCloseNotebookDocument(
            (e) => {
                if (e === doc) {
                    disposeAllDisposables(handlerDisposables);
                }
            },
            this,
            handlerDisposables
        );
        const saveKernelInfo = () => {
            const kernelId = kernelSocket?.options.id;
            if (!kernelId) {
                return;
            }
            traceInfo(`Updating preferred kernel for remote notebook ${kernelId}`);
            this.preferredRemoteKernelIdProvider.storePreferredRemoteKernelId(doc.uri, kernelId).catch(noop);
        };

        const kernelDisposedDisposable = kernel.onDisposed(() => disposeAllDisposables(handlerDisposables));
        const subscriptionDisposables = kernel.kernelSocket.subscribe((item) => {
            kernelSocket = item;
            saveKernelInfo();
        });
        const statusChangeDisposable = kernel.onStatusChanged(() => {
            if (kernel.disposed || !kernel.info) {
                return;
            }
            const editor = this.notebookApi.notebookEditors.find((item) => item.document === doc);
            if (!editor || editor.kernel?.id !== this.id) {
                return;
            }
            trackKernelInfoInNotebookMetadata(doc, kernel.info);
            if (this.kernelConnection.kind === 'startUsingKernelSpec') {
                if (kernel.info.status === 'ok') {
                    saveKernelInfo();
                } else {
                    disposeAllDisposables(handlerDisposables);
                }
            } else {
                disposeAllDisposables(handlerDisposables);
            }
        });

        handlerDisposables.push({ dispose: () => subscriptionDisposables.unsubscribe() });
        handlerDisposables.push({ dispose: () => statusChangeDisposable.dispose() });
        handlerDisposables.push({ dispose: () => kernelDisposedDisposable?.dispose() });
    }
}
