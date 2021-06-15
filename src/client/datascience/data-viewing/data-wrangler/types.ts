// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { IDisposable } from '../../../common/types';
import { CssMessages, SharedMessages } from '../../messages';
import { Event, WebviewPanel } from 'vscode';
import { InteractiveWindowMessages, ILoadTmLanguageResponse } from '../../interactive-common/interactiveWindowTypes';
import {
    IColsResponse,
    IDataFrameInfo,
    IGetColsResponse,
    IGetRowsRequest,
    IGetRowsResponse,
    IGetSliceRequest,
    IRowsResponse
} from '../types';

export namespace DataWranglerMessages {
    export const Started = SharedMessages.Started;
    export const UpdateSettings = SharedMessages.UpdateSettings;
    export const InitializeData = 'init';
    export const GetAllRowsRequest = 'get_all_rows_request';
    export const GetAllRowsResponse = 'get_all_rows_response';
    export const GetRowsRequest = 'get_rows_request';
    export const GetRowsResponse = 'get_rows_response';
    export const CompletedData = 'complete';
    export const GetSliceRequest = 'get_slice_request';
    export const SubmitCommand = 'submit_command';
    export const RefreshDataWrangler = 'refresh_data_viewer'; // TODOV
    export const SliceEnablementStateChanged = 'slice_enablement_state_changed';
    export const UpdateHistoryList = 'update_history_list';
    export const GetHistoryItem = 'get_history_item';
    export const GetHistogramResponse = 'get_histogram_response';
}

// Map all messages to specific payloads
export type IDataWranglerMapping = {
    [DataWranglerMessages.Started]: never | undefined;
    [DataWranglerMessages.UpdateSettings]: string;
    [DataWranglerMessages.InitializeData]: IDataFrameInfo;
    [DataWranglerMessages.GetAllRowsRequest]: never | undefined | string;
    [DataWranglerMessages.GetAllRowsResponse]: IRowsResponse;
    [DataWranglerMessages.GetRowsRequest]: IGetRowsRequest;
    [DataWranglerMessages.GetRowsResponse]: IGetRowsResponse;
    [DataWranglerMessages.CompletedData]: never | undefined;
    [DataWranglerMessages.GetSliceRequest]: IGetSliceRequest;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [DataWranglerMessages.SubmitCommand]: { command: string; args: any };
    [DataWranglerMessages.RefreshDataWrangler]: never | undefined;
    [DataWranglerMessages.SliceEnablementStateChanged]: { newState: boolean };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [DataWranglerMessages.UpdateHistoryList]: any[] | undefined;
    [DataWranglerMessages.GetHistoryItem]: number | undefined;
    [DataWranglerMessages.GetHistogramResponse]: IGetColsResponse;
    [InteractiveWindowMessages.LoadOnigasmAssemblyRequest]: never | undefined;
    [InteractiveWindowMessages.LoadOnigasmAssemblyResponse]: Buffer;
    [InteractiveWindowMessages.LoadTmLanguageRequest]: string;
    [InteractiveWindowMessages.LoadTmLanguageResponse]: ILoadTmLanguageResponse;
    [CssMessages.GetMonacoThemeRequest]: { isDark: boolean };
};

export interface IDataWranglerDataProvider {
    dispose(): void;
    getDataFrameInfo(sliceExpression?: string, isRefresh?: boolean): Promise<IDataFrameInfo>;
    getAllRows(sliceExpression?: string): Promise<IRowsResponse>;
    getRows(start: number, end: number, sliceExpression?: string): Promise<IRowsResponse>;
    getCols(columnName: string): Promise<IColsResponse>;
}

export const IDataWranglerFactory = Symbol('IDataWranglerFactory');
export interface IDataWranglerFactory {
    create(dataProvider: IDataWranglerDataProvider, title: string, webviewPanel?: WebviewPanel): Promise<IDataWrangler>;
}

export const IDataWrangler = Symbol('IDataWrangler');
export interface IDataWrangler extends IDisposable {
    readonly visible: boolean;
    readonly onDidDisposeDataWrangler: Event<IDataWrangler>;
    readonly onDidChangeDataWranglerViewState: Event<void>;
    showData(dataProvider: IDataWranglerDataProvider, title: string, webviewPanel?: WebviewPanel): Promise<void>;
    refreshData(): Promise<void>;
    updateWithNewVariable(newVariableName: string): Promise<void>;
}
