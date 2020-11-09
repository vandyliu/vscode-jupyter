// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import type { nbformat } from '@jupyterlab/coreutils';
import { injectable } from 'inversify';
import stripAnsi from 'strip-ansi';
import * as uuid from 'uuid/v4';
import { ViewColumn, WebviewPanel, window } from 'vscode';
import { traceError, traceInfo } from '../../common/logger';
import { IInstaller, Product } from '../../common/types';
import { TensorBoard } from '../../common/utils/localize';
import { Identifiers } from '../constants';
import { ICell, INotebook } from '../types';

@injectable()
export class TensorBoardSession {
    private webviewPanel: WebviewPanel | undefined;
    private port: number | undefined;

    constructor(public readonly associatedNotebook: INotebook, private readonly installer: IInstaller) {}

    public async initialize() {
        if (!this.associatedNotebook.disposed) {
            await this.ensureTensorboardIsInstalled();
            await this.silentlyLoadTensorboardExtension();
            const logDir = await this.askUserForLogDir();
            await this.startTensorboardSession(logDir);
            this.showPanel();
        }
    }

    private async ensureTensorboardIsInstalled() {
        traceInfo('Ensuring TensorBoard package is installed');
        const interpreter = this.associatedNotebook.getMatchingInterpreter();
        if (!(await this.installer.isInstalled(Product.tensorboard, interpreter))) {
            await this.installer.promptToInstall(Product.tensorboard, interpreter);
        } else {
            traceInfo('TensorBoard is already installed');
        }
    }

    private async silentlyLoadTensorboardExtension() {
        traceInfo('Loading TensorBoard extension');
        await this.associatedNotebook.execute(
            '%load_ext tensorboard',
            Identifiers.EmptyFileName,
            0,
            uuid(),
            undefined,
            true
        );
    }

    private async askUserForLogDir(): Promise<string> {
        const options = {
            prompt: TensorBoard.logDirectoryPrompt(),
            placeHolder: TensorBoard.logDirectoryPlaceholder(),
            validateInput: (value: string) => {
                return value.trim().length > 0 ? undefined : TensorBoard.invalidLogDirectory();
            }
        };
        const logDir = await window.showInputBox(options);
        return logDir || 'logs/fit';
    }

    private async startTensorboardSession(logDir: string) {
        // For better control, maybe create either a pseudoterminal or Python daemon process to start Tensorboard server
        // Pseudoterminal might be better because if VSCode gets killed the process also gets killed
        traceInfo('Starting TensorBoard');
        const result = await this.associatedNotebook.execute(
            `%tensorboard --logdir ${logDir}`,
            Identifiers.EmptyFileName,
            0,
            uuid(),
            undefined,
            true
        );
        this.getPortFromCellExecutionResult(result);
    }

    private getPortFromCellExecutionResult(result: ICell[]) {
        if (result.length > 0 && result[0].data) {
            const codeCell = result[0].data as nbformat.ICodeCell;
            if (codeCell.outputs.length > 0) {
                codeCell.outputs.map((output) => {
                    switch (output.output_type) {
                        case 'display_data':
                            if (output.data?.hasOwnProperty('text/html')) {
                                // tslint:disable-next-line: no-any
                                const text = (output.data as any)['text/html'];
                                if (typeof text === 'string') {
                                    const portDeclarationRegex = /const port = ([0-9]+);/;
                                    const matches = text.match(portDeclarationRegex);
                                    this.port = matches && matches[1] ? Number(matches[1]) : undefined;
                                    traceInfo(`TensorBoard session is now running on port ${this.port}`);
                                }
                            }
                            break;
                        case 'error':
                            if (output.hasOwnProperty('traceback')) {
                                const traceback: string[] = output.traceback as string[];
                                const error = traceback.map(stripAnsi).join('\r\n');
                                traceError(error);
                                throw new Error(TensorBoard.failedToStartSessionError().format(error));
                            }
                            break;
                        default:
                            break;
                    }
                });
            }
        }
    }

    private showPanel() {
        traceInfo('Showing TensorBoard panel');
        const panel = this.webviewPanel || this.createPanel();
        panel.reveal();
    }

    private createPanel() {
        const webviewPanel = window.createWebviewPanel('tensorBoardSession', 'TensorBoard', ViewColumn.Two, {
            enableScripts: true
        });
        this.webviewPanel = webviewPanel;
        webviewPanel.onDidDispose(() => {
            this.webviewPanel = undefined;
            // Kill the running tensorboard session
        });
        webviewPanel.onDidChangeViewState((_e) => {
            if (webviewPanel.visible) {
                this.update();
            }
        }, null);
        return webviewPanel;
    }

    private update() {
        if (this.webviewPanel) {
            this.webviewPanel.webview.html = `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">

                <!--
                Use a content security policy to only allow loading images from https or from our extension directory,
                and only allow scripts that have a specific nonce.
                -->
                <meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline'; frame-src http://localhost:${
                    this.port || '6006'
                }/;">
                <iframe
                    width="100%"
                    height="800"
                    sandbox="allow-scripts allow-forms allow-same-origin allow-pointer-lock"
                    src="http://localhost:${this.port || '6006'}"
                    frameborder="0"
                    allowfullscreen
                ></iframe>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>TensorBoard</title>
            </head>
            </html>`;
        }
    }
}
