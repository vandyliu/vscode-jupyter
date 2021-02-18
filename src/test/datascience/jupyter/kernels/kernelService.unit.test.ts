// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { Kernel } from '@jupyterlab/services';
import { assert } from 'chai';
import { cloneDeep } from 'lodash';
import * as path from 'path';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { IPythonExtensionChecker } from '../../../../client/api/types';
import { PYTHON_LANGUAGE } from '../../../../client/common/constants';
import { FileSystem } from '../../../../client/common/platform/fileSystem';
import { IFileSystem } from '../../../../client/common/platform/types';
import { PythonExecutionFactory } from '../../../../client/common/process/pythonExecutionFactory';
import { IPythonExecutionFactory, IPythonExecutionService } from '../../../../client/common/process/types';
import { ReadWrite } from '../../../../client/common/types';
import { JupyterKernelSpec } from '../../../../client/datascience/jupyter/kernels/jupyterKernelSpec';
import { KernelDependencyService } from '../../../../client/datascience/jupyter/kernels/kernelDependencyService';
import { KernelService } from '../../../../client/datascience/jupyter/kernels/kernelService';
import { KernelFinder } from '../../../../client/datascience/kernel-launcher/kernelFinder';
import { IKernelFinder } from '../../../../client/datascience/kernel-launcher/types';
import {
    IJupyterKernelSpec,
    IJupyterSessionManager,
    IJupyterSubCommandExecutionService
} from '../../../../client/datascience/types';
import { IEnvironmentActivationService } from '../../../../client/interpreter/activation/types';
import { IInterpreterService } from '../../../../client/interpreter/contracts';
import { PythonEnvironment } from '../../../../client/pythonEnvironments/info';
import { FakeClock } from '../../../common';

// eslint-disable-next-line
suite('DataScience - KernelService', () => {
    let kernelService: KernelService;
    let interperterService: IInterpreterService;
    let fs: IFileSystem;
    let execFactory: IPythonExecutionFactory;
    let execService: IPythonExecutionService;
    let activationHelper: IEnvironmentActivationService;
    let dependencyService: KernelDependencyService;
    let jupyterInterpreterExecutionService: IJupyterSubCommandExecutionService;
    let kernelFinder: IKernelFinder;

    function initialize() {
        interperterService = mock<IInterpreterService>();
        fs = mock(FileSystem);
        activationHelper = mock<IEnvironmentActivationService>();
        execFactory = mock(PythonExecutionFactory);
        execService = mock<IPythonExecutionService>();
        dependencyService = mock(KernelDependencyService);
        kernelFinder = mock(KernelFinder);
        const extensionChecker = mock<IPythonExtensionChecker>();
        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);
        jupyterInterpreterExecutionService = mock<IJupyterSubCommandExecutionService>();
        when(execFactory.createActivatedEnvironment(anything())).thenResolve(instance(execService));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (instance(execService) as any).then = undefined;

        kernelService = new KernelService(
            instance(jupyterInterpreterExecutionService),
            instance(interperterService),
            instance(fs),
            instance(activationHelper),
            instance(extensionChecker),
            instance(kernelFinder)
        );
    }
    setup(initialize);
    teardown(() => sinon.restore());

    // eslint-disable-next-line
    suite('Registering Interpreters as Kernels', () => {
        let fakeTimer: FakeClock;
        const interpreter: PythonEnvironment = {
            path: path.join('interpreter', 'python'),
            sysPrefix: '',
            sysVersion: '',
            displayName: 'Hello'
        };
        // Marked as readonly, to ensure we do not update this in tests.
        const kernelSpecModel: Readonly<Kernel.ISpecModel> = {
            argv: ['python', '-m', 'ipykernel'],
            display_name: interpreter.displayName!,
            language: PYTHON_LANGUAGE,
            name: 'somme name',
            resources: {},
            env: {},
            metadata: {
                something: '1',
                interpreter: {
                    path: interpreter.path
                }
            }
        };
        const userKernelSpecModel: Readonly<Kernel.ISpecModel> = {
            argv: ['python', '-m', 'ipykernel'],
            display_name: interpreter.displayName!,
            language: PYTHON_LANGUAGE,
            name: 'somme name',
            resources: {},
            env: {},
            metadata: {
                something: '1'
            }
        };
        const kernelJsonFile = path.join('someFile', 'kernel.json');

        setup(() => {
            fakeTimer = new FakeClock();
            initialize();
        });

        teardown(() => fakeTimer.uninstall());

        test('Kernel is found and spec file is updated with interpreter information in metadata along with environment variables', async () => {
            when(execService.execModule('ipykernel', anything(), anything())).thenResolve({ stdout: '' });
            when(dependencyService.areDependenciesInstalled(interpreter, anything())).thenResolve(true);
            const kernel = new JupyterKernelSpec(kernelSpecModel, kernelJsonFile);
            when(kernelFinder.findKernelSpec(anything(), anything(), anything())).thenResolve(kernel);
            when(fs.readLocalFile(kernelJsonFile)).thenResolve(JSON.stringify(kernelSpecModel));
            when(fs.writeLocalFile(kernelJsonFile, anything())).thenResolve();
            const envVariables = { MYVAR: '1' };
            when(activationHelper.getActivatedEnvironmentVariables(undefined, interpreter, true)).thenResolve(
                envVariables
            );
            const expectedKernelJsonContent: ReadWrite<Kernel.ISpecModel> = cloneDeep(kernelSpecModel);
            // Fully qualified path must be injected into `argv`.
            expectedKernelJsonContent.argv = [interpreter.path, '-m', 'ipykernel'];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expectedKernelJsonContent.metadata!.interpreter = interpreter as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expectedKernelJsonContent.env = envVariables as any;

            const installedKernel = await kernelService.searchForKernel(interpreter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.deepEqual(kernel, installedKernel as any);
            verify(fs.writeLocalFile(kernelJsonFile, anything())).once();
            // Verify the contents of JSON written to the file match as expected.
            assert.deepEqual(JSON.parse(capture(fs.writeLocalFile).first()[1] as string), expectedKernelJsonContent);
        });
        test('Kernel is found and spec file is not updated with interpreter information when user spec file', async () => {
            when(execService.execModule('ipykernel', anything(), anything())).thenResolve({ stdout: '' });
            when(dependencyService.areDependenciesInstalled(interpreter, anything())).thenResolve(true);
            const kernel = new JupyterKernelSpec(userKernelSpecModel, kernelJsonFile);
            when(kernelFinder.findKernelSpec(anything(), anything(), anything())).thenResolve(kernel);
            when(fs.readLocalFile(kernelJsonFile)).thenResolve(JSON.stringify(userKernelSpecModel));
            let contents: string | undefined;
            when(fs.writeLocalFile(kernelJsonFile, anything())).thenCall((_f, c) => {
                contents = c;
                return Promise.resolve();
            });
            const envVariables = { MYVAR: '1' };
            when(activationHelper.getActivatedEnvironmentVariables(undefined, interpreter, true)).thenResolve(
                envVariables
            );
            findMatchingKernelSpecStub.resolves(kernel);

            const installedKernel = await kernelService.searchForKernel(interpreter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.deepEqual(kernel, installedKernel as any);
            assert.ok(contents, 'Env not updated');
            const obj = JSON.parse(contents!);
            assert.notOk(obj.metadata.interpreter, 'MetaData should not have been written');
        });
    });
});
