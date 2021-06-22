import { injectable } from 'inversify';
import * as uuid from 'uuid/v4';
import { Disposable } from 'vscode';
import { INotebook } from '../../types';
import { IDataWranglerCommandHandler, IUpdateWranglerRes } from './types';

@injectable()
export class StandaloneCommandHandler implements IDataWranglerCommandHandler {
    public async updateWrangler(
        code: string,
        notebook: INotebook | undefined,
        existingDisposable: Disposable | undefined
    ): Promise<IUpdateWranglerRes> {
        if (code && notebook !== undefined) {
            void notebook?.execute(code, '', 0, uuid()).then(async () => {
                existingDisposable?.dispose();

                return { shouldWranglerUpdateVar: true };
            });
        }
        return { shouldWranglerUpdateVar: false };
    }
}
