import * as React from 'react';
import { DataWranglerCommands, IRenameColumnsRequest } from '../../../../../client/datascience/data-viewing/data-wrangler/types';

interface IProps {
    selectedColumn: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    submitCommand(data: { command: string; args: any }): void;
    setColumns(cols: number[]): void;
}

interface IState {
    newColumnName: string | undefined;
}

export class RenameColumnsSection extends React.Component<IProps, IState> {
    constructor(props: IProps) {
        super(props);
        this.state = {
            newColumnName: ''
        };
    }

    render() {
        return (
            <div className="slice-control-row" style={{ paddingBottom: '5px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', width: '100px' }}>
                    <span>{'To:'}</span>
                    <input
                        value={this.state.newColumnName}
                        onChange={this.handleChange}
                        className={'slice-data'}
                        style={{ width: '140px', marginTop: '4px', marginBottom: '16px' }}
                        autoComplete="on"
                    />
                    <button
                        onClick={() => {
                            if (this.state.newColumnName) {
                                this.props.submitCommand({
                                    command: DataWranglerCommands.RenameColumn,
                                    args: {
                                        targetColumn: this.props.selectedColumn,
                                        newColumnName: this.state.newColumnName
                                    } as IRenameColumnsRequest
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

    private handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ newColumnName: event.currentTarget.value });
    };
}
