// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import type { nbformat } from '@jupyterlab/coreutils';
import { sha256 } from 'hash.js';
import { inject, injectable } from 'inversify';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cloneDeep = require('lodash/cloneDeep');
import { CancellationToken } from 'vscode-jsonrpc';
import { IPythonExtensionChecker } from '../../../api/types';
import { IApplicationShell } from '../../../common/application/types';
import { PYTHON_LANGUAGE } from '../../../common/constants';
import '../../../common/extensions';
import { traceDecorators, traceError, traceInfo, traceInfoIf } from '../../../common/logger';
import { IConfigurationService, ReadWrite, Resource } from '../../../common/types';
import * as localize from '../../../common/utils/localize';
import { StopWatch } from '../../../common/utils/stopWatch';
import { IInterpreterService } from '../../../interpreter/contracts';
import { PythonEnvironment } from '../../../pythonEnvironments/info';
import { captureTelemetry, IEventNamePropertyMapping, sendTelemetryEvent } from '../../../telemetry';
import { sendNotebookOrKernelLanguageTelemetry } from '../../common';
import { Commands, Telemetry } from '../../constants';
import { sendKernelListTelemetry } from '../../telemetry/kernelTelemetry';
import { IKernelFinder } from '../../kernel-launcher/types';
import { isPythonNotebook } from '../../notebook/helpers/helpers';
import { getInterpreterInfoStoredInMetadata } from '../../notebookStorage/baseModel';
import { PreferredRemoteKernelIdProvider } from '../../notebookStorage/preferredRemoteKernelIdProvider';
import { reportAction } from '../../progress/decorator';
import { ReportableAction } from '../../progress/types';
import {
    IJupyterConnection,
    IJupyterKernelSpec,
    IJupyterSessionManager,
    IJupyterSessionManagerFactory,
    INotebookProviderConnection
} from '../../types';
import {
    createDefaultKernelSpec,
    getDisplayNameOrNameOfKernelConnection,
    isLocalLaunch,
    isPythonKernelConnection
} from './helpers';
import { KernelSelectionProvider } from './kernelSelections';
import { KernelService } from './kernelService';
import {
    DefaultKernelConnectionMetadata,
    IKernelSpecQuickPickItem,
    KernelConnectionMetadata,
    KernelSpecConnectionMetadata,
    LiveKernelConnectionMetadata,
    PythonKernelConnectionMetadata
} from './types';
import { InterpreterPackages } from '../../telemetry/interpreterPackages';

/**
 * All KernelConnections returned (as return values of methods) by the KernelSelector can be used in a number of ways.
 * E.g. some part of the code update the `interpreter` property in the `KernelConnectionMetadata` object.
 * We need to ensure such changes (i.e. updates to the `KernelConnectionMetadata`) downstream do not change the original `KernelConnectionMetadata`.
 * Hence always clone the `KernelConnectionMetadata` returned by the `kernelSelector`.
 */
@injectable()
export class KernelSelector {
    constructor(
        @inject(KernelSelectionProvider) private readonly selectionProvider: KernelSelectionProvider,
        @inject(IApplicationShell) private readonly applicationShell: IApplicationShell,
        @inject(KernelService) private readonly kernelService: KernelService,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IKernelFinder) private readonly kernelFinder: IKernelFinder,
        @inject(IJupyterSessionManagerFactory) private jupyterSessionManagerFactory: IJupyterSessionManagerFactory,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IPythonExtensionChecker) private readonly extensionChecker: IPythonExtensionChecker,
        @inject(PreferredRemoteKernelIdProvider)
        private readonly preferredRemoteKernelIdProvider: PreferredRemoteKernelIdProvider,
        @inject(InterpreterPackages) private readonly interpreterPackages: InterpreterPackages
    ) {}

    /**
     * Selects a kernel from a remote session.
     */
    public async selectRemoteKernel(
        resource: Resource,
        stopWatch: StopWatch,
        sessionManagerCreator: () => Promise<IJupyterSessionManager>,
        cancelToken?: CancellationToken,
        currentKernelDisplayName?: string
    ): Promise<LiveKernelConnectionMetadata | KernelSpecConnectionMetadata | undefined> {
        const suggestions = await this.selectionProvider.getKernelSelectionsForRemoteSession(
            resource,
            sessionManagerCreator,
            cancelToken
        );
        const selection = await this.selectKernel<LiveKernelConnectionMetadata | KernelSpecConnectionMetadata>(
            resource,
            stopWatch,
            Telemetry.SelectRemoteJupyterKernel,
            suggestions,
            cancelToken,
            currentKernelDisplayName
        );
        return cloneDeep(selection);
    }
    /**
     * Select a kernel from a local session.
     */
    public async selectLocalKernel(
        resource: Resource,
        stopWatch: StopWatch,
        cancelToken?: CancellationToken,
        currentKernelDisplayName?: string
    ): Promise<KernelSpecConnectionMetadata | PythonKernelConnectionMetadata | undefined> {
        const suggestions = await this.selectionProvider.getKernelSelectionsForLocalSession(resource, cancelToken);
        const selection = await this.selectKernel<KernelSpecConnectionMetadata | PythonKernelConnectionMetadata>(
            resource,
            stopWatch,
            Telemetry.SelectLocalJupyterKernel,
            suggestions,
            cancelToken,
            currentKernelDisplayName
        );
        if (selection?.interpreter) {
            this.interpreterPackages.trackPackages(selection.interpreter);
        }
        return cloneDeep(selection);
    }
    /**
     * Gets a kernel that needs to be used with a local session.
     * (will attempt to find the best matching kernel, or prompt user to use current interpreter or select one).
     *
     * @param {boolean} [ignoreTrackingKernelInformation]
     * As a side effect these method tracks the kernel information for telemetry, we should ensure that tracking is disabled for Native Notebooks. Native Notebooks knows exactly what the current kernel information is, webviews/interactive is not the same.
     * I.e. whenever these methods are called by webviews/interactive assume the return value is the active kernel.
     */
    @traceDecorators.info('Get preferred local kernel connection')
    @reportAction(ReportableAction.KernelsGetKernelForLocalConnection)
    @captureTelemetry(Telemetry.GetPreferredKernelPerf)
    public async getPreferredKernelForLocalConnection(
        resource: Resource,
        notebookMetadata?: nbformat.INotebookMetadata,
        cancelToken?: CancellationToken
    ): Promise<KernelConnectionMetadata | undefined> {
        const stopWatch = new StopWatch();
        const telemetryProps: IEventNamePropertyMapping[Telemetry.FindKernelForLocalConnection] = {
            kernelSpecFound: false,
            interpreterFound: false,
            promptedToSelect: false
        };
        // When this method is called, we know we've started a local jupyter server or are connecting raw
        // Lets pre-warm the list of local kernels.
        if (this.extensionChecker.isPythonExtensionInstalled) {
            this.selectionProvider.getKernelSelectionsForLocalSession(resource, cancelToken).ignoreErrors();
        }

        let selection = await this.getKernelForLocalConnection(resource, notebookMetadata, cancelToken);

        // If still not found, log an error (this seems possible for some people, so use the default)
        if (!selection || !selection.kernelSpec) {
            traceError('Jupyter Kernel Spec not found for a local connection');
        }

        telemetryProps.kernelSpecFound = !!selection?.kernelSpec;
        telemetryProps.interpreterFound = !!selection?.interpreter;
        sendTelemetryEvent(Telemetry.FindKernelForLocalConnection, stopWatch.elapsedTime, telemetryProps);
        if (
            selection &&
            !selection.interpreter &&
            isPythonKernelConnection(selection) &&
            selection.kind === 'startUsingKernelSpec'
        ) {
            const itemToReturn = cloneDeep(selection) as ReadWrite<
                KernelSpecConnectionMetadata | PythonKernelConnectionMetadata | DefaultKernelConnectionMetadata
            >;
            itemToReturn.interpreter =
                itemToReturn.interpreter ||
                (this.extensionChecker.isPythonExtensionInstalled
                    ? await this.kernelService.findMatchingInterpreter(selection.kernelSpec, cancelToken)
                    : undefined);
            if (itemToReturn.kernelSpec) {
                itemToReturn.kernelSpec.interpreterPath =
                    itemToReturn.kernelSpec.interpreterPath || itemToReturn.interpreter?.path;
            }
            return itemToReturn;
        }
        if (selection?.interpreter) {
            this.interpreterPackages.trackPackages(selection.interpreter);
        }

        return selection;
    }

    /**
     * Gets a kernel that needs to be used with a remote session.
     * (will attempt to find the best matching kernel, or prompt user to use current interpreter or select one).
     *
     * @param {boolean} [ignoreTrackingKernelInformation]
     * As a side effect these method tracks the kernel information for telemetry, we should ensure that tracking is disabled for Native Notebooks. Native Notebooks knows exactly what the current kernel information is, webviews/interactive is not the same.
     * I.e. whenever these methods are called by webviews/interactive assume the return value is the active kernel.
     */
    // eslint-disable-next-line complexity
    @traceDecorators.info('Get preferred remote kernel connection')
    @reportAction(ReportableAction.KernelsGetKernelForRemoteConnection)
    @captureTelemetry(Telemetry.GetPreferredKernelPerf)
    public async getPreferredKernelForRemoteConnection(
        resource: Resource,
        sessionManager?: IJupyterSessionManager,
        notebookMetadata?: nbformat.INotebookMetadata,
        cancelToken?: CancellationToken
    ): Promise<KernelConnectionMetadata | undefined> {
        const [interpreter, specs, sessions] = await Promise.all([
            this.extensionChecker.isPythonExtensionInstalled
                ? this.interpreterService.getActiveInterpreter(resource)
                : Promise.resolve(undefined),
            this.kernelService.getKernelSpecs(sessionManager, cancelToken),
            sessionManager?.getRunningSessions()
        ]);

        // First check for a live active session.
        const preferredKernelId = resource
            ? this.preferredRemoteKernelIdProvider.getPreferredRemoteKernelId(resource)
            : undefined;
        if (preferredKernelId) {
            const session = sessions?.find((s) => s.kernel.id === preferredKernelId);
            if (session) {
                traceInfo(
                    `Got Preferred kernel for ${resource?.toString()} & it is ${preferredKernelId} & found a matching session`
                );
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const liveKernel = session.kernel as any;
                const lastActivityTime = liveKernel.last_activity
                    ? new Date(Date.parse(liveKernel.last_activity.toString()))
                    : new Date();
                const numberOfConnections = liveKernel.connections
                    ? parseInt(liveKernel.connections.toString(), 10)
                    : 0;
                return cloneDeep({
                    kernelModel: { ...session.kernel, lastActivityTime, numberOfConnections, session },
                    interpreter: interpreter,
                    kind: 'connectToLiveKernel'
                });
            } else {
                traceInfo(
                    `Got Preferred kernel for ${resource?.toString()} & it is ${preferredKernelId}, but without a matching session`
                );
            }
        } else {
            traceInfo(`No preferred kernel for remote notebook connection ${resource?.toString()}`);
        }

        // No running session, try matching based on interpreter
        let bestMatch: IJupyterKernelSpec | undefined;
        let bestScore = -1;
        for (let i = 0; specs && i < specs?.length; i = i + 1) {
            const spec = specs[i];
            let score = 0;

            if (spec) {
                // See if the path matches.
                if (spec && spec.path && spec.path.length > 0 && interpreter && spec.path === interpreter.path) {
                    // Path match
                    score += 8;
                }

                // See if the version is the same
                if (interpreter && interpreter.version && spec && spec.name) {
                    // Search for a digit on the end of the name. It should match our major version
                    const match = /\D+(\d+)/.exec(spec.name);
                    if (match && match !== null && match.length > 0) {
                        // See if the version number matches
                        const nameVersion = parseInt(match[1][0], 10);
                        if (nameVersion && nameVersion === interpreter.version.major) {
                            score += 4;
                        }
                    }
                }

                // See if the display name already matches.
                if (spec.display_name && spec.display_name === notebookMetadata?.kernelspec?.display_name) {
                    score += 16;
                }

                // Find a kernel spec that matches the language in the notebook metadata.
                const nbMetadataLanguage = isPythonNotebook(notebookMetadata)
                    ? PYTHON_LANGUAGE
                    : (notebookMetadata?.kernelspec?.language as string) || notebookMetadata?.language_info?.name;
                if (score === 0 && spec.language?.toLowerCase() === (nbMetadataLanguage || '').toLowerCase()) {
                    score = 1;
                }
            }

            if (score > bestScore) {
                bestMatch = spec;
                bestScore = score;
            }
        }

        let kernelConnection: KernelConnectionMetadata;
        if (bestMatch) {
            kernelConnection = cloneDeep({
                kernelSpec: bestMatch,
                interpreter: interpreter,
                kind: 'startUsingKernelSpec'
            });
        } else {
            traceError('No preferred kernel, using the default kernel');
            // Unlikely scenario, we expect there to be at least one kernel spec.
            // Either way, return so that we can start using the default kernel.
            kernelConnection = cloneDeep({
                interpreter: interpreter,
                kind: 'startUsingDefaultKernel'
            });
        }

        return kernelConnection;
    }
    public async askForLocalKernel(
        resource: Resource,
        kernelConnection?: KernelConnectionMetadata
    ): Promise<KernelConnectionMetadata | undefined> {
        const displayName = getDisplayNameOrNameOfKernelConnection(kernelConnection);
        const message = localize.DataScience.sessionStartFailedWithKernel().format(
            displayName,
            Commands.ViewJupyterOutput
        );
        const selectKernel = localize.DataScience.selectDifferentKernel();
        const cancel = localize.Common.cancel();
        const selection = await this.applicationShell.showErrorMessage(message, selectKernel, cancel);
        if (selection === selectKernel) {
            const item = await this.selectLocalJupyterKernel(resource, displayName);
            return cloneDeep(item);
        }
    }
    public async selectJupyterKernel(
        resource: Resource,
        connection: INotebookProviderConnection | undefined,
        currentKernelDisplayName: string | undefined
    ): Promise<KernelConnectionMetadata | undefined> {
        let kernelConnection: KernelConnectionMetadata | undefined;
        const isLocalConnection = connection?.localLaunch ?? isLocalLaunch(this.configService);

        if (isLocalConnection) {
            kernelConnection = await this.selectLocalJupyterKernel(resource, currentKernelDisplayName);
        } else if (connection && connection.type === 'jupyter') {
            kernelConnection = await this.selectRemoteJupyterKernel(resource, connection, currentKernelDisplayName);
        }
        return cloneDeep(kernelConnection);
    }

    private async selectLocalJupyterKernel(
        resource: Resource,
        currentKernelDisplayName: string | undefined
    ): Promise<KernelConnectionMetadata | undefined> {
        return this.selectLocalKernel(resource, new StopWatch(), undefined, currentKernelDisplayName);
    }

    private async selectRemoteJupyterKernel(
        resource: Resource,
        connInfo: IJupyterConnection,
        currentKernelDisplayName?: string
    ): Promise<KernelConnectionMetadata | undefined> {
        const stopWatch = new StopWatch();
        const sessionManagerCreator = () => this.jupyterSessionManagerFactory.create(connInfo);
        return this.selectRemoteKernel(resource, stopWatch, sessionManagerCreator, undefined, currentKernelDisplayName);
    }

    private async findInterpreterStoredInNotebookMetadata(
        resource: Resource,
        notebookMetadata?: nbformat.INotebookMetadata
    ): Promise<PythonEnvironment | undefined> {
        const info = getInterpreterInfoStoredInMetadata(notebookMetadata);
        if (!info || !this.extensionChecker.isPythonExtensionInstalled) {
            return;
        }
        const interpreters = await this.interpreterService.getInterpreters(resource);
        return interpreters.find((item) => sha256().update(item.path).digest('hex') === info.hash);
    }
    /**
     * Get our kernelspec and interpreter for a local raw connection
     *
     * @param {boolean} [ignoreTrackingKernelInformation]
     * As a side effect these method tracks the kernel information for telemetry, we should ensure that tracking is disabled for Native Notebooks. Native Notebooks knows exactly what the current kernel information is, webviews/interactive is not the same.
     * I.e. whenever these methods are called by webviews/interactive assume the return value is the active kernel.
     */
    @traceDecorators.verbose('Find kernel spec')
    private async getKernelForLocalConnection(
        resource: Resource,
        notebookMetadata?: nbformat.INotebookMetadata,
        cancelToken?: CancellationToken
    ): Promise<KernelSpecConnectionMetadata | PythonKernelConnectionMetadata | undefined> {
        // If user had selected an interpreter (raw kernel), then that interpreter would be stored in the kernelspec metadata.
        // Find this matching interpreter & start that using raw kernel.
        const interpreterStoredInKernelSpec = await this.findInterpreterStoredInNotebookMetadata(
            resource,
            notebookMetadata
        );
        if (interpreterStoredInKernelSpec) {
            const kernelConnection: PythonKernelConnectionMetadata = {
                kind: 'startUsingPythonInterpreter',
                interpreter: interpreterStoredInKernelSpec
            };
            return kernelConnection;
        }

        // First use our kernel finder to locate a kernelspec on disk
        const hasKernelMetadataForPythonNb =
            isPythonNotebook(notebookMetadata) && notebookMetadata?.kernelspec ? true : false;
        // Don't look for kernel spec for python notebooks if we don't have the kernel metadata.
        const kernelSpec =
            hasKernelMetadataForPythonNb || !isPythonNotebook(notebookMetadata)
                ? await this.kernelFinder.findKernelSpec(resource, notebookMetadata, cancelToken)
                : undefined;
        traceInfoIf(
            !!process.env.VSC_JUPYTER_FORCE_LOGGING,
            `Kernel spec found ${JSON.stringify(kernelSpec)}, metadata ${JSON.stringify(notebookMetadata || '')}`
        );
        const isNonPythonKernelSPec = kernelSpec?.language && kernelSpec.language !== PYTHON_LANGUAGE ? true : false;
        const activeInterpreter = this.extensionChecker.isPythonExtensionInstalled
            ? await this.interpreterService.getActiveInterpreter(resource)
            : undefined;
        if (!kernelSpec && activeInterpreter) {
            // Return current interpreter.
            return {
                kind: 'startUsingPythonInterpreter',
                interpreter: activeInterpreter
            };
        } else if (kernelSpec) {
            // Locate the interpreter that matches our kernelspec (but don't look for interpreter if kernelspec is Not Python).
            const interpreter =
                this.extensionChecker.isPythonExtensionInstalled && !isNonPythonKernelSPec
                    ? await this.kernelService.findMatchingInterpreter(kernelSpec, cancelToken)
                    : undefined;

            const kernelConnection: KernelSpecConnectionMetadata = {
                kind: 'startUsingKernelSpec',
                kernelSpec,
                interpreter
            };
            return kernelConnection;
        } else {
            // No kernel specs, list them all and pick the first one
            const kernelSpecs = await this.kernelFinder.listKernelSpecs(resource);

            // Do a bit of hack and pick a python one first if the resource is a python file
            // Or if its a python notebook.
            if (isPythonNotebook(notebookMetadata) || (resource?.fsPath && resource.fsPath.endsWith('.py'))) {
                const firstPython = kernelSpecs.find((k) => k.language === 'python');
                if (firstPython) {
                    const kernelConnection: KernelSpecConnectionMetadata = {
                        kind: 'startUsingKernelSpec',
                        kernelSpec: firstPython,
                        interpreter: undefined
                    };
                    return kernelConnection;
                }
            }

            // If that didn't work, just pick the first one
            if (kernelSpecs.length > 0) {
                const kernelConnection: KernelSpecConnectionMetadata = {
                    kind: 'startUsingKernelSpec',
                    kernelSpec: kernelSpecs[0],
                    interpreter: undefined
                };
                return kernelConnection;
            }
        }
    }

    private async selectKernel<T extends KernelConnectionMetadata>(
        resource: Resource,
        stopWatch: StopWatch,
        telemetryEvent: Telemetry,
        suggestions: IKernelSpecQuickPickItem<T>[],
        cancelToken?: CancellationToken,
        currentKernelDisplayName?: string
    ) {
        const placeHolder =
            localize.DataScience.selectKernel() +
            (currentKernelDisplayName ? ` (current: ${currentKernelDisplayName})` : '');
        sendTelemetryEvent(telemetryEvent, stopWatch.elapsedTime);
        sendKernelListTelemetry(resource, suggestions, stopWatch);
        const selection = await this.applicationShell.showQuickPick(suggestions, { placeHolder }, cancelToken);
        if (!selection?.selection) {
            return;
        }
        return (this.useSelectedKernel(selection.selection, cancelToken) as unknown) as T | undefined;
    }

    private async useSelectedKernel(
        selection: KernelConnectionMetadata,
        cancelToken?: CancellationToken
    ): Promise<KernelConnectionMetadata | undefined> {
        // Check if ipykernel is installed in this kernel.
        if (selection.kind === 'connectToLiveKernel') {
            sendNotebookOrKernelLanguageTelemetry(Telemetry.SwitchToExistingKernel, selection.kernelModel.language);
            const interpreter = selection.interpreter
                ? selection.interpreter
                : selection.kernelModel && this.extensionChecker.isPythonExtensionInstalled
                ? await this.kernelService.findMatchingInterpreter(selection.kernelModel, cancelToken)
                : undefined;
            return cloneDeep({
                interpreter,
                kernelModel: selection.kernelModel,
                kind: 'connectToLiveKernel'
            });
        } else if (selection.kernelSpec) {
            sendNotebookOrKernelLanguageTelemetry(Telemetry.SwitchToExistingKernel, selection.kernelSpec.language);
            const interpreter = selection.interpreter
                ? selection.interpreter
                : selection.kernelSpec && this.extensionChecker.isPythonExtensionInstalled
                ? await this.kernelService.findMatchingInterpreter(selection.kernelSpec, cancelToken)
                : undefined;
            await this.kernelService.updateKernelEnvironment(interpreter, selection.kernelSpec, cancelToken);
            return cloneDeep({ kernelSpec: selection.kernelSpec, interpreter, kind: 'startUsingKernelSpec' });
        } else if (selection.interpreter) {
            sendTelemetryEvent(Telemetry.SwitchToInterpreterAsKernel);
            // No kernelspec just create a dummy one
            const kernelSpec = createDefaultKernelSpec(selection.interpreter);
            return { kernelSpec, interpreter: selection.interpreter, kind: 'startUsingPythonInterpreter' };
        } else {
            return;
        }
    }
}
