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
    value: string | number;
    valueType: string;
}

export class FillNaSection extends React.Component<IProps, IState> {
    constructor(props: IProps) {
        super(props);
        this.state = {
            value: '',
            valueType: ''
        };
        this.props.setArgs({
            value: '',
            valueType: '',
            isPreview: true
        });
    }

    render() {
        return (
            <>
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
                    value={this.state.value}
                    onChange={this.handleChangeValue}
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

    private updateNewValueType = (_data: React.FormEvent, option: IDropdownOption | undefined) => {
        if (option) {
            this.setState({ valueType: option.key as string }, this.updateArgs);
        }
    };

    private handleChangeValue = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ value: event.currentTarget.value }, this.updateArgs);
    };
}
