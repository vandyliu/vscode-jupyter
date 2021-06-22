import { inject, injectable } from 'inversify';
import {
    Disposable,
    NotebookCell,
    NotebookCellExecutionState,
    NotebookCellExecutionStateChangeEvent,
    notebooks as vscNotebook
} from 'vscode';
import { ICommandManager } from '../../../common/application/types';
import { addNewCellAfter, updateCellCode } from '../../notebook/helpers/executionHelpers';
import { INotebook, INotebookEditorProvider } from '../../types';
import { IDataWranglerCommandHandler, IUpdateWranglerRes } from './types';

@injectable()
export class NotebookCommandHandler implements IDataWranglerCommandHandler {
    private lastCell: NotebookCell | undefined;

    constructor(
        @inject(ICommandManager) private commandManager: ICommandManager,
        @inject(INotebookEditorProvider) private notebookEditorProvider: INotebookEditorProvider
    ) {}

    public async updateWrangler(
        code: string,
        notebook: INotebook | undefined,
        existingDisposable: Disposable | undefined,
        refreshRequired?: boolean
    ): Promise<IUpdateWranglerRes> {
        const matchingNotebookEditor = this.notebookEditorProvider.editors.find(
            (editor) => editor.notebook?.identity.fsPath === notebook?.identity.fsPath
        );
        if (code && matchingNotebookEditor !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let cells = (matchingNotebookEditor as any).document.getCells();
            this.lastCell = cells[cells.length - 1] as NotebookCell;
            await addNewCellAfter(this.lastCell, '');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cells = (matchingNotebookEditor as any).document.getCells();
            this.lastCell = cells[cells.length - 1] as NotebookCell;
            await updateCellCode(this.lastCell, code);
            existingDisposable?.dispose();

            let shouldWranglerUpdateVar = false;
            const newDisposable = vscNotebook.onDidChangeNotebookCellExecutionState(
                async (e: NotebookCellExecutionStateChangeEvent) => {
                    if (e.state === NotebookCellExecutionState.Idle && refreshRequired) {
                        shouldWranglerUpdateVar = true;
                    }
                }
            );
            return { newDisposable: newDisposable, shouldWranglerUpdateVar: shouldWranglerUpdateVar };
        }
        return { shouldWranglerUpdateVar: false };
    }

    public async executeCellAfterVariableUpdate() {
        if (this.lastCell) {
            await this.commandManager.executeCommand(
                'notebook.cell.execute',
                { start: this.lastCell.index, end: this.lastCell.notebook.cellCount },
                this.lastCell.notebook.uri
            );
        }
    }
}
