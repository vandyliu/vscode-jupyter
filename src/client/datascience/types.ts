// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import type { nbformat } from '@jupyterlab/coreutils';
import type { Session } from '@jupyterlab/services';
import type { Kernel, KernelMessage } from '@jupyterlab/services/lib/kernel';
import type { JSONObject } from '@phosphor/coreutils';
import { Observable } from 'rxjs/Observable';
import { SemVer } from 'semver';
import {
    CancellationToken,
    CodeLens,
    CodeLensProvider,
    DebugConfiguration,
    DebugSession,
    Disposable,
    Event,
    HoverProvider,
    NotebookCell,
    NotebookDocument,
    NotebookEditor,
    QuickPickItem,
    Range,
    TextDocument,
    TextEditor,
    Uri,
    WebviewViewProvider
} from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import type { Data as WebSocketData } from 'ws';
import { ServerStatus } from '../../datascience-ui/interactive-common/mainState';
import { ICommandManager, IDebugService } from '../common/application/types';
import { ExecutionResult, ObservableExecutionResult, SpawnOptions } from '../common/process/types';
import { IAsyncDisposable, IDisposable, IJupyterSettings, InteractiveWindowMode, Resource } from '../common/types';
import { StopWatch } from '../common/utils/stopWatch';
import { PythonEnvironment } from '../pythonEnvironments/info';
import { JupyterCommands } from './constants';
import { IDataViewerDataProvider } from './data-viewing/types';
import { JupyterServerInfo } from './jupyter/jupyterConnection';
import { JupyterInstallError } from './jupyter/jupyterInstallError';
import { KernelConnectionMetadata } from './jupyter/kernels/types';
import { KernelStateEventArgs } from './notebookExtensibility';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PromiseFunction = (...any: any[]) => Promise<any>;

// Main interface
export const IDataScience = Symbol('IDataScience');
export interface IDataScience extends Disposable {
    activate(): Promise<void>;
}

export const IDataScienceCommandListener = Symbol('IDataScienceCommandListener');
export interface IDataScienceCommandListener {
    register(commandManager: ICommandManager): void;
}

export interface IRawConnection extends Disposable {
    readonly type: 'raw';
    readonly localLaunch: true;
    readonly valid: boolean;
    readonly displayName: string;
    disconnected: Event<number>;
}

export interface IJupyterConnection extends Disposable {
    readonly type: 'jupyter';
    readonly localLaunch: boolean;
    readonly valid: boolean;
    readonly displayName: string;
    disconnected: Event<number>;

    // Jupyter specific members
    readonly baseUrl: string;
    readonly token: string;
    readonly hostName: string;
    localProcExitCode: number | undefined;
    readonly rootDirectory: string; // Directory where the notebook server was started.
    readonly url?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAuthHeader?(): any; // Snould be a json object
}

export type INotebookProviderConnection = IRawConnection | IJupyterConnection;

export enum InterruptResult {
    Success = 'success',
    TimedOut = 'timeout',
    Restarted = 'restart'
}

// Information used to execute a notebook
export interface INotebookExecutionInfo {
    // Connection to what has provided our notebook, such as a jupyter
    // server or a raw ZMQ kernel
    connectionInfo: INotebookProviderConnection;
    uri: string | undefined; // Different from the connectionInfo as this is the setting used, not the result
    kernelConnectionMetadata?: KernelConnectionMetadata;
    workingDir: string | undefined;
    purpose: string | undefined; // Purpose this server is for
}

// Information used to launch a jupyter notebook server

// Information used to launch a notebook server
export interface INotebookServerLaunchInfo {
    connectionInfo: IJupyterConnection;
    uri: string | undefined; // Different from the connectionInfo as this is the setting used, not the result
    kernelConnectionMetadata?: KernelConnectionMetadata;
    workingDir: string | undefined;
    purpose: string | undefined; // Purpose this server is for
    disableUI?: boolean; // True if no UI should be brought up during the launch
}

export interface INotebookCompletion {
    matches: ReadonlyArray<string>;
    cursor: {
        start: number;
        end: number;
    };
    metadata: {
        _jupyter_types_experimental?: { end: number; start: number; text: string; type?: string }[];
    };
}

// Talks to a jupyter ipython kernel to retrieve data for cells
export const INotebookServer = Symbol('INotebookServer');
export interface INotebookServer extends IAsyncDisposable {
    readonly id: string;
    createNotebook(
        resource: Resource,
        identity: Uri,
        notebookMetadata?: nbformat.INotebookMetadata,
        kernelConnection?: KernelConnectionMetadata,
        cancelToken?: CancellationToken
    ): Promise<INotebook>;
    getNotebook(identity: Uri, cancelToken?: CancellationToken): Promise<INotebook | undefined>;
    connect(launchInfo: INotebookServerLaunchInfo, cancelToken?: CancellationToken): Promise<void>;
    getConnectionInfo(): IJupyterConnection | undefined;
    waitForConnect(): Promise<INotebookServerLaunchInfo | undefined>;
    shutdown(): Promise<void>;
}

// Provides a service to determine if raw notebook is supported or not
export const IRawNotebookSupportedService = Symbol('IRawNotebookSupportedService');
export interface IRawNotebookSupportedService {
    supported(): boolean;
}

// Provides notebooks that talk directly to kernels as opposed to a jupyter server
export const IRawNotebookProvider = Symbol('IRawNotebookProvider');
export interface IRawNotebookProvider extends IAsyncDisposable {
    supported(): Promise<boolean>;
    connect(connect: ConnectNotebookProviderOptions): Promise<IRawConnection | undefined>;
    createNotebook(
        identity: Uri,
        resource: Resource,
        disableUI?: boolean,
        notebookMetadata?: nbformat.INotebookMetadata,
        kernelConnection?: KernelConnectionMetadata,
        cancelToken?: CancellationToken
    ): Promise<INotebook>;
    getNotebook(identity: Uri, token?: CancellationToken): Promise<INotebook | undefined>;
}

// Provides notebooks that talk to jupyter servers
export const IJupyterNotebookProvider = Symbol('IJupyterNotebookProvider');
export interface IJupyterNotebookProvider {
    connect(options: ConnectNotebookProviderOptions): Promise<IJupyterConnection | undefined>;
    createNotebook(options: GetNotebookOptions): Promise<INotebook>;
    getNotebook(options: GetNotebookOptions): Promise<INotebook | undefined>;
    disconnect(options: ConnectNotebookProviderOptions): Promise<void>;
}

export interface INotebook extends IAsyncDisposable {
    readonly resource: Resource;
    readonly connection: INotebookProviderConnection | undefined;
    kernelSocket: Observable<KernelSocketInformation | undefined>;
    readonly identity: Uri;
    readonly status: ServerStatus;
    readonly disposed: boolean;
    readonly session: IJupyterSession; // Temporary. This just makes it easier to write a notebook that works with VS code types.
    onSessionStatusChanged: Event<ServerStatus>;
    onDisposed: Event<void>;
    onKernelChanged: Event<KernelConnectionMetadata>;
    onKernelRestarted: Event<void>;
    onKernelInterrupted: Event<void>;
    onDidFinishExecuting?: Event<ICell>;
    clear(id: string): void;
    executeObservable(code: string, file: string, line: number, id: string, silent: boolean): Observable<ICell[]>;
    execute(
        code: string,
        file: string,
        line: number,
        id: string,
        cancelToken?: CancellationToken,
        silent?: boolean
    ): Promise<ICell[]>;
    inspect(code: string, offsetInCode?: number, cancelToken?: CancellationToken): Promise<JSONObject>;
    getCompletion(
        cellCode: string,
        offsetInCode: number,
        cancelToken?: CancellationToken
    ): Promise<INotebookCompletion>;
    restartKernel(timeoutInMs: number): Promise<void>;
    runInitialSetup(): Promise<void>;
    waitForIdle(timeoutInMs: number): Promise<void>;
    interruptKernel(timeoutInMs: number): Promise<InterruptResult>;
    setLaunchingFile(file: string): Promise<void>;
    getSysInfo(): Promise<ICell | undefined>;
    requestKernelInfo(): Promise<KernelMessage.IInfoReplyMsg>;
    setMatplotLibStyle(useDark: boolean): Promise<void>;
    getMatchingInterpreter(): PythonEnvironment | undefined;
    /**
     * Gets the metadata that's used to start/connect to a Kernel.
     */
    getKernelConnection(): KernelConnectionMetadata | undefined;
    /**
     * Sets the metadata that's used to start/connect to a Kernel.
     * Doing so results in a new kernel being started (i.e. a change in the kernel).
     */
    setKernelConnection(connectionMetadata: KernelConnectionMetadata, timeoutMS: number): Promise<void>;
    getLoggers(): INotebookExecutionLogger[];
    registerIOPubListener(listener: (msg: KernelMessage.IIOPubMessage, requestId: string) => void): void;
    registerCommTarget(
        targetName: string,
        callback: (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg) => void | PromiseLike<void>
    ): void;
    sendCommMessage(
        buffers: (ArrayBuffer | ArrayBufferView)[],
        content: { comm_id: string; data: JSONObject; target_name: string | undefined },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        msgId: any
    ): Kernel.IShellFuture<
        KernelMessage.IShellMessage<'comm_msg'>,
        KernelMessage.IShellMessage<KernelMessage.ShellMessageType>
    >;
    requestCommInfo(content: KernelMessage.ICommInfoRequestMsg['content']): Promise<KernelMessage.ICommInfoReplyMsg>;
    registerMessageHook(
        msgId: string,
        hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>
    ): void;
    removeMessageHook(msgId: string, hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>): void;
}

// Options for connecting to a notebook provider
export type ConnectNotebookProviderOptions = {
    getOnly?: boolean;
    disableUI?: boolean;
    localOnly?: boolean;
    token?: CancellationToken;
    resource: Resource;
    metadata?: nbformat.INotebookMetadata;
    onConnectionMade?(): void; // Optional callback for when the first connection is made
};

export interface INotebookServerOptions {
    uri?: string;
    resource: Resource;
    usingDarkTheme?: boolean;
    skipUsingDefaultConfig?: boolean;
    workingDir?: string;
    purpose: string;
    metadata?: nbformat.INotebookMetadata;
    kernelConnection?: KernelConnectionMetadata;
    skipSearchingForKernel?: boolean;
    allowUI(): boolean;
}

export interface IHoverProvider extends HoverProvider {}
export const IHoverProvider = Symbol('IHoverProvider');

export const INotebookExecutionLogger = Symbol('INotebookExecutionLogger');
export interface INotebookExecutionLogger extends IDisposable {
    preExecute(cell: ICell, silent: boolean): Promise<void>;
    postExecute(cell: ICell, silent: boolean, language: string, resource: Uri): Promise<void>;
    nativePostExecute?(cell: NotebookCell): Promise<void>;
    onKernelStarted(resource: Uri): void;
    onKernelRestarted(resource: Uri): void;
    preHandleIOPub?(msg: KernelMessage.IIOPubMessage): KernelMessage.IIOPubMessage;
}

export const IJupyterExecution = Symbol('IJupyterExecution');
export interface IJupyterExecution extends IAsyncDisposable {
    serverStarted: Event<INotebookServerOptions | undefined>;
    isNotebookSupported(cancelToken?: CancellationToken): Promise<boolean>;
    isSpawnSupported(cancelToken?: CancellationToken): Promise<boolean>;
    connectToNotebookServer(
        options?: INotebookServerOptions,
        cancelToken?: CancellationToken
    ): Promise<INotebookServer | undefined>;
    spawnNotebook(file: string): Promise<void>;
    getUsableJupyterPython(cancelToken?: CancellationToken): Promise<PythonEnvironment | undefined>;
    getServer(options?: INotebookServerOptions): Promise<INotebookServer | undefined>;
    getNotebookError(): Promise<string>;
    refreshCommands(): Promise<void>;
}

export const IJupyterDebugger = Symbol('IJupyterDebugger');
export interface IJupyterDebugger {
    readonly isRunningByLine: boolean;
    startRunByLine(notebook: INotebook, cellHashFileName: string): Promise<void>;
    startDebugging(notebook: INotebook): Promise<void>;
    stopDebugging(notebook: INotebook): Promise<void>;
    onRestart(notebook: INotebook): void;
}

export interface IJupyterPasswordConnectInfo {
    requestHeaders?: HeadersInit;
    remappedBaseUrl?: string;
    remappedToken?: string;
}

export const IJupyterPasswordConnect = Symbol('IJupyterPasswordConnect');
export interface IJupyterPasswordConnect {
    getPasswordConnectionInfo(url: string): Promise<IJupyterPasswordConnectInfo | undefined>;
}

export const IJupyterSession = Symbol('IJupyterSession');
export interface IJupyterSession extends IAsyncDisposable {
    onSessionStatusChanged: Event<ServerStatus>;
    onIOPubMessage: Event<KernelMessage.IIOPubMessage>;
    readonly status: ServerStatus;
    readonly workingDirectory: string;
    readonly kernelSocket: Observable<KernelSocketInformation | undefined>;
    readonly sessionId: string;
    restart(timeout: number): Promise<void>;
    interrupt(timeout: number): Promise<void>;
    waitForIdle(timeout: number): Promise<void>;
    requestExecute(
        content: KernelMessage.IExecuteRequestMsg['content'],
        disposeOnDone?: boolean,
        metadata?: JSONObject
    ): Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg> | undefined;
    requestDebug(
        content: KernelMessage.IDebugRequestMsg['content'],
        disposeOnDone?: boolean
    ): Kernel.IControlFuture<KernelMessage.IDebugRequestMsg, KernelMessage.IDebugReplyMsg> | undefined;
    requestComplete(
        content: KernelMessage.ICompleteRequestMsg['content']
    ): Promise<KernelMessage.ICompleteReplyMsg | undefined>;
    requestInspect(
        content: KernelMessage.IInspectRequestMsg['content']
    ): Promise<KernelMessage.IInspectReplyMsg | undefined>;
    sendInputReply(content: string): void;
    changeKernel(resource: Resource, kernelConnection: KernelConnectionMetadata, timeoutMS: number): Promise<void>;
    registerCommTarget(
        targetName: string,
        callback: (comm: Kernel.IComm, msg: KernelMessage.ICommOpenMsg) => void | PromiseLike<void>
    ): void;
    sendCommMessage(
        buffers: (ArrayBuffer | ArrayBufferView)[],
        content: { comm_id: string; data: JSONObject; target_name: string | undefined },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        msgId: any
    ): Kernel.IShellFuture<
        KernelMessage.IShellMessage<'comm_msg'>,
        KernelMessage.IShellMessage<KernelMessage.ShellMessageType>
    >;
    requestCommInfo(content: KernelMessage.ICommInfoRequestMsg['content']): Promise<KernelMessage.ICommInfoReplyMsg>;
    registerMessageHook(
        msgId: string,
        hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>
    ): void;
    removeMessageHook(msgId: string, hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>): void;
    requestKernelInfo(): Promise<KernelMessage.IInfoReplyMsg>;
    shutdown(): Promise<void>;
}

export type ISessionWithSocket = Session.ISession & {
    // The resource associated with this session.
    resource: Resource;
    // Whether this is a remote session that we attached to.
    isRemoteSession?: boolean;
    // Socket information used for hooking messages to the kernel
    kernelSocketInformation?: KernelSocketInformation;
    kernelConnectionMetadata?: KernelConnectionMetadata;
};

export const IJupyterSessionManagerFactory = Symbol('IJupyterSessionManagerFactory');
export interface IJupyterSessionManagerFactory {
    readonly onRestartSessionCreated: Event<Kernel.IKernelConnection>;
    readonly onRestartSessionUsed: Event<Kernel.IKernelConnection>;
    create(connInfo: IJupyterConnection, failOnPassword?: boolean): Promise<IJupyterSessionManager>;
}

export interface IJupyterSessionManager extends IAsyncDisposable {
    readonly onRestartSessionCreated: Event<Kernel.IKernelConnection>;
    readonly onRestartSessionUsed: Event<Kernel.IKernelConnection>;
    startNew(
        resource: Resource,
        kernelConnection: KernelConnectionMetadata | undefined,
        workingDirectory: string,
        cancelToken?: CancellationToken,
        disableUI?: boolean
    ): Promise<IJupyterSession>;
    getKernelSpecs(): Promise<IJupyterKernelSpec[]>;
    getConnInfo(): IJupyterConnection;
    getRunningKernels(): Promise<IJupyterKernel[]>;
    getRunningSessions(): Promise<Session.IModel[]>;
}

export interface IJupyterKernel {
    /**
     * Id of an existing (active) Kernel from an active session.
     *
     * @type {string}
     * @memberof IJupyterKernel
     */
    id?: string;
    name: string;
    lastActivityTime: Date;
    numberOfConnections: number;
}

export interface IJupyterKernelSpec {
    /**
     * Id of an existing (active) Kernel from an active session.
     *
     * @type {string}
     * @memberof IJupyterKernel
     */
    id?: string;
    name: string;
    language?: string;
    path: string;
    env?: NodeJS.ProcessEnv | undefined;
    /**
     * Kernel display name.
     *
     * @type {string}
     * @memberof IJupyterKernelSpec
     */
    readonly display_name: string;
    /**
     * A dictionary of additional attributes about this kernel; used by clients to aid in kernel selection.
     * Optionally storing the interpreter information in the metadata (helping extension search for kernels that match an interpereter).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly metadata?: Record<string, any> & { interpreter?: Partial<PythonEnvironment>; originalSpecFile?: string };
    readonly argv: string[];
    /**
     * Optionally where this kernel spec json is located on the local FS.
     */
    specFile?: string;
    /**
     * Optionally the Interpreter this kernel spec belongs to.
     * You can have kernel specs that are scoped to an interpreter.
     * E.g. if you have Python in `c:\Python\Python3.8`
     * Then you could have kernels in `<sys.prefix folder for this interpreter>\share\jupyter\kernels`
     * Plenty of conda packages ship kernels in this manner (beakerx, etc).
     */
    interpreterPath?: string;
    readonly interrupt_mode?: 'message' | 'signal';
}

export const INotebookImporter = Symbol('INotebookImporter');
export interface INotebookImporter extends Disposable {
    importFromFile(contentsFile: Uri, interpreter: PythonEnvironment): Promise<string>;
}

export const INotebookExporter = Symbol('INotebookExporter');
export interface INotebookExporter extends Disposable {
    translateToNotebook(
        cells: ICell[],
        directoryChange?: string,
        kernelSpec?: nbformat.IKernelspecMetadata
    ): Promise<nbformat.INotebookContent | undefined>;
    exportToFile(cells: ICell[], file: string, showOpenPrompt?: boolean): Promise<void>;
}

export const IInteractiveWindowProvider = Symbol('IInteractiveWindowProvider');
export interface IInteractiveWindowProvider {
    /**
     * The active interactive window if it has the focus.
     */
    readonly activeWindow: IInteractiveWindow | undefined;
    /**
     * List of open interactive windows
     */
    readonly windows: ReadonlyArray<IInteractiveWindow>;
    /**
     * Event fired when the active interactive window changes
     */
    readonly onDidChangeActiveInteractiveWindow: Event<IInteractiveWindow | undefined>;
    /**
     * Event fired when an interactive window is created
     */
    readonly onDidCreateInteractiveWindow: Event<IInteractiveWindow>;
    /**
     * Gets or creates a new interactive window and associates it with the owner. If no owner, marks as a non associated.
     * @param owner file that started this interactive window
     */
    getOrCreate(owner: Resource): Promise<IInteractiveWindow>;
}

export const IDataScienceErrorHandler = Symbol('IDataScienceErrorHandler');
export interface IDataScienceErrorHandler {
    handleError(err: Error): Promise<void>;
}

/**
 * Given a local resource this will convert the Uri into a form such that it can be used in a WebView.
 */
export interface ILocalResourceUriConverter {
    /**
     * Root folder that scripts should be copied to.
     */
    readonly rootScriptFolder: Uri;
    /**
     * Convert a uri for the local file system to one that can be used inside webviews.
     *
     * Webviews cannot directly load resources from the workspace or local file system using `file:` uris. The
     * `asWebviewUri` function takes a local `file:` uri and converts it into a uri that can be used inside of
     * a webview to load the same resource:
     *
     * ```ts
     * webview.html = `<img src="${webview.asWebviewUri(vscode.Uri.file('/Users/codey/workspace/cat.gif'))}">`
     * ```
     */
    asWebviewUri(localResource: Uri): Promise<Uri>;
}

export interface IInteractiveBase extends Disposable {
    notebook?: INotebook;
    startProgress(): void;
    stopProgress(): void;
    undoCells(): void;
    redoCells(): void;
    toggleOutput?(): void;
    removeAllCells(): void;
    interruptKernel(): Promise<void>;
    restartKernel(): Promise<void>;
    hasCell(id: string): Promise<boolean>;
}

export interface IInteractiveWindow extends IInteractiveBase {
    readonly onDidChangeViewState: Event<void>;
    readonly owner: Resource;
    readonly submitters: Uri[];
    readonly identity: Uri;
    readonly title: string;
    readonly notebookUri?: Uri;
    readonly readyPromise?: Promise<NotebookEditor>;
    closed: Event<IInteractiveWindow>;
    addCode(code: string, file: Uri, line: number, editor?: TextEditor, runningStopWatch?: StopWatch): Promise<boolean>;
    addMessage(message: string): Promise<void>;
    debugCode(
        code: string,
        file: Uri,
        line: number,
        editor?: TextEditor,
        runningStopWatch?: StopWatch
    ): Promise<boolean>;
    expandAllCells(): void;
    collapseAllCells(): void;
    exportCells(): void;
    scrollToCell(id: string): void;
    exportAs(cells?: ICell[]): void;
    export(cells?: ICell[]): void;
}

export interface IInteractiveWindowLoadable extends IInteractiveWindow {
    changeMode(newMode: InteractiveWindowMode): void;
}

// For native editing, the provider acts like the IDocumentManager for normal docs
export const INotebookEditorProvider = Symbol('INotebookEditorProvider');
export interface INotebookEditorProvider {
    readonly activeEditor: INotebookEditor | undefined;
    readonly editors: INotebookEditor[];
    readonly onDidOpenNotebookEditor: Event<INotebookEditor>;
    readonly onDidChangeActiveNotebookEditor: Event<INotebookEditor | undefined>;
    readonly onDidCloseNotebookEditor: Event<INotebookEditor>;
    open(file: Uri): Promise<INotebookEditor>;
    show(file: Uri): Promise<INotebookEditor | undefined>;
    createNew(options?: { contents?: string; defaultCellLanguage?: string }): Promise<INotebookEditor>;
}

// For native editing, the INotebookEditor acts like a TextEditor and a TextDocument together
export const INotebookEditor = Symbol('INotebookEditor');
export interface INotebookEditor extends Disposable, IInteractiveBase {
    readonly closed: Event<INotebookEditor>;
    readonly executed?: Event<INotebookEditor>;
    /**
     * Is this notebook representing an untitled file which has never been saved yet.
     */
    readonly isUntitled: boolean;
    readonly file: Uri;
    readonly model?: INotebookModel;
    readonly notebookMetadata: nbformat.INotebookMetadata | undefined;
    notebook?: INotebook;
    runAllCells(): void;
    addCellBelow(): void;
    undoCells(): void;
    redoCells(): void;
    removeAllCells(): void;
    expandAllCells(): void;
    collapseAllCells(): void;
    interruptKernel(): Promise<void>;
    restartKernel(): Promise<void>;
    syncAllCells(): Promise<void>;
    getContent(): string;
}

export const INotebookExtensibility = Symbol('INotebookExtensibility');

export interface INotebookExtensibility {
    readonly onKernelStateChange: Event<KernelStateEventArgs>;
}

// Wraps the vscode CodeLensProvider base class
export const IDataScienceCodeLensProvider = Symbol('IDataScienceCodeLensProvider');
export interface IDataScienceCodeLensProvider extends CodeLensProvider {
    getCodeWatcher(document: TextDocument): ICodeWatcher | undefined;
}

// Wraps the Code Watcher API
export const ICodeWatcher = Symbol('ICodeWatcher');
export interface ICodeWatcher extends IDisposable {
    readonly uri: Uri | undefined;
    codeLensUpdated: Event<void>;
    setDocument(document: TextDocument): void;
    getVersion(): number;
    getCodeLenses(): CodeLens[];
    getCachedSettings(): IJupyterSettings | undefined;
    runAllCells(): Promise<void>;
    runCell(range: Range): Promise<void>;
    debugCell(range: Range): Promise<void>;
    runCurrentCell(): Promise<void>;
    runCurrentCellAndAdvance(): Promise<void>;
    runSelectionOrLine(activeEditor: TextEditor | undefined, text: string | undefined): Promise<void>;
    runToLine(targetLine: number): Promise<void>;
    runFromLine(targetLine: number): Promise<void>;
    runAllCellsAbove(stopLine: number, stopCharacter: number): Promise<void>;
    runCellAndAllBelow(startLine: number, startCharacter: number): Promise<void>;
    runFileInteractive(): Promise<void>;
    debugFileInteractive(): Promise<void>;
    addEmptyCellToBottom(): Promise<void>;
    runCurrentCellAndAddBelow(): Promise<void>;
    insertCellBelowPosition(): void;
    insertCellBelow(): void;
    insertCellAbove(): void;
    deleteCells(): void;
    selectCell(): void;
    selectCellContents(): void;
    extendSelectionByCellAbove(): void;
    extendSelectionByCellBelow(): void;
    moveCellsUp(): Promise<void>;
    moveCellsDown(): Promise<void>;
    changeCellToMarkdown(): void;
    changeCellToCode(): void;
    debugCurrentCell(): Promise<void>;
    gotoNextCell(): void;
    gotoPreviousCell(): void;
}

export const ICodeLensFactory = Symbol('ICodeLensFactory');
export interface ICodeLensFactory {
    updateRequired: Event<void>;
    createCodeLenses(document: TextDocument): CodeLens[];
    getCellRanges(document: TextDocument): ICellRange[];
}

export enum CellState {
    editing = -1,
    init = 0,
    executing = 1,
    finished = 2,
    error = 3
}

// Basic structure for a cell from a notebook
export interface ICell {
    id: string; // This value isn't unique. File and line are needed too.
    file: string;
    line: number;
    state: CellState;
    data: nbformat.ICodeCell | nbformat.IRawCell | nbformat.IMarkdownCell | IMessageCell;
    extraLines?: number[];
}

// CellRange is used as the basis for creating new ICells.
// Was only intended to aggregate together ranges to create an ICell
// However the "range" aspect is useful when working with plain text document
// Ultimately, it would probably be ideal to be ICell and change line to range.
// Specificially see how this is being used for the ICodeLensFactory to
// provide cells for the CodeWatcher to use.
export interface ICellRange {
    range: Range;
    title: string;
    cell_type: string;
}

export interface IInteractiveWindowInfo {
    cellCount: number;
    undoCount: number;
    redoCount: number;
    selectedCell: string | undefined;
}

export interface IMessageCell extends nbformat.IBaseCell {
    cell_type: 'messages';
    messages: string[];
}

export const ICodeCssGenerator = Symbol('ICodeCssGenerator');
export interface ICodeCssGenerator {
    generateThemeCss(resource: Resource, isDark: boolean, theme: string): Promise<string>;
}

export const IThemeFinder = Symbol('IThemeFinder');
export interface IThemeFinder {
    findThemeRootJson(themeName: string): Promise<string | undefined>;
    isThemeDark(themeName: string): Promise<boolean | undefined>;
}

export const IStatusProvider = Symbol('IStatusProvider');
export interface IStatusProvider {
    // call this function to set the new status on the active
    // interactive window. Dispose of the returned object when done.
    set(
        message: string,
        showInWebView: boolean,
        timeout?: number,
        canceled?: () => void,
        interactivePanel?: IInteractiveBase
    ): Disposable;

    // call this function to wait for a promise while displaying status
    waitWithStatus<T>(
        promise: () => Promise<T>,
        message: string,
        showInWebView: boolean,
        timeout?: number,
        canceled?: () => void,
        interactivePanel?: IInteractiveBase
    ): Promise<T>;
}

export interface IJupyterCommand {
    interpreter(): Promise<PythonEnvironment | undefined>;
    execObservable(args: string[], options: SpawnOptions): Promise<ObservableExecutionResult<string>>;
    exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>>;
}

export const IJupyterCommandFactory = Symbol('IJupyterCommandFactory');
export interface IJupyterCommandFactory {
    createInterpreterCommand(
        command: JupyterCommands,
        moduleName: string,
        args: string[],
        interpreter: PythonEnvironment,
        isActiveInterpreter: boolean
    ): IJupyterCommand;
    createProcessCommand(exe: string, args: string[]): IJupyterCommand;
}

// Config settings we pass to our react code
export type FileSettings = {
    autoSaveDelay: number;
    autoSave: 'afterDelay' | 'off' | 'onFocusChange' | 'onWindowChange';
};

export interface IJupyterExtraSettings extends IJupyterSettings {
    extraSettings: {
        editor: {
            cursor: string;
            cursorBlink: string;
            fontLigatures: boolean;
            autoClosingBrackets: string;
            autoClosingQuotes: string;
            autoSurround: string;
            autoIndent: boolean;
            scrollBeyondLastLine: boolean;
            horizontalScrollbarSize: number;
            verticalScrollbarSize: number;
            fontSize: number;
            fontFamily: string;
        };
        theme: string;
        hasPythonExtension: boolean;
    };
    intellisenseOptions: {
        quickSuggestions: {
            other: boolean;
            comments: boolean;
            strings: boolean;
        };
        acceptSuggestionOnEnter: boolean | 'on' | 'smart' | 'off';
        quickSuggestionsDelay: number;
        suggestOnTriggerCharacters: boolean;
        tabCompletion: boolean | 'on' | 'off' | 'onlySnippets';
        suggestLocalityBonus: boolean;
        suggestSelection: 'first' | 'recentlyUsed' | 'recentlyUsedByPrefix';
        wordBasedSuggestions: boolean;
        parameterHintsEnabled: boolean;
    };
}

// Get variables from the currently running active Jupyter server or debugger
// Note: This definition is used implicitly by getJupyterVariableValue.py file
// Changes here may need to be reflected there as well
export interface IJupyterVariable {
    name: string;
    value: string | undefined;
    executionCount?: number;
    supportsDataExplorer: boolean;
    type: string;
    size: number;
    shape: string;
    dataDimensionality?: number;
    count: number;
    truncated: boolean;
    columns?: { key: string; type: string }[];
    rowCount?: number;
    indexColumn?: string;
    maximumRowChunkSize?: number;
    fileName?: string;
}

export const IJupyterVariableDataProvider = Symbol('IJupyterVariableDataProvider');
export interface IJupyterVariableDataProvider extends IDataViewerDataProvider {
    setDependencies(variable: IJupyterVariable, notebook?: INotebook): void;
}

export const IJupyterVariableDataProviderFactory = Symbol('IJupyterVariableDataProviderFactory');
export interface IJupyterVariableDataProviderFactory {
    create(variable: IJupyterVariable, notebook?: INotebook): Promise<IJupyterVariableDataProvider>;
}

export const IJupyterVariables = Symbol('IJupyterVariables');
export interface IJupyterVariables {
    readonly refreshRequired: Event<void>;
    getVariables(request: IJupyterVariablesRequest, notebook?: INotebook): Promise<IJupyterVariablesResponse>;
    getFullVariable(
        variable: IJupyterVariable,
        notebook?: INotebook,
        cancelToken?: CancellationToken
    ): Promise<IJupyterVariable>;
    getDataFrameInfo(
        targetVariable: IJupyterVariable,
        notebook?: INotebook,
        sliceExpression?: string,
        isRefresh?: boolean
    ): Promise<IJupyterVariable>;
    getDataFrameRows(
        targetVariable: IJupyterVariable,
        start: number,
        end: number,
        notebook?: INotebook,
        sliceExpression?: string
    ): Promise<JSONObject>;
    getMatchingVariable(
        name: string,
        notebook?: INotebook,
        cancelToken?: CancellationToken
    ): Promise<IJupyterVariable | undefined>;
    // This is currently only defined in kernelVariables.ts
    getVariableProperties?(name: string, notebook?: INotebook, cancelToken?: CancellationToken): Promise<JSONObject>;
}

export interface IConditionalJupyterVariables extends IJupyterVariables {
    readonly active: boolean;
}

// Request for variables
export interface IJupyterVariablesRequest {
    executionCount: number;
    refreshCount: number;
    sortColumn: string;
    sortAscending: boolean;
    startIndex: number;
    pageSize: number;
}

// Response to a request
export interface IJupyterVariablesResponse {
    executionCount: number;
    totalCount: number;
    pageStartIndex: number;
    pageResponse: IJupyterVariable[];
    refreshCount: number;
}

export const IPlotViewerProvider = Symbol('IPlotViewerProvider');
export interface IPlotViewerProvider {
    showPlot(imageHtml: string): Promise<void>;
}
export const IPlotViewer = Symbol('IPlotViewer');

export interface IPlotViewer extends IDisposable {
    closed: Event<IPlotViewer>;
    removed: Event<number>;
    addPlot(imageHtml: string): Promise<void>;
    show(): Promise<void>;
}

export interface ISourceMapMapping {
    line: number;
    endLine: number;
    runtimeSource: { path: string };
    runtimeLine: number;
}

export interface ISourceMapRequest {
    source: { path: string };
    pydevdSourceMaps: ISourceMapMapping[];
}

export interface ICellHash {
    line: number; // 1 based
    endLine: number; // 1 based and inclusive
    runtimeLine: number; // Line in the jupyter source to start at
    hash: string;
    executionCount: number;
    id: string; // Cell id as sent to jupyter
    timestamp: number;
}

export interface IFileHashes {
    file: string;
    hashes: ICellHash[];
}

export const ICellHashListener = Symbol('ICellHashListener');
export interface ICellHashListener {
    hashesUpdated(hashes: IFileHashes[]): Promise<void>;
}

export const ICellHashProvider = Symbol('ICellHashProvider');
export interface ICellHashProvider {
    updated: Event<void>;
    getHashes(): IFileHashes[];
    getExecutionCount(): number;
    incExecutionCount(): void;
    generateHashFileName(cell: ICell, executionCount: number): string;
}

export interface IDebugLocation {
    fileName: string;
    lineNumber: number;
    column: number;
}

export const IDebugLocationTracker = Symbol('IDebugLocationTracker');
export interface IDebugLocationTracker {
    updated: Event<void>;
    getLocation(debugSession: DebugSession): IDebugLocation | undefined;
}

export const IJupyterSubCommandExecutionService = Symbol('IJupyterSubCommandExecutionService');
/**
 * Responsible for execution of jupyter subcommands such as `notebook`, `nbconvert`, etc.
 * The executed code is as follows `python -m jupyter <subcommand>`.
 *
 * @export
 * @interface IJupyterSubCommandExecutionService
 */
export interface IJupyterSubCommandExecutionService {
    /**
     * Checks whether notebook is supported.
     *
     * @param {CancellationToken} [cancelToken]
     * @returns {Promise<boolean>}
     * @memberof IJupyterSubCommandExecutionService
     */
    isNotebookSupported(cancelToken?: CancellationToken): Promise<boolean>;
    /**
     * Error message indicating why jupyter notebook isn't supported.
     *
     * @returns {Promise<string>}
     * @memberof IJupyterSubCommandExecutionService
     */
    getReasonForJupyterNotebookNotBeingSupported(): Promise<string>;
    /**
     * Used to refresh the command finder.
     *
     * @returns {Promise<void>}
     * @memberof IJupyterSubCommandExecutionService
     */
    refreshCommands(): Promise<void>;
    /**
     * Gets the interpreter to be used for starting of jupyter server.
     *
     * @param {CancellationToken} [token]
     * @returns {(Promise<PythonEnvironment | undefined>)}
     * @memberof IJupyterInterpreterService
     */
    getSelectedInterpreter(token?: CancellationToken): Promise<PythonEnvironment | undefined>;
    /**
     * Starts the jupyter notebook server
     *
     * @param {string[]} notebookArgs
     * @param {SpawnOptions} options
     * @returns {Promise<ObservableExecutionResult<string>>}
     * @memberof IJupyterSubCommandExecutionService
     */
    startNotebook(notebookArgs: string[], options: SpawnOptions): Promise<ObservableExecutionResult<string>>;
    /**
     * Gets a list of all locally running jupyter notebook servers.
     *
     * @param {CancellationToken} [token]
     * @returns {(Promise<JupyterServerInfo[] | undefined>)}
     * @memberof IJupyterSubCommandExecutionService
     */
    getRunningJupyterServers(token?: CancellationToken): Promise<JupyterServerInfo[] | undefined>;
    /**
     * Opens an ipynb file in a new instance of a jupyter notebook server.
     *
     * @param {string} notebookFile
     * @returns {Promise<void>}
     * @memberof IJupyterSubCommandExecutionService
     */
    openNotebook(notebookFile: string): Promise<void>;
}

export const IJupyterInterpreterDependencyManager = Symbol('IJupyterInterpreterDependencyManager');
export interface IJupyterInterpreterDependencyManager {
    /**
     * Installs the dependencies required to launch jupyter.
     *
     * @param {JupyterInstallError} [err]
     * @returns {Promise<void>}
     * @memberof IJupyterInterpreterDependencyManager
     */
    installMissingDependencies(err?: JupyterInstallError): Promise<void>;
}

export const INbConvertInterpreterDependencyChecker = Symbol('INbConvertInterpreterDependencyChecker');
export interface INbConvertInterpreterDependencyChecker {
    isNbConvertInstalled(interpreter: PythonEnvironment, _token?: CancellationToken): Promise<boolean>;
    getNbConvertVersion(interpreter: PythonEnvironment, _token?: CancellationToken): Promise<SemVer | undefined>;
}

export const INbConvertExportToPythonService = Symbol('INbConvertExportToPythonService');
export interface INbConvertExportToPythonService {
    exportNotebookToPython(
        file: Uri,
        interpreter: PythonEnvironment,
        template?: string,
        token?: CancellationToken
    ): Promise<string>;
}

export interface INotebookModel {
    readonly file: Uri;
    /**
     * Dispose of the Notebook model.
     *
     * This is invoked when there are no more references to a given `NotebookModel` (for example when
     * all editors associated with the document have been closed.)
     */
    dispose(): void;
}

export interface IModelLoadOptions {
    isNative?: boolean;
    file: Uri;
    possibleContents?: string;
    backupId?: string;
    defaultCellLanguage?: string;
    skipLoadingDirtyContents?: boolean;
}

type WebViewViewState = {
    readonly visible: boolean;
    readonly active: boolean;
};
export type WebViewViewChangeEventArgs = { current: WebViewViewState; previous: WebViewViewState };

export type GetServerOptions = {
    getOnly?: boolean;
    disableUI?: boolean;
    localOnly?: boolean;
    token?: CancellationToken;
    resource: Resource;
    metadata?: nbformat.INotebookMetadata;
    kernelConnection?: KernelConnectionMetadata;
    onConnectionMade?(disableUI?: boolean): void; // Optional callback for when the first connection is made
};

/**
 * Options for getting a notebook
 */
export type GetNotebookOptions = {
    resource: Resource;
    identity: Uri;
    getOnly?: boolean;
    disableUI?: boolean;
    metadata?: nbformat.INotebookMetadata;
    kernelConnection?: KernelConnectionMetadata;
    token?: CancellationToken;
};

export const INotebookProvider = Symbol('INotebookProvider');
export interface INotebookProvider {
    readonly type: 'raw' | 'jupyter';
    /**
     * Fired when a notebook has been created for a given Uri/Identity
     */
    onNotebookCreated: Event<{ identity: Uri; notebook: INotebook }>;
    onSessionStatusChanged: Event<{ status: ServerStatus; notebook: INotebook }>;

    /**
     * Fired just the first time that this provider connects
     */
    onConnectionMade: Event<boolean | undefined>;
    /**
     * Fired when a kernel would have been changed if a notebook had existed.
     */
    onPotentialKernelChanged: Event<{ identity: Uri; kernelConnection: KernelConnectionMetadata }>;

    /**
     * List of all notebooks (active and ones that are being constructed).
     */
    activeNotebooks: Promise<INotebook>[];
    /**
     * Disposes notebook associated with the given identity.
     * Using `getOrCreateNotebook` would be incorrect as thats async, and its possible a document has been opened in the interim (meaning we could end up disposing something that is required).
     */
    disposeAssociatedNotebook(options: { identity: Uri }): void;
    /**
     * Gets or creates a notebook, and manages the lifetime of notebooks.
     */
    getOrCreateNotebook(options: GetNotebookOptions): Promise<INotebook | undefined>;
    /**
     * Connect to a notebook provider to prepare its connection and to get connection information
     */
    connect(options: ConnectNotebookProviderOptions): Promise<INotebookProviderConnection | undefined>;

    /**
     * Disconnect from a notebook provider connection
     */
    disconnect(options: ConnectNotebookProviderOptions, cancelToken?: CancellationToken): Promise<void>;
    /**
     * Fires the potentialKernelChanged event for a notebook that doesn't exist.
     * @param identity identity notebook would have
     * @param kernel kernel that it was changed to.
     */
    firePotentialKernelChanged(identity: Uri, kernel: KernelConnectionMetadata): void;
}

export const IJupyterServerProvider = Symbol('IJupyterServerProvider');
export interface IJupyterServerProvider {
    /**
     * Gets the server used for starting notebooks
     */
    getOrCreateServer(options: GetServerOptions): Promise<INotebookServer | undefined>;
}

export interface IKernelSocket {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendToRealKernel(data: any, cb?: (err?: Error) => void): void;
    /**
     * Adds a listener to a socket that will be called before the socket's onMessage is called. This
     * allows waiting for a callback before processing messages
     * @param listener
     */
    addReceiveHook(hook: (data: WebSocketData) => Promise<void>): void;
    /**
     * Removes a listener for the socket. When no listeners are present, the socket no longer blocks
     * @param listener
     */
    removeReceiveHook(hook: (data: WebSocketData) => Promise<void>): void;
    /**
     * Adds a hook to the sending of data from a websocket. Hooks can block sending so be careful.
     * @param patch
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addSendHook(hook: (data: any, cb?: (err?: Error) => void) => Promise<void>): void;
    /**
     * Removes a send hook from the socket.
     * @param hook
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeSendHook(hook: (data: any, cb?: (err?: Error) => void) => Promise<void>): void;
}

export type KernelSocketOptions = {
    /**
     * Kernel Id.
     */
    readonly id: string;
    /**
     * Kernel ClientId.
     */
    readonly clientId: string;
    /**
     * Kernel UserName.
     */
    readonly userName: string;
    /**
     * Kernel model.
     */
    readonly model: {
        /**
         * Unique identifier of the kernel server session.
         */
        readonly id: string;
        /**
         * The name of the kernel.
         */
        readonly name: string;
    };
};
export type KernelSocketInformation = {
    /**
     * Underlying socket used by jupyterlab/services to communicate with kernel.
     * See jupyterlab/services/kernel/default.ts
     */
    readonly socket?: IKernelSocket;
    /**
     * Options used to clone a kernel.
     */
    readonly options: KernelSocketOptions;
};

/**
 * Response for installation of kernel dependencies such as ipykernel.
 * (these values are used in telemetry)
 */
export enum KernelInterpreterDependencyResponse {
    ok = 0, // Used in telemetry.
    cancel = 1, // Used in telemetry.
    failed = 2, // Used in telemetry.
    selectDifferentKernel = 3 // Used in telemetry.
}

export const IKernelDependencyService = Symbol('IKernelDependencyService');
export interface IKernelDependencyService {
    installMissingDependencies(
        resource: Resource,
        interpreter: PythonEnvironment,
        token?: CancellationToken,
        disableUI?: boolean
    ): Promise<void>;
    areDependenciesInstalled(interpreter: PythonEnvironment, _token?: CancellationToken): Promise<boolean>;
}

export const IKernelVariableRequester = Symbol('IKernelVariableRequester');

export interface IKernelVariableRequester {
    getVariableNamesAndTypesFromKernel(notebook: INotebook, token?: CancellationToken): Promise<IJupyterVariable[]>;
    getFullVariable(
        targetVariable: IJupyterVariable,
        notebook: INotebook,
        token?: CancellationToken
    ): Promise<IJupyterVariable>;
    getDataFrameRows(start: number, end: number, notebook: INotebook, expression: string): Promise<{}>;
    getVariableProperties(
        word: string,
        notebook: INotebook,
        cancelToken: CancellationToken | undefined,
        matchingVariable: IJupyterVariable | undefined,
        languageSettings: { [typeNameKey: string]: string[] },
        inEnhancedTooltipsExperiment: boolean
    ): Promise<{ [attributeName: string]: string }>;
    getDataFrameInfo(
        targetVariable: IJupyterVariable,
        notebook: INotebook,
        expression: string
    ): Promise<IJupyterVariable>;
}

export const INotebookCreationTracker = Symbol('INotebookCreationTracker');
export interface INotebookCreationTracker {
    readonly lastPythonNotebookCreated?: Date;
    readonly lastNotebookCreated?: Date;
    startTracking(): void;
}

export const IJupyterDebugService = Symbol('IJupyterDebugService');
export interface IJupyterDebugService extends IDebugService {
    /**
     * Event fired when a breakpoint is hit (debugger has stopped)
     */
    readonly onBreakpointHit: Event<void>;
    /**
     * Start debugging a notebook cell.
     * @param nameOrConfiguration Either the name of a debug or compound configuration or a [DebugConfiguration](#DebugConfiguration) object.
     * @return A thenable that resolves when debugging could be successfully started.
     */
    startRunByLine(config: DebugConfiguration): Thenable<boolean>;
    /**
     * Gets the current stack frame for the current thread
     */
    getStack(): Promise<DebugProtocol.StackFrame[]>;
    /**
     * Steps the current thread. Returns after the request is sent. Wait for onBreakpointHit or onDidTerminateDebugSession to determine when done.
     */
    step(): Promise<void>;
    /**
     * Runs the current thread. Will keep running until a breakpoint or end of session.
     */
    continue(): Promise<void>;
    /**
     * Force a request for variables. DebugAdapterTrackers can listen for the results.
     */
    requestVariables(): Promise<void>;
    /**
     * Stop debugging
     */
    stop(): void;
}

export interface IJupyterServerUri {
    baseUrl: string;
    token: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authorizationHeader: any; // JSON object for authorization header.
    expiration?: Date; // Date/time when header expires and should be refreshed.
    displayName: string;
}

export type JupyterServerUriHandle = string;

export interface IJupyterUriProvider {
    readonly id: string; // Should be a unique string (like a guid)
    getQuickPickEntryItems(): QuickPickItem[];
    handleQuickPick(item: QuickPickItem, backEnabled: boolean): Promise<JupyterServerUriHandle | 'back' | undefined>;
    getServerUri(handle: JupyterServerUriHandle): Promise<IJupyterServerUri>;
}

export const IJupyterUriProviderRegistration = Symbol('IJupyterUriProviderRegistration');

export interface IJupyterUriProviderRegistration {
    getProviders(): Promise<ReadonlyArray<IJupyterUriProvider>>;
    registerProvider(picker: IJupyterUriProvider): void;
    getJupyterServerUri(id: string, handle: JupyterServerUriHandle): Promise<IJupyterServerUri>;
}

export interface ISwitchKernelOptions {
    identity: Resource;
    resource: Resource;
    currentKernelDisplayName: string | undefined;
}

// Wraps the VS Code WebviewViewProvider. VSC Prefix as we also have our own IWebviewViewProvider
export interface IVSCWebviewViewProvider extends WebviewViewProvider {
    readonly viewType: 'jupyterViewVariables';
}

export const IJupyterServerUriStorage = Symbol('IJupyterServerUriStorage');
export interface IJupyterServerUriStorage {
    readonly onDidChangeUri: Event<void>;
    addToUriList(uri: string, time: number, displayName: string): Promise<void>;
    getSavedUriList(): Promise<{ uri: string; time: number; displayName?: string }[]>;
    clearUriList(): Promise<void>;
    getUri(): Promise<string>;
    setUri(uri: string): Promise<void>;
}
export interface IExternalWebviewCellButton {
    buttonId: string;
    codicon: string;
    statusToEnable: CellState[];
    tooltip: string;
    running: boolean;
}

export interface IExternalCommandFromWebview {
    buttonId: string;
    cell: ICell;
}

export const IDebuggingCellMap = Symbol('IDebuggingCellMap');
export interface IDebuggingCellMap {
    getCellsAndClearQueue(doc: NotebookDocument): NotebookCell[];
}
