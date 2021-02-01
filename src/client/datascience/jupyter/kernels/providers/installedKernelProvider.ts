// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as path from 'path';
import { CancellationToken } from 'vscode';
import { PYTHON_LANGUAGE } from '../../../../common/constants';
import { IPathUtils, Resource, ReadWrite } from '../../../../common/types';
import { sendTelemetryEvent } from '../../../../telemetry';
import { Telemetry } from '../../../constants';
import { IKernelFinder } from '../../../kernel-launcher/types';
import { IJupyterKernelSpec } from '../../../types';
import { detectDefaultKernelName, isPythonKernelConnection } from '../helpers';
import { KernelService } from '../kernelService';
import { IKernelSelectionListProvider, KernelSpecConnectionMetadata, IKernelSpecQuickPickItem } from '../types';

/**
 * Given a kernel spec, this will return a quick pick item with appropriate display names and the like.
 *
 * @param {IJupyterKernelSpec} kernelSpec
 * @param {IPathUtils} pathUtils
 * @returns {IKernelSpecQuickPickItem}
 */
function getQuickPickItemForKernelSpec(
    kernelSpec: IJupyterKernelSpec,
    pathUtils: IPathUtils
): IKernelSpecQuickPickItem<KernelSpecConnectionMetadata> {
    // If we have a matching interpreter, then display that path in the dropdown else path of the kernelspec.
    const pathToKernel = kernelSpec.metadata?.interpreter?.path || kernelSpec.path;

    // Its possible we could have kernels with the same name.
    // Include the path of the interpreter that owns this kernel or path of kernelspec.json file in description.
    // If we only have name of executable like `dotnet` or `python`, then include path to kernel json.
    // Similarly if this is a python kernel and pathTokernel is just `python`, look for corresponding interpreter that owns this and include its path.

    // E.g.
    // If its a python kernel with python path in kernel spec we display:
    //  detail: ~/user friendly path to python interpreter
    // If its a non-python kernel and we have the fully qualified path to executable:
    //  detail: ~/user friendly path to executable
    // If its a non-python kernel and we only have name of executable like `java/dotnet` & we we have the fully qualified path to interpreter that owns this kernel:
    //  detail: ~/user friendly path to kenelspec.json file

    let detail = pathUtils.getDisplayName(pathToKernel);
    if (pathToKernel === path.basename(pathToKernel)) {
        const pathToInterpreterOrKernelSpec =
            kernelSpec.language?.toLowerCase() === PYTHON_LANGUAGE.toLocaleLowerCase()
                ? kernelSpec.interpreterPath
                : kernelSpec.specFile || '';
        if (pathToInterpreterOrKernelSpec) {
            detail = pathUtils.getDisplayName(pathToInterpreterOrKernelSpec);
        }
    }
    return {
        label: kernelSpec.display_name,
        detail,
        selection: {
            kernelModel: undefined,
            kernelSpec: kernelSpec,
            interpreter: undefined,
            kind: 'startUsingKernelSpec'
        }
    };
}

// Provider for searching for installed kernelspecs on disk without using jupyter to search
export class InstalledKernelSelectionListProvider
    implements IKernelSelectionListProvider<KernelSpecConnectionMetadata> {
    constructor(
        private readonly kernelFinder: IKernelFinder,
        private readonly pathUtils: IPathUtils,
        private readonly kernelService: KernelService
    ) {}
    public async getKernelSelections(
        resource: Resource,
        cancelToken?: CancellationToken
    ): Promise<IKernelSpecQuickPickItem<KernelSpecConnectionMetadata>[]> {
        const items = await this.kernelFinder.listKernelSpecs(resource);
        const selections = await Promise.all(
            items
                .filter((item) => {
                    // If we have a default kernel name and a non-absolute path just hide the item
                    // Otherwise we end up showing a bunch of "Python 3 - python" default items for
                    // other interpreters
                    const match = detectDefaultKernelName(item.name);
                    if (match) {
                        // Check if this is a kernel we registerd in the old days.
                        // If it is, then no need to display that (selecting kernels registered is done by selecting the corresponding interpreter).
                        // Hence we can hide such kernels.
                        // Kernels we create will end with a uuid (with - stripped), & will have interpreter info in the metadata.
                        if (
                            item.metadata?.interpreter &&
                            item.name.length > 32 &&
                            item.name.slice(-32).toLowerCase() === item.name
                        ) {
                            return false;
                        }

                        // If we have the interpreter information this kernel belongs to and the kernel has custom env
                        // variables, then include it in the list.
                        if (item.interpreterPath && item.env) {
                            return true;
                        }
                        // Else include it only if the path is available for the kernel.
                        return path.isAbsolute(item.path);
                    }
                    return true;
                })
                .map((item) => getQuickPickItemForKernelSpec(item, this.pathUtils))
                .map(async (item) => {
                    // Ensure we have the associated interpreter information.
                    const selection = item.selection as ReadWrite<KernelSpecConnectionMetadata>;
                    if (selection.interpreter || !isPythonKernelConnection(selection)) {
                        return item;
                    }
                    selection.interpreter = await this.kernelService.findMatchingInterpreter(
                        selection.kernelSpec,
                        cancelToken
                    );
                    selection.kernelSpec.interpreterPath =
                        selection.kernelSpec.interpreterPath || selection.interpreter?.path;
                    return item;
                })
        );
        sendTelemetryEvent(Telemetry.NumberOfLocalKernelSpecs, { count: selections.length });
        return selections;
    }
}
