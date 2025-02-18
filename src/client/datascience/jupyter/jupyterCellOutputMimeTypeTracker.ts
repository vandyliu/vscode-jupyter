// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import type { nbformat } from '@jupyterlab/coreutils';
import { inject, injectable } from 'inversify';
import { NotebookCellKind, NotebookDocument } from 'vscode';
import { IExtensionSingleActivationService } from '../../activation/types';
import { IVSCodeNotebook } from '../../common/application/types';
import { disposeAllDisposables } from '../../common/helpers';
import { IDisposable, IDisposableRegistry } from '../../common/types';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { getTelemetrySafeHashedString } from '../../telemetry/helpers';
import { Telemetry } from '../constants';
import { CellState, ICell, INotebookExecutionLogger } from '../types';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const flatten = require('lodash/flatten') as typeof import('lodash/flatten');

@injectable()
export class CellOutputMimeTypeTracker
    implements IExtensionSingleActivationService, INotebookExecutionLogger, IDisposable {
    private pendingChecks = new Map<string, NodeJS.Timer | number>();
    private sentMimeTypes: Set<string> = new Set<string>();
    private readonly disposables: IDisposable[] = [];

    constructor(
        @inject(IVSCodeNotebook) private vscNotebook: IVSCodeNotebook,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        disposables.push(this);
        this.vscNotebook.onDidOpenNotebookDocument(this.onDidOpenCloseDocument, this, this.disposables);
        this.vscNotebook.onDidCloseNotebookDocument(this.onDidOpenCloseDocument, this, this.disposables);
        this.vscNotebook.onDidSaveNotebookDocument(this.onDidOpenCloseDocument, this, this.disposables);
    }
    public async activate(): Promise<void> {
        //
    }

    public dispose() {
        disposeAllDisposables(this.disposables);
        this.pendingChecks.clear();
    }

    public onKernelStarted() {
        // Do nothing on started
    }

    public onKernelRestarted() {
        // Do nothing on restarted
    }
    public async preExecute(_cell: ICell, _silent: boolean): Promise<void> {
        // Do nothing on pre execute
    }
    public async postExecute(cell: ICell, silent: boolean): Promise<void> {
        if (!silent && cell.data.cell_type === 'code') {
            this.scheduleCheck(this.createCellKey(cell), this.checkCell.bind(this, cell));
        }
    }
    private onDidOpenCloseDocument(doc: NotebookDocument) {
        doc.getCells().forEach((cell) => {
            if (cell.kind === NotebookCellKind.Code) {
                cell.outputs.forEach((output) => output.items.forEach((item) => this.sendTelemetry(item.mime)));
            }
        });
    }
    private getCellOutputMimeTypes(cell: { data: nbformat.IBaseCell; id: string; state: CellState }): string[] {
        if (cell.data.cell_type === 'markdown') {
            return ['markdown'];
        }
        if (cell.data.cell_type !== 'code') {
            return [];
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outputs: nbformat.IOutput[] = cell.data.outputs as any;
        if (!Array.isArray(outputs)) {
            return [];
        }
        switch (cell.state) {
            case CellState.editing:
            case CellState.error:
            case CellState.executing:
                return [];
            default: {
                return flatten(outputs.map(this.getOutputMimeTypes.bind(this)));
            }
        }
    }
    private getOutputMimeTypes(output: nbformat.IOutput): string[] {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outputType: nbformat.OutputType = output.output_type as any;
        switch (outputType) {
            case 'error':
                return [];
            case 'stream':
                return ['stream'];
            case 'display_data':
            case 'update_display_data':
            case 'execute_result':
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const data = (output as any).data;
                return data ? Object.keys(data) : [];
            default:
                // If we have a large number of these, then something is wrong.
                return ['unrecognized_cell_output'];
        }
    }

    private scheduleCheck(id: string, check: () => void) {
        // If already scheduled, cancel.
        const currentTimeout = this.pendingChecks.get(id);
        if (currentTimeout) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            clearTimeout(currentTimeout as any);
            this.pendingChecks.delete(id);
        }

        // Now schedule a new one.
        // Wait five seconds to make sure we don't already have this document pending.
        this.pendingChecks.set(id, setTimeout(check, 5000));
    }

    private createCellKey(cell: { id: string }): string {
        return cell.id;
    }

    @captureTelemetry(Telemetry.HashedCellOutputMimeTypePerf)
    private checkCell(cell: { data: nbformat.IBaseCell; id: string; state: CellState }) {
        this.pendingChecks.delete(this.createCellKey(cell));
        this.getCellOutputMimeTypes(cell).forEach(this.sendTelemetry.bind(this));
    }

    private sendTelemetry(mimeType: string) {
        // No need to send duplicate telemetry or waste CPU cycles on an unneeded hash.
        if (this.sentMimeTypes.has(mimeType)) {
            return;
        }
        this.sentMimeTypes.add(mimeType);
        // Hash the package name so that we will never accidentally see a
        // user's private package name.
        const hashedName = getTelemetrySafeHashedString(mimeType);

        const lowerMimeType = mimeType.toLowerCase();
        // The following gives us clues of the mimetype.
        const props = {
            hashedName,
            hasText: lowerMimeType.includes('text'),
            hasLatex: lowerMimeType.includes('latex'),
            hasHtml: lowerMimeType.includes('html'),
            hasSvg: lowerMimeType.includes('svg'),
            hasXml: lowerMimeType.includes('xml'),
            hasJson: lowerMimeType.includes('json'),
            hasImage: lowerMimeType.includes('image'),
            hasGeo: lowerMimeType.includes('geo'),
            hasPlotly: lowerMimeType.includes('plotly'),
            hasVega: lowerMimeType.includes('vega'),
            hasWidget: lowerMimeType.includes('widget'),
            hasJupyter: lowerMimeType.includes('jupyter'),
            hasVnd: lowerMimeType.includes('vnd')
        };
        sendTelemetryEvent(Telemetry.HashedCellOutputMimeType, undefined, props);
    }
}
