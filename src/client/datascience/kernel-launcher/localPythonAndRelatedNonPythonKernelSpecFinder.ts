// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import { IWorkspaceService } from '../../common/application/types';
import { PYTHON_LANGUAGE } from '../../common/constants';
import { traceError, traceInfo, traceInfoIf } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';
import { Resource } from '../../common/types';
import { IInterpreterService } from '../../interpreter/contracts';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { createInterpreterKernelSpec, getKernelId, isKernelRegisteredByUs } from '../jupyter/kernels/helpers';
import { KernelSpecConnectionMetadata, PythonKernelConnectionMetadata } from '../jupyter/kernels/types';
import { IJupyterKernelSpec } from '../types';
import { LocalKernelSpecFinderBase } from './localKernelSpecFinderBase';
import { baseKernelPath, JupyterPaths } from './jupyterPaths';
import { IPythonExtensionChecker } from '../../api/types';
import { LocalKnownPathKernelSpecFinder } from './localKnownPathKernelSpecFinder';

export const isDefaultPythonKernelSpecName = /python\d*.?\d*$/;

/**
 * Returns all Python kernels and any related kernels registered in the python environment.
 * If Python extension is not installed, this will return all Python kernels registered globally.
 * If Python extension is intalled,
 *     - This will return Python kernels regsitered by us in global locations.
 *     - This will return Python interpreters that can be started as kernels.
 *     - This will return any non-python kernels that are registered in Python environments (e.g. Java kernels within a conda environment)
 */
@injectable()
export class LocalPythonAndRelatedNonPythonKernelSpecFinder extends LocalKernelSpecFinderBase {
    constructor(
        @inject(IInterpreterService) private interpreterService: IInterpreterService,
        @inject(IFileSystem) fs: IFileSystem,
        @inject(IWorkspaceService) workspaceService: IWorkspaceService,
        @inject(JupyterPaths) private readonly jupyterPaths: JupyterPaths,
        @inject(IPythonExtensionChecker) private readonly extensionChecker: IPythonExtensionChecker,
        @inject(LocalKnownPathKernelSpecFinder)
        private readonly kernelSpecsFromKnownLocations: LocalKnownPathKernelSpecFinder
    ) {
        super(fs, workspaceService);
    }
    public async listKernelSpecs(resource: Resource, cancelToken?: CancellationToken) {
        // Get an id for the workspace folder, if we don't have one, use the fsPath of the resource
        const workspaceFolderId =
            this.workspaceService.getWorkspaceFolderIdentifier(
                resource,
                resource?.fsPath || this.workspaceService.rootPath
            ) || 'root';
        return this.listKernelsWithCache(workspaceFolderId, () =>
            this.listKernelsImplementation(resource, cancelToken)
        );
    }
    private async listKernelsImplementation(
        resource: Resource,
        cancelToken?: CancellationToken
    ): Promise<(KernelSpecConnectionMetadata | PythonKernelConnectionMetadata)[]> {
        const interpreters = this.extensionChecker.isPythonExtensionInstalled
            ? await this.interpreterService.getInterpreters(resource)
            : [];
        // If we don't have Python extension installed or don't discover any Python interpreters
        // then list all of the global python kernel specs.
        if (interpreters.length === 0 || !this.extensionChecker.isPythonExtensionInstalled) {
            return this.listGlobalPythonKernelSpecs(cancelToken);
        } else {
            return this.listPythonAndRelatedNonPythonKernelSpecs(resource, interpreters, cancelToken);
        }
    }
    private async listGlobalPythonKernelSpecs(
        cancelToken?: CancellationToken
    ): Promise<(KernelSpecConnectionMetadata | PythonKernelConnectionMetadata)[]> {
        const kernelSpecs = await this.kernelSpecsFromKnownLocations.listKernelSpecs(true, cancelToken);
        return kernelSpecs.filter((item) => item.kernelSpec.language === PYTHON_LANGUAGE);
    }
    /**
     * If user has python extension installed, then we'll not list any of the globally registered Python kernels.
     * They are too ambiguous (because we have no idea what Python environment they are related to).
     *
     * Some python environments like conda can have non-python kernel specs as well, this will return those as well.
     * Those kernels can only be started within the context of the Python environment.
     * I.e. first actiavte the python environment, then attempt to start those non-python environments.
     * This is because some python environments setup environment variables required by these non-python kernels (e.g. path to Java executable or the like.
     */
    private async listPythonAndRelatedNonPythonKernelSpecs(
        resource: Resource,
        interpreters: PythonEnvironment[],
        cancelToken?: CancellationToken
    ): Promise<(KernelSpecConnectionMetadata | PythonKernelConnectionMetadata)[]> {
        const rootSpecPathPromise = this.jupyterPaths.getKernelSpecRootPath();
        const activeInterpreterPromise = this.interpreterService.getActiveInterpreter(resource);
        // First find the on disk kernel specs and interpreters
        const [kernelSpecs, rootSpecPath, activeInterpreter, globalKernelSpecs] = await Promise.all([
            this.findKernelSpecsInInterpreters(interpreters, cancelToken),
            rootSpecPathPromise,
            activeInterpreterPromise,
            this.listGlobalPythonKernelSpecs(cancelToken)
        ]);

        const globalPythonKernelSpecsRegisteredByUs = globalKernelSpecs.filter((item) =>
            isKernelRegisteredByUs(item.kernelSpec)
        );
        // Copy the interpreter list. We need to filter out those items
        // which have matched one or more kernelspecs
        let filteredInterpreters = [...interpreters];

        // If the user has intepreters, then don't display the default kernel specs such as `python`, `python3`.
        // Such kernel specs are ambiguous, and we have absolutely no idea what interpreters they point to.
        // If a user wants to select a kernel they can pick an interpreter (this way we know exactly what interpreter needs to be started).
        // Else if you have `python3`, depending on the active/default interpreter we could start different interpreters (different for the same notebook opened from different workspace folders).
        const hideDefaultKernelSpecs = interpreters.length > 0 || activeInterpreter ? true : false;

        // Then go through all of the kernels and generate their metadata
        const distinctKernelMetadata = new Map<string, KernelSpecConnectionMetadata | PythonKernelConnectionMetadata>();
        await Promise.all(
            [...kernelSpecs, ...globalPythonKernelSpecsRegisteredByUs.map((item) => item.kernelSpec)]
                .filter((kernelspec) => {
                    if (
                        kernelspec.language === PYTHON_LANGUAGE &&
                        hideDefaultKernelSpecs &&
                        kernelspec.name.toLowerCase().match(isDefaultPythonKernelSpecName)
                    ) {
                        traceInfo(`Hiding default kernel spec ${kernelspec.display_name}, ${kernelspec.argv[0]}`);
                        return false;
                    }
                    return true;
                })
                .map(async (k) => {
                    // Find the interpreter that matches. If we find one, we want to use
                    // this to start the kernel.
                    const matchingInterpreter = this.findMatchingInterpreter(k, interpreters);
                    if (matchingInterpreter) {
                        const result: PythonKernelConnectionMetadata = {
                            kind: 'startUsingPythonInterpreter',
                            kernelSpec: k,
                            interpreter: matchingInterpreter,
                            id: getKernelId(k, matchingInterpreter)
                        };

                        // If interpreters were found, remove them from the interpreter list we'll eventually
                        // return as interpreter only items
                        filteredInterpreters = filteredInterpreters.filter((i) => matchingInterpreter !== i);

                        // Return our metadata that uses an interpreter to start
                        return result;
                    } else {
                        let interpreter = k.language === PYTHON_LANGUAGE ? activeInterpreter : undefined;
                        // If the interpreter information is stored in kernelspec.json then use that to determine the interpreter.
                        // This can happen under the following circumstances:
                        // 1. Open workspace folder XYZ, and create a virtual environment named venvA
                        // 2. Now assume we don't have raw kernels, and a kernel gets registered for venvA in kernelspecs folder.
                        // 3. The kernel spec will contain metadata pointing to venvA.
                        // 4. Now open a different folder (e.g. a sub directory of XYZ or a completely different folder).
                        // 5. Now venvA will not be listed as an interpreter as Python will not discover this.
                        // 6. However the kernel we registered against venvA will be in global kernels folder
                        // In such an instance the interpreter information is stored in the kernelspec.json file.
                        if (
                            k.language === PYTHON_LANGUAGE &&
                            k.metadata?.interpreter?.path &&
                            k.metadata?.interpreter?.path !== activeInterpreter?.path
                        ) {
                            try {
                                interpreter = await this.interpreterService.getInterpreterDetails(
                                    k.metadata?.interpreter?.path
                                );
                            } catch (ex) {
                                traceError(
                                    `Failed to get interpreter details for Kernel Spec ${k.specFile} with interpreter path ${k.metadata?.interpreter?.path}`,
                                    ex
                                );
                                return;
                            }
                        }
                        const result: KernelSpecConnectionMetadata = {
                            kind: 'startUsingKernelSpec',
                            kernelSpec: k,
                            interpreter,
                            id: getKernelId(k, interpreter)
                        };
                        return result;
                    }
                })
                .map(async (item) => {
                    const kernelSpec:
                        | undefined
                        | KernelSpecConnectionMetadata
                        | PythonKernelConnectionMetadata = await item;
                    // Check if we have already seen this.
                    if (kernelSpec && !distinctKernelMetadata.has(kernelSpec.id)) {
                        distinctKernelMetadata.set(kernelSpec.id, kernelSpec);
                    }
                })
        );

        // Combine the two into our list
        const results = [
            ...Array.from(distinctKernelMetadata.values()),
            ...filteredInterpreters.map((i) => {
                // Update spec to have a default spec file
                const spec = createInterpreterKernelSpec(i, rootSpecPath);
                const result: PythonKernelConnectionMetadata = {
                    kind: 'startUsingPythonInterpreter',
                    kernelSpec: spec,
                    interpreter: i,
                    id: getKernelId(spec, i)
                };
                return result;
            })
        ];

        return results.sort((a, b) => {
            if (a.kernelSpec.display_name.toUpperCase() === b.kernelSpec.display_name.toUpperCase()) {
                return 0;
            } else if (
                a.interpreter?.path === activeInterpreter?.path &&
                a.kernelSpec.display_name.toUpperCase() === activeInterpreter?.displayName?.toUpperCase()
            ) {
                return -1;
            } else {
                return 1;
            }
        });
    }

    private findMatchingInterpreter(
        kernelSpec: IJupyterKernelSpec,
        interpreters: PythonEnvironment[]
    ): PythonEnvironment | undefined {
        // If we know for a fact that the kernel spec is a Non-Python kernel, then return nothing.
        if (kernelSpec.language && kernelSpec.language !== PYTHON_LANGUAGE) {
            traceInfoIf(
                !!process.env.VSC_JUPYTER_LOG_KERNEL_OUTPUT,
                `Kernel ${kernelSpec.name} is not python based so does not have an interpreter.`
            );
            return;
        }
        // 1. Check if current interpreter has the same path
        const exactMatch = interpreters.find((i) => {
            if (
                kernelSpec.metadata?.interpreter?.path &&
                this.fs.areLocalPathsSame(kernelSpec.metadata?.interpreter?.path, i.path)
            ) {
                traceInfo(`Kernel ${kernelSpec.name} matches ${i.displayName} based on metadata path.`);
                return true;
            }
            return false;
        });
        if (exactMatch) {
            return exactMatch;
        }
        // 2. Check if we have a fully qualified path in `argv`
        const pathInArgv =
            kernelSpec && Array.isArray(kernelSpec.argv) && kernelSpec.argv.length > 0 ? kernelSpec.argv[0] : undefined;
        const exactMatchBasedOnArgv = interpreters.find((i) => {
            if (
                pathInArgv &&
                path.basename(pathInArgv) !== pathInArgv &&
                this.fs.areLocalPathsSame(pathInArgv, i.path)
            ) {
                traceInfo(`Kernel ${kernelSpec.name} matches ${i.displayName} based on path in argv.`);
                return true;
            }
            return false;
        });
        if (exactMatchBasedOnArgv) {
            return exactMatchBasedOnArgv;
        }
        // 2. Check if `interpreterPath` is defined in kernel metadata.
        if (kernelSpec.interpreterPath) {
            const matchBasedOnInterpreterPath = interpreters.find((i) => {
                if (kernelSpec.interpreterPath && this.fs.areLocalPathsSame(kernelSpec.interpreterPath, i.path)) {
                    traceInfo(`Kernel ${kernelSpec.name} matches ${i.displayName} based on interpreter path.`);
                    return true;
                }
                return false;
            });
            if (matchBasedOnInterpreterPath) {
                return matchBasedOnInterpreterPath;
            }
        }

        return interpreters.find((i) => {
            // 3. Check display name
            if (kernelSpec.display_name === i.displayName) {
                traceInfo(`Kernel ${kernelSpec.name} matches ${i.displayName} based on display name.`);
                return true;
            }

            // We used to use Python 2 or Python 3 to match an interpreter based on version
            // but this seems too ambitious. The kernel spec should just launch with the default
            // python and no environment. Otherwise how do we know which interpreter is the best
            // match?
            traceInfoIf(
                !!process.env.VSC_JUPYTER_LOG_KERNEL_OUTPUT,
                `Kernel ${kernelSpec.name} does not match ${i.displayName} interpreter.`
            );

            return false;
        });
    }
    private async findKernelSpecsInInterpreters(
        interpreters: PythonEnvironment[],
        cancelToken?: CancellationToken
    ): Promise<IJupyterKernelSpec[]> {
        // Find all the possible places to look for this resource
        const paths = await this.findKernelPathsOfAllInterpreters(interpreters);
        const searchResults = await this.findKernelSpecsInPaths(paths, cancelToken);
        let results: IJupyterKernelSpec[] = [];
        await Promise.all(
            searchResults.map(async (resultPath) => {
                // Add these into our path cache to speed up later finds
                const kernelspec = await this.getKernelSpec(
                    resultPath.kernelSpecFile,
                    resultPath.interpreter,
                    cancelToken
                );

                if (kernelspec) {
                    results.push(kernelspec);
                }
            })
        );

        // Filter out duplicates. This can happen when
        // 1) Conda installs kernel
        // 2) Same kernel is registered in the global location
        // We should have extra metadata on the global location pointing to the original
        const originalSpecFiles = new Set<string>();
        results.forEach((r) => {
            if (r.metadata?.originalSpecFile) {
                originalSpecFiles.add(r.metadata?.originalSpecFile);
            }
        });
        results = results.filter((r) => !r.specFile || !originalSpecFiles.has(r.specFile));

        // There was also an old bug where the same item would be registered more than once. Eliminate these dupes
        // too.
        const unique: IJupyterKernelSpec[] = [];
        const byDisplayName = new Map<string, IJupyterKernelSpec>();
        results.forEach((r) => {
            const existing = byDisplayName.get(r.display_name);
            if (existing && existing.path !== r.path) {
                // This item is a dupe but has a different path to start the exe
                unique.push(r);
            } else if (!existing) {
                unique.push(r);
                byDisplayName.set(r.display_name, r);
            }
        });

        return unique;
    }

    /**
     * For the given resource, find atll the file paths for kernel specs that we want to associate with this
     */
    private async findKernelPathsOfAllInterpreters(
        interpreters: PythonEnvironment[]
    ): Promise<(string | { interpreter: PythonEnvironment; kernelSearchPath: string })[]> {
        const kernelSpecPathsAlreadyListed = new Set<string>();
        return interpreters
            .map((interpreter) => {
                return {
                    interpreter,
                    kernelSearchPath: path.join(interpreter.sysPrefix, baseKernelPath)
                };
            })
            .filter((item) => {
                if (kernelSpecPathsAlreadyListed.has(item.kernelSearchPath)) {
                    return false;
                }
                kernelSpecPathsAlreadyListed.add(item.kernelSearchPath);
                return true;
            });
    }
}
