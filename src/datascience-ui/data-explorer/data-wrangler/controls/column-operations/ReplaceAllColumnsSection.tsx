import { Dropdown, IDropdownOption, ResponsiveMode } from '@fluentui/react';
import * as React from 'react';
import { getLocString } from '../../../../react-common/locReactSide';
import { getAllColumnTypes } from '../SidePanelSection';
import { dropdownStyles, inputStyle } from '../styles';

interface IProps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setArgs(args: any): void;
}

interface IState {
    oldValue: string | number;
    newValue: string | number;
    oldValueType: string;
    newValueType: string;
}

export class ReplaceAllColumnsSection extends React.Component<IProps, IState> {
    constructor(props: IProps) {
        super(props);
        this.state = {
            oldValue: '',
            newValue: '',
            oldValueType: '',
            newValueType: ''
        };
        this.props.setArgs({
            oldValue: '',
            newValue: '',
            oldValueType: '',
            newValueType: '',
            isPreview: true
        });
    }

    render() {
        return (
            <>
                <Dropdown
                    label={getLocString('DataScience.dataWranglerOldValueType', 'Old Value Type')}
                    responsiveMode={ResponsiveMode.xxxLarge}
                    style={{ width: '100%' }}
                    styles={dropdownStyles}
                    options={getAllColumnTypes()}
                    className="dropdownTitleOverrides"
                    onChange={this.updateOldValueType}
                />
                <span>{getLocString('DataScience.dataWranglerOldValue', 'Old Value')}</span>
                <input
                    value={this.state.oldValue}
                    onChange={this.handleChangeOldValue}
                    className={'slice-data'}
                    style={inputStyle}
                    autoComplete="on"
                />
                <Dropdown
                    label={getLocString('DataScience.dataWranglerNewValueType', 'New Value Type')}
                    responsiveMode={ResponsiveMode.xxxLarge}
                    style={{ width: '100%' }}
                    styles={dropdownStyles}
                    options={getAllColumnTypes()}
                    className="dropdownTitleOverrides"
                    onChange={this.updateNewValueType}
                />
                <span>{getLocString('DataScience.dataWranglerNewValue', 'New Value')}</span>
                <input
                    value={this.state.newValue}
                    onChange={this.handleChangeNewValue}
                    className={'slice-data'}
                    style={inputStyle}
                    autoComplete="on"
                />
            </>
        );
    }

    private updateArgs() {
        this.props.setArgs({...this.state, isPreview: true});
    }

    private updateOldValueType = (_data: React.FormEvent, option: IDropdownOption | undefined) => {
        if (option) {
            this.setState({ oldValueType: option.key as string }, this.updateArgs);
        }
    };

    private updateNewValueType = (_data: React.FormEvent, option: IDropdownOption | undefined) => {
        if (option) {
            this.setState({ newValueType: option.key as string }, this.updateArgs);
        }
    };

    private handleChangeOldValue = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ oldValue: event.currentTarget.value }, this.updateArgs);
    };

    private handleChangeNewValue = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ newValue: event.currentTarget.value }, this.updateArgs);
    }
}
