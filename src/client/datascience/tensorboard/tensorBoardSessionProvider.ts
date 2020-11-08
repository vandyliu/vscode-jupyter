// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { traceInfo } from '../../common/logger';
import { IInstaller } from '../../common/types';
import { INotebook } from '../types';
import { TensorBoardSession } from './tensorBoardSession';

@injectable()
export class TensorBoardSessionProvider {
    private sessions = new WeakMap<INotebook, TensorBoardSession>();

    constructor(@inject(IInstaller) private readonly installer: IInstaller) {}

    public getOrCreate(associatedNotebook: INotebook): TensorBoardSession {
        // Each TensorBoard session must be associated with one
        // Jupyter notebook or interactive window
        return this.sessions.get(associatedNotebook) ?? this.createNewSession(associatedNotebook);
    }

    private createNewSession(associatedNotebook: INotebook) {
        traceInfo('Creating new TensorBoard session');
        const newSession = new TensorBoardSession(associatedNotebook, this.installer);
        this.sessions.set(associatedNotebook, newSession);
        return newSession;
    }
}
