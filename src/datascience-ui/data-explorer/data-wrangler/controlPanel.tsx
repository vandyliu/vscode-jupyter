import * as React from 'react';
import { ISlickRow } from '../reactSlickGrid';

import './sliceControl.css';
import { IGetColsResponse } from '../../../client/datascience/data-viewing/types';
import { ColumnsSection } from './controls/ColumnsSection';
import { IHistoryItem } from '../../../client/datascience/data-viewing/data-wrangler/types';

interface IControlPanelProps {
    data: ISlickRow[];
    headers: string[];
    resizeEvent: Slick.Event<void>;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    historyList: IHistoryItem[];
    monacoTheme: string;
    histogramData: IGetColsResponse;
    currentVariableName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    submitCommand(data: { command: string; args: any }): void;
}

export class ControlPanel extends React.Component<IControlPanelProps> {
    render() {
        const columnDropdownOptions = this.generateColumnDropdownOptions();

        return (
            <div
                style={{
                    resize: 'horizontal',
                    height: '100%',
                    zIndex: 99999,
                    overflowX: 'hidden',
                    overflowY: 'scroll',
                    border: '1px solid var(--vscode-sideBar-border)',
                    color: 'var(--vscode-sideBar-foreground)',
                    backgroundColor: 'var(--vscode-sideBar-background)'
                }}
            >
                <ColumnsSection
                    collapsed={true}
                    submitCommand={this.props.submitCommand}
                    options={columnDropdownOptions}
                    headers={this.props.headers}
                />
            </div>
        );
    }

    private generateColumnDropdownOptions() {
        const result = [];
        if (this.props.headers && this.props.headers.length) {
            const range = this.props.headers.length;
            for (let i = 0; i < range; i++) {
                const text = this.props.headers[i];
                if (text) {
                    result.push({ key: i, text });
                }
            }
        }
        return result;
    }
}
