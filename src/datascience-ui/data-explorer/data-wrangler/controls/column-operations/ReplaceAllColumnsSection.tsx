import * as React from 'react';
import { DataWranglerCommands, IReplaceAllColumnsRequest } from '../../../../../client/datascience/data-viewing/data-wrangler/types';

interface IProps {
    selectedColumns: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    submitCommand(data: { command: string; args: any }): void;
    setColumns(cols: number[]): void;
}

interface IState {
    oldValue: string | number;
    newValue: string | number;
}

export class ReplaceAllColumnsSection extends React.Component<IProps, IState> {
    constructor(props: IProps) {
        super(props);
        this.state = {
            oldValue: '',
            newValue: ''
        };
    }

    render() {
        return (
            <div className="slice-control-row" style={{ paddingBottom: '5px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', width: '100px' }}>
                    <span>{'Replace all values of:'}</span>
                    <input
                        value={this.state.oldValue}
                        onChange={this.handleChangeOldValue}
                        className={'slice-data'}
                        style={{ width: '140px', marginTop: '4px', marginBottom: '16px' }}
                        autoComplete="on"
                    />
                    <span>{'To:'}</span>
                    <input
                        value={this.state.newValue}
                        onChange={this.handleChangeNewValue}
                        className={'slice-data'}
                        style={{ width: '140px', marginTop: '4px', marginBottom: '16px' }}
                        autoComplete="on"
                    />
                    <button
                        onClick={() => {
                            if (this.state.oldValue && this.state.newValue) {
                                this.props.submitCommand({
                                    command: DataWranglerCommands.ReplaceAllColumn,
                                    args: {
                                        targetColumns: this.props.selectedColumns,
                                        oldValue: this.state.oldValue,
                                        newValue: this.state.newValue
                                    } as IReplaceAllColumnsRequest
                                });
                                this.props.setColumns([]);
                            }
                        }}
                        style={{
                            backgroundColor: 'var(--vscode-button-background)',
                            color: 'var(--vscode-button-foreground)',
                            margin: '4px',
                            marginLeft: '0px',
                            padding: '8px',
                            border: 'none',
                            cursor: 'pointer',
                            height: '26px'
                        }}
                    >
                        Submit
                    </button>
                </div>
            </div>
        );
    }

    private handleChangeOldValue = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ oldValue: event.currentTarget.value });
    };

    private handleChangeNewValue = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ newValue: event.currentTarget.value });
    };
}
