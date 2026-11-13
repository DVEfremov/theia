// *****************************************************************************
// Copyright (C) 2026 1C-Soft LLC and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { enableJSDOM } from '@theia/core/lib/browser/test/jsdom';
let disableJSDOM = enableJSDOM();

import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
FrontendApplicationConfigProvider.set({});

import { CancellationToken, Emitter, ILogger } from '@theia/core';
import { Container, injectable } from '@theia/core/shared/inversify';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Git, GitUtils, Repository, WorkingDirectoryStatus } from '../common';
import { GitStatusChangeEvent } from '../common/git-watcher';
import {
    GitHistoryItemChangesParser, GitHistoryItemRefsParser, GitHistoryItemsParser, GitHistoryItemStatisticsParser, GitHistoryProvider
} from './git-history-provider';
import { GitRepositoryTracker } from './git-repository-tracker';
import { GitScmProvider } from './git-scm-provider';

disableJSDOM();

/**
 * Records the status events the provider handles, including the status taken from the SCM provider on the first subscription.
 */
@injectable()
class TestGitHistoryProvider extends GitHistoryProvider {

    readonly handledStatuses: WorkingDirectoryStatus[] = [];

    protected override async handleGitStatusChange(event: GitStatusChangeEvent | undefined): Promise<void> {
        if (event && event.source.localUri === this.repository.localUri) {
            this.handledStatuses.push(event.status);
        }
        return super.handleGitStatusChange(event);
    }
}

describe('GitHistoryProvider', () => {

    const repository: Repository = { localUri: 'file:///tmp/GitHistoryProvider.test/repo' };

    let provider: TestGitHistoryProvider;
    let onGitEventEmitter: Emitter<GitStatusChangeEvent | undefined>;
    let storedStatus: WorkingDirectoryStatus | undefined;
    let exec: sinon.SinonStub;
    let logger: { debug: sinon.SinonStub, warn: sinon.SinonStub, error: sinon.SinonStub };

    function createStatus(branch: string | undefined, upstreamBranch?: string, currentHead?: string): WorkingDirectoryStatus {
        return { exists: true, changes: [], branch, upstreamBranch, currentHead, branches: [], tags: [] };
    }

    function createRepositoryDoesNotExistError(): Error {
        const error = new Error('This is not a git repository.') as Error & { code?: string };
        error.code = GitUtils.RepositoryDoesNotExistErrorCode;
        return error;
    }

    /** Waits until the promise chains started by the provider have settled. */
    async function settled(): Promise<void> {
        await new Promise<void>(resolve => setImmediate(resolve));
    }

    before(() => {
        disableJSDOM = enableJSDOM();
    });
    after(() => {
        disableJSDOM();
    });

    beforeEach(() => {
        onGitEventEmitter = new Emitter<GitStatusChangeEvent | undefined>();
        storedStatus = undefined;
        exec = sinon.stub().resolves({ stdout: '', stderr: '', exitCode: 0 });
        logger = { debug: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

        const container = new Container();
        container.bind(ILogger).toConstantValue(logger as unknown as ILogger);
        container.bind(Git).toConstantValue({ exec, remote: sinon.stub().resolves([]) } as unknown as Git);
        container.bind(GitScmProvider).toConstantValue({ repository, getStatus: () => storedStatus } as unknown as GitScmProvider);
        container.bind(GitRepositoryTracker).toConstantValue({ onGitEvent: onGitEventEmitter.event } as unknown as GitRepositoryTracker);
        container.bind(GitHistoryItemStatisticsParser).toSelf();
        container.bind(GitHistoryItemsParser).toSelf();
        container.bind(GitHistoryItemRefsParser).toSelf();
        container.bind(GitHistoryItemChangesParser).toSelf();
        container.bind(TestGitHistoryProvider).toSelf();
        provider = container.get(TestGitHistoryProvider);
    });

    describe('first subscription', () => {

        it('should take the current status from the SCM provider', async () => {
            storedStatus = createStatus('main');

            const changed = new Promise<void>(resolve => provider.onDidChangeCurrentHistoryItemRefs(() => resolve()));
            await changed;

            expect(provider.handledStatuses).to.deep.equal([storedStatus]);
            expect(provider.currentHistoryItemRef).to.deep.include({ id: 'refs/heads/main', name: 'main' });
        });

        it('should wait for the tracker when the SCM provider has no status yet', async () => {
            provider.onDidChangeCurrentHistoryItemRefs(() => { });
            await settled();
            expect(provider.handledStatuses).to.be.empty;

            const status = createStatus('main');
            onGitEventEmitter.fire({ source: repository, status });
            await settled();

            expect(provider.handledStatuses).to.deep.equal([status]);
            expect(provider.currentHistoryItemRef).to.deep.include({ id: 'refs/heads/main', name: 'main' });
        });

        it('should take a detached HEAD from the stored status', async () => {
            storedStatus = createStatus(undefined, undefined, 'abc1234');

            const changed = new Promise<void>(resolve => provider.onDidChangeCurrentHistoryItemRefs(() => resolve()));
            await changed;

            expect(provider.currentHistoryItemRef).to.deep.include({ id: 'abc1234', name: 'abc1234', revision: 'abc1234' });
        });

        it('should take the stored status again when the listeners are re-attached after a change', async () => {
            storedStatus = createStatus('main');
            const listener = provider.onDidChangeHistoryItemRefs(() => { });
            await settled();

            // The provider is not subscribed to the tracker while nobody listens, so it misses the checkout
            listener.dispose();
            storedStatus = createStatus('feature');
            provider.onDidChangeHistoryItemRefs(() => { });
            await settled();

            expect(provider.handledStatuses).to.have.lengthOf(2);
            expect(provider.currentHistoryItemRef).to.deep.include({ id: 'refs/heads/feature', name: 'feature' });
        });

        it('should neither fire nor call git when the same stored status is handled again', async () => {
            storedStatus = createStatus('main');
            let fired = 0;
            const listener = provider.onDidChangeCurrentHistoryItemRefs(() => fired++);
            await settled();
            const execCalls = exec.callCount;

            listener.dispose();
            provider.onDidChangeCurrentHistoryItemRefs(() => fired++);
            await settled();

            expect(provider.handledStatuses).to.have.lengthOf(2);
            expect(fired).to.equal(1);
            expect(exec.callCount).to.equal(execCalls);
        });

        it('should ignore the status of another repository', async () => {
            provider.onDidChangeCurrentHistoryItemRefs(() => { });
            onGitEventEmitter.fire({ source: { localUri: 'file:///tmp/GitHistoryProvider.test/other' }, status: createStatus('main') });
            await settled();

            expect(provider.handledStatuses).to.be.empty;
            expect(provider.currentHistoryItemRef).to.be.undefined;
        });

    });

    describe('repository does not exist', () => {

        it('should log the failed history request at the debug level', async () => {
            exec.rejects(createRepositoryDoesNotExistError());

            const refs = await provider.provideHistoryItemRefs(undefined, CancellationToken.None);

            expect(refs).to.be.undefined;
            expect(logger.error.called).to.be.false;
            expect(logger.debug.calledOnce).to.be.true;
        });

        it('should log any other failed history request as an error', async () => {
            exec.rejects(new Error('fatal: bad revision'));

            const refs = await provider.provideHistoryItemRefs(undefined, CancellationToken.None);

            expect(refs).to.be.undefined;
            expect(logger.debug.called).to.be.false;
            expect(logger.error.calledOnce).to.be.true;
        });

        it('should neither reject nor log an error when the status cannot be handled', async () => {
            exec.rejects(createRepositoryDoesNotExistError());
            storedStatus = createStatus('main', 'origin/main');

            provider.onDidChangeCurrentHistoryItemRefs(() => { });
            await settled();

            expect(provider.handledStatuses).to.have.lengthOf(1);
            expect(logger.error.called).to.be.false;
            expect(logger.warn.called).to.be.false;
            expect(logger.debug.called).to.be.true;
        });

    });

});
