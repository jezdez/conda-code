import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { Package, PackageManager, PythonEnvironment } from '@vscode/python-environments';

import type { CondaClient } from './conda';
import { pythonApi, requireFromTest, type VscodeStub } from './testUtils';
import type { CondaWorkspaceRoute, CondaWorkspaceRouteManager } from './workspaceRouting';
import type { CondaWorkspacesClient, DependencyChangeOptions } from './workspaces';

function modules() {
  const vscode = requireFromTest('vscode') as VscodeStub;
  const packageManager = requireFromTest(
    './packageManager.js',
  ) as typeof import('./packageManager.js');
  return { vscode, packageManager };
}

function packageFixture() {
  const { vscode, packageManager } = modules();
  const prefix = path.resolve('/work/demo/.conda/envs/default');
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const route: CondaWorkspaceRoute = {
    prefix,
    projectUri: vscode.Uri.file('/work/demo'),
    manifestUri: vscode.Uri.file('/work/demo/conda.toml'),
    pythonPath: path.join(prefix, 'bin/python'),
    environmentName: 'default',
    features: ['dev'],
    snapshotAvailable: false,
    packages: [],
    directDependencies: [{ name: 'numpy', pypi: false, location: { environment: 'default' } }],
  };
  const state = {
    route: route as CondaWorkspaceRoute | undefined,
    environment: environment as PythonEnvironment | undefined,
    conflicted: false,
  };
  const calls: string[] = [];
  const conda = {
    forExecutable: () => conda,
    listPrefixPackages: async () => [{ name: 'numpy', version: '1.0', build: '0' }],
    removePackages: async () => {
      calls.push('remove');
    },
    installPackages: async () => {
      calls.push('install');
    },
  };
  const routes = {
    getRoute: () => state.route,
    getEnvironmentForPrefix: () => state.environment,
    getEnvironmentForRoute: () => state.environment,
    isConflictedPrefix: () => state.conflicted,
    getCondaExecutableForPrefix: () => 'conda',
    invalidateRegularDiscovery: () => {
      calls.push('invalidate');
    },
    refresh: async () => {
      calls.push('refresh');
    },
  };
  const workspaces = {
    addDependencies: async () => {
      calls.push('add');
    },
    removeDependencies: async () => {
      calls.push('remove');
    },
    updateDependencies: async () => {
      calls.push('update');
    },
  };
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda as unknown as CondaClient,
    workspaces as unknown as CondaWorkspacesClient,
    routes,
  );
  return { packages, environment, state, calls, conda, routes, workspaces };
}

function deferredPackages() {
  type Records = { name: string; version: string; build: string }[];
  let resolve!: (value: Records) => void;
  const promise = new Promise<Records>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('shared dependency updates require confirmation and cancellation makes no changes', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = {
    ...f.state.route!,
    directDependencies: [{ name: 'numpy', pypi: false, location: { feature: 'dev' } }],
  };
  const { window } = requireFromTest('vscode') as typeof import('vscode');
  let confirmed = false;
  let prompts = 0;
  t.mock.method(window, 'showWarningMessage', async () => {
    prompts++;
    return confirmed ? 'Update' : undefined;
  });
  await f.packages.manage(f.environment, { install: ['numpy>=2'] });
  assert.equal(prompts, 1);
  assert.equal(f.calls.includes('update'), false);
  confirmed = true;
  await f.packages.manage(f.environment, { install: ['numpy>=2'] });
  assert.equal(f.calls.filter((c) => c === 'update').length, 1);
  assert.equal(f.calls.includes('add'), false);
});

test('invalid addition target is rejected before any removal', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = { ...f.state.route!, features: [] };
  await assert.rejects(
    f.packages.manage(f.environment, { uninstall: ['numpy'], install: ['pytest'] }),
    /exactly one feature/,
  );
  assert.equal(f.calls.includes('remove'), false);
});

test('confirmation accepts refreshed equivalent routes but rejects changed declarations', async (t) => {
  for (const changed of [false, true]) {
    await t.test(changed ? 'changed declaration' : 'equivalent route', async (t) => {
      const f = packageFixture();
      t.after(() => f.packages.dispose());
      f.state.route = {
        ...f.state.route!,
        directDependencies: [{ name: 'numpy', pypi: false, location: { feature: 'dev' } }],
      };
      const { window } = requireFromTest('vscode') as typeof import('vscode');
      t.mock.method(window, 'showWarningMessage', async () => {
        f.state.route = {
          ...f.state.route!,
          directDependencies: [
            { name: 'numpy', pypi: false, location: { feature: changed ? 'other' : 'dev' } },
          ],
        };
        return 'Update';
      });
      const operation = f.packages.manage(f.environment, { install: ['numpy'], upgrade: true });
      if (changed) {
        await assert.rejects(operation, /changed/);
        assert.equal(f.calls.includes('update'), false);
      } else {
        await operation;
        assert.equal(f.calls.filter((call) => call === 'update').length, 1);
      }
    });
  }
});

test('workspace mutation rejects transitive packages before changing direct packages', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  await assert.rejects(
    f.packages.manage(f.environment, { uninstall: ['numpy', 'transitive'] }),
    /Only direct/,
  );
  assert.equal(f.calls.includes('remove'), false);
});

test('workspace removal groups dependencies with the same selector', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = {
    ...f.state.route!,
    directDependencies: ['numpy', 'scipy'].map((name) => ({
      name,
      pypi: false,
      location: { environment: 'default' },
    })),
  };
  const removals: unknown[] = [];
  t.mock.method(f.workspaces, 'removeDependencies', async (...args: unknown[]) => {
    removals.push(args);
  });
  await f.packages.manage(f.environment, { uninstall: ['numpy', 'scipy'], runHeadless: true });
  assert.deepEqual(removals, [
    [f.state.route.manifestUri.fsPath, ['numpy', 'scipy'], { environment: 'default', pypi: false }],
  ]);
});

test('failed recovery does not mask a mutation error or retain old packages', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = undefined;
  await f.packages.getPackages(f.environment);
  const failure = new Error('install failed');
  f.conda.installPackages = async () => {
    throw failure;
  };
  f.routes.refresh = async () => {
    throw new Error('refresh failed');
  };
  await assert.rejects(
    f.packages.manage(f.environment, { install: ['pytest'] }),
    (e) => e === failure,
  );
  f.conda.listPrefixPackages = async () => [];
  assert.deepEqual(await f.packages.getPackages(f.environment), []);
});

test('regular partial mutation failure refreshes packages and preserves original error', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = undefined;
  await f.packages.getPackages(f.environment);
  const removed: string[] = [];
  f.packages.onDidChangePackages((event) => {
    for (const change of event.changes) if (change.kind === 'remove') removed.push(change.pkg.name);
  });
  const failure = new Error('install failed');
  f.conda.removePackages = async () => {
    f.conda.listPrefixPackages = async () => [];
  };
  f.conda.installPackages = async () => {
    throw failure;
  };
  await assert.rejects(
    f.packages.manage(f.environment, { uninstall: ['numpy'], install: ['pytest'] }),
    (e) => e === failure,
  );
  assert.deepEqual(await f.packages.getPackages(f.environment), []);
  assert.deepEqual(removed, ['numpy']);
  assert.ok(f.calls.includes('invalidate'));
});

test('workspace mutations revalidate identity after refresh and confirmation', async (t) => {
  for (const phase of ['refresh', 'confirmation']) {
    await t.test(phase, async (t) => {
      const f = packageFixture();
      t.after(() => f.packages.dispose());
      const replace = () => {
        f.state.environment = {
          ...f.environment,
          envId: { ...f.environment.envId, id: 'replacement' },
        };
      };
      if (phase === 'refresh')
        f.routes.refresh = async () => {
          replace();
        };
      else {
        f.state.route = {
          ...f.state.route!,
          directDependencies: [{ name: 'numpy', pypi: false, location: { feature: 'dev' } }],
        };
        const { window } = requireFromTest('vscode') as typeof import('vscode');
        t.mock.method(window, 'showWarningMessage', async () => {
          replace();
          return 'Update';
        });
      }
      await assert.rejects(f.packages.manage(f.environment, { install: ['numpy'] }), /own/);
      assert.equal(f.calls.includes('add'), false);
      assert.equal(f.calls.includes('update'), false);
    });
  }
});

test('fresh workspace reads reject ownership changes rather than using regular listing', async (t) => {
  for (const change of ['removed', 'conflicted', 'replaced'] as const) {
    await t.test(change, async (t) => {
      const f = packageFixture();
      t.after(() => f.packages.dispose());
      let lists = 0;
      f.conda.listPrefixPackages = async () => {
        lists++;
        return [];
      };
      f.routes.refresh = async () => {
        f.state.route = undefined;
        if (change === 'removed') f.state.environment = undefined;
        if (change === 'conflicted') f.state.conflicted = true;
        if (change === 'replaced')
          f.state.environment = {
            ...f.environment,
            envId: { ...f.environment.envId, id: 'replacement' },
          };
      };
      await assert.rejects(
        f.packages.getPackages(f.environment, { skipCache: true }),
        /own|conflict|claim|changed/i,
      );
      assert.equal(lists, 0);
    });
  }
});

test('mutation batches stop between writes when their target is no longer owned', async (t) => {
  for (const mode of ['regular', 'workspace-add', 'workspace-remove', 'workspace-update']) {
    for (const change of ['dispose', 'lost', 'conflicted', 'rerouted']) {
      await t.test(`${mode}: ${change}`, async (t) => {
        const f = packageFixture();
        t.after(() => f.packages.dispose());
        const originalRoute = f.state.route!;
        f.state.route =
          mode === 'regular'
            ? undefined
            : {
                ...originalRoute,
                snapshotAvailable: true,
                directDependencies: [
                  { name: 'numpy', pypi: false, location: { environment: 'default' } },
                  { name: 'scipy', pypi: false, location: { feature: 'dev' } },
                ],
              };
        const pending = deferredPackages();
        let started!: () => void;
        const firstWrite = new Promise<void>((resolve) => {
          started = resolve;
        });
        let writes = 0;
        const write = async () => {
          writes++;
          if (writes === 1) {
            started();
            await pending.promise;
          }
        };
        f.conda.removePackages = write;
        f.conda.installPackages = write;
        f.workspaces.removeDependencies = write;
        f.workspaces.addDependencies = write;
        f.workspaces.updateDependencies = write;
        const options =
          mode === 'workspace-remove'
            ? { uninstall: ['numpy', 'scipy'] }
            : mode === 'workspace-update'
              ? { install: ['numpy', 'scipy'], upgrade: true }
              : { uninstall: ['numpy'], install: ['pytest'] };
        const operation = f.packages.manage(f.environment, options);
        const rejected = assert.rejects(operation, /disposed|own|claim|conflict|changed/i);
        await firstWrite;
        if (change === 'dispose') f.packages.dispose();
        if (change === 'lost') f.state.environment = undefined;
        if (change === 'conflicted') f.state.conflicted = true;
        if (change === 'rerouted')
          f.state.route =
            mode === 'regular' ? originalRoute : { ...f.state.route!, environmentName: 'other' };
        pending.resolve([]);
        await rejected;
        assert.equal(writes, 1, 'No next mutation may run after losing the target');
      });
    }
  }
});

test('workspace mutation permits refreshed route objects with the same target', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = { ...f.state.route!, snapshotAvailable: true };
  f.workspaces.removeDependencies = async () => {
    f.calls.push('remove');
    f.state.route = { ...f.state.route!, packages: [], directDependencies: [] };
  };
  await f.packages.manage(f.environment, { uninstall: ['numpy'], install: ['pytest'] });
  assert.deepEqual(
    f.calls.filter((call) => call === 'remove' || call === 'add'),
    ['remove', 'add'],
  );
});

test('regular mutation stops if its conda executable changes between writes', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = undefined;
  f.conda.removePackages = async () => {
    f.routes.getCondaExecutableForPrefix = () => 'other-conda';
  };
  await assert.rejects(
    f.packages.manage(f.environment, { uninstall: ['numpy'], install: ['pytest'] }),
    /own|changed/,
  );
  assert.equal(f.calls.includes('install'), false);
});

test('package reads cannot commit after invalidation or disposal', async (t) => {
  for (const action of ['clear', 'dispose'] as const) {
    await t.test(action, async () => {
      const f = packageFixture();
      f.state.route = undefined;
      const pending = deferredPackages();
      f.conda.listPrefixPackages = () => pending.promise;
      const events: unknown[] = [];
      f.packages.onDidChangePackages((e) => events.push(e));
      const read = f.packages.refresh(f.environment);
      const rejection = assert.rejects(read, /superseded|disposed/i);
      if (action === 'clear') await f.packages.clearCache();
      else f.packages.dispose();
      pending.resolve([{ name: 'old', version: '1', build: '0' }]);
      await rejection;
      assert.deepEqual(events, []);
      if (action === 'clear') {
        f.conda.listPrefixPackages = async () => [];
        assert.deepEqual(await f.packages.getPackages(f.environment), []);
      }
      f.packages.dispose();
    });
  }
});

test('older package reads cannot overwrite a newer refresh', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = undefined;
  const pending = deferredPackages();
  f.conda.listPrefixPackages = () => pending.promise;
  const old = f.packages.getPackages(f.environment);
  f.conda.listPrefixPackages = async () => [{ name: 'new', version: '2', build: '0' }];
  await f.packages.refresh(f.environment);
  pending.resolve([{ name: 'old', version: '1', build: '0' }]);
  assert.equal((await old)?.[0]?.name, 'old');
  assert.equal((await f.packages.getPackages(f.environment))?.[0]?.name, 'new');
});

test('watcher reads do not turn successful mutations into failures', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = undefined;
  const pending = deferredPackages();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.conda.listPrefixPackages = () => {
    started();
    return pending.promise;
  };
  const mutation = f.packages.manage(f.environment, { install: ['pytest'] });
  await reading;
  f.conda.listPrefixPackages = async () => [{ name: 'new', version: '2', build: '0' }];
  await f.packages.getPackages(f.environment, { skipCache: true });
  pending.resolve([{ name: 'old', version: '1', build: '0' }]);
  await mutation;
  assert.equal((await f.packages.getPackages(f.environment))?.[0]?.name, 'new');
});

test('cached workspace refresh uses current scoped metadata and new environment identity', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = {
    ...f.state.route!,
    packages: [{ name: 'numpy', version: '2', build: '0' }],
  };
  const before = (await f.packages.getPackages(f.environment))![0]!;
  const replacement = {
    ...f.environment,
    envId: { ...f.environment.envId, id: 'replacement' },
  };
  f.state.environment = replacement;
  await f.packages.refreshCachedPackages();
  const after = (await f.packages.getPackages(replacement))![0]!;
  assert.notEqual(after, before);
  assert.equal(after.pkgId.environmentId, replacement.envId.id);
  assert.equal(await f.packages.getPackages(f.environment), undefined);
  f.state.route = {
    ...f.state.route!,
    directDependencies: [{ name: 'numpy', pypi: true, table: 'feature.dev.pypi-dependencies' }],
  };
  await f.packages.refreshCachedPackages();
  const updated = (await f.packages.getPackages(replacement))![0]!;
  assert.equal(updated.description, 'Build 0, Direct PyPI dependency');
  assert.equal(updated.tooltip, 'Declared in feature.dev.pypi-dependencies');
  assert.deepEqual(await f.packages.getDirectPackageNames(replacement), new Set(['numpy']));
  assert.deepEqual(f.calls, [], 'Cached refresh must consume already-refreshed scoped routes');
});

test('clearing caches also forgets environments tracked for refresh', async (t) => {
  const f = packageFixture();
  t.after(() => f.packages.dispose());
  f.state.route = undefined;
  await f.packages.getPackages(f.environment);
  await f.packages.clearCache();
  f.conda.listPrefixPackages = async () => {
    assert.fail('Cleared environments must not be refreshed');
  };
  await f.packages.refreshCachedPackages();
});

test('workspace package changes follow snapshot capabilities', async (t) => {
  const { vscode, packageManager } = modules();
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const prefix = '/work/demo/.conda/envs/default';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  let route: CondaWorkspaceRoute = {
    projectUri,
    manifestUri,
    environmentName: 'default',
    features: ['dev', 'test'],
    directDependencies: [
      { name: 'python', pypi: false },
      { name: 'numpy', pypi: false },
    ],
    packages: [],
    snapshotAvailable: false,
    prefix,
    pythonPath: `${prefix}/bin/python`,
  };
  const routes = {
    getRoute: () => route,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as CondaWorkspaceRouteManager;
  const changes: {
    readonly operation: 'add' | 'remove' | 'update';
    readonly specs: readonly string[];
    readonly environment?: string;
    readonly feature?: string;
    readonly platform?: string;
    readonly pypi?: boolean;
  }[] = [];
  const record = (
    operation: 'add' | 'remove' | 'update',
    specs: readonly string[],
    options: DependencyChangeOptions,
  ) => {
    changes.push({
      operation,
      specs: [...specs],
      environment: options.environment,
      feature: options.feature,
      platform: options.platform,
      pypi: options.pypi,
    });
  };
  const workspaces = {
    addDependencies: async (
      _manifest: string,
      specs: readonly string[],
      options: DependencyChangeOptions,
    ) => record('add', specs, options),
    removeDependencies: async (
      _manifest: string,
      specs: readonly string[],
      options: DependencyChangeOptions,
    ) => record('remove', specs, options),
    updateDependencies: async (
      _manifest: string,
      specs: readonly string[],
      options: DependencyChangeOptions,
    ) => record('update', specs, options),
  } as unknown as CondaWorkspacesClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    workspaces,
    routes,
  );
  t.after(() => packages.dispose());

  await assert.rejects(
    packages.manage(environment, { install: ['pytest'], runHeadless: true }),
    /exactly one feature/,
  );
  await assert.rejects(
    packages.manage(environment, { install: ['numpy'], upgrade: true }),
    /structured declaration location/,
  );
  await assert.rejects(
    packages.manage(environment, { uninstall: ['numpy'] }),
    /structured declaration location/,
  );
  assert.deepEqual(changes, []);

  route = { ...route, snapshotAvailable: true };
  await packages.manage(environment, { install: ['pytest'], runHeadless: true });

  route = {
    ...route,
    directDependencies: [
      { name: 'numpy', pypi: false, location: { environment: 'default' } },
      { name: 'black', pypi: true, location: { environment: 'default' } },
    ],
  };
  await assert.rejects(
    packages.manage(environment, {
      uninstall: ['numpy'],
      install: ['black'],
      upgrade: true,
    }),
    /does not support PyPI dependencies/,
  );
  assert.equal(changes.length, 1);

  route = {
    ...route,
    directDependencies: [
      { name: 'numpy', pypi: false, location: { environment: 'default' } },
      { name: 'rich', pypi: false, location: { feature: 'dev', platform: 'linux-64' } },
    ],
  };
  await packages.manage(environment, {
    uninstall: ['numpy'],
    install: ['rich>=14'],
    upgrade: true,
    runHeadless: true,
  });
  assert.equal(changes.length, 1);
  await packages.manage(environment, {
    uninstall: ['numpy'],
    install: ['rich>=14'],
    upgrade: true,
  });

  assert.deepEqual(changes, [
    {
      operation: 'add',
      specs: ['pytest'],
      environment: 'default',
      feature: undefined,
      platform: undefined,
      pypi: undefined,
    },
    {
      operation: 'remove',
      specs: ['numpy'],
      environment: 'default',
      feature: undefined,
      platform: undefined,
      pypi: false,
    },
    {
      operation: 'update',
      specs: ['rich>=14'],
      environment: undefined,
      feature: 'dev',
      platform: 'linux-64',
      pypi: undefined,
    },
  ]);
});

test('workspace mutations use fresh locations and reconcile command failures', async (t) => {
  const { vscode, packageManager } = modules();
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const prefix = '/work/demo/.conda/envs/default';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  let route: CondaWorkspaceRoute = {
    projectUri,
    manifestUri,
    environmentName: 'default',
    features: [],
    directDependencies: [{ name: 'numpy', pypi: false, location: { environment: 'default' } }],
    packages: [],
    snapshotAvailable: true,
    prefix,
    pythonPath: `${prefix}/bin/python`,
  };
  let refreshCalls = 0;
  const routes = {
    getRoute: () => route,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => {
      refreshCalls += 1;
      route = {
        ...route,
        directDependencies: [
          { name: 'numpy', pypi: false, location: { feature: 'dev', platform: 'linux-64' } },
        ],
      };
    },
  } as CondaWorkspaceRouteManager;
  const failure = new Error('prefix transaction failed');
  let removalOptions: DependencyChangeOptions | undefined;
  const workspaces = {
    removeDependencies: async (
      _manifest: string,
      _specs: readonly string[],
      options: DependencyChangeOptions,
    ) => {
      removalOptions = options;
      throw failure;
    },
  } as unknown as CondaWorkspacesClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    workspaces,
    routes,
  );
  t.after(() => packages.dispose());

  await assert.rejects(
    packages.manage(environment, { uninstall: ['numpy'] }),
    (error) => error === failure,
  );
  assert.deepEqual(removalOptions, {
    feature: 'dev',
    platform: 'linux-64',
    pypi: false,
  });
  assert.equal(refreshCalls, 2);
});

test('workspace packages identify direct and transitive dependencies', async (t) => {
  const { vscode, packageManager } = modules();
  const projectUri = vscode.Uri.file('/work/demo');
  const manifestUri = vscode.Uri.file('/work/demo/conda.toml');
  const prefix = '/work/demo/.conda/envs/default';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  let route = {
    projectUri,
    manifestUri,
    environmentName: 'default',
    features: [],
    directDependencies: [
      { name: 'python', pypi: false },
      { name: 'rich', pypi: false },
    ],
    packages: [
      { name: 'bzip2', version: '1.0.8', build: 'h1_0' },
      { name: 'Python', version: '3.13.1', build: 'h2_0' },
      { name: 'rich', version: '14.0.0', build: 'py_0' },
    ],
    snapshotAvailable: false,
    prefix,
    pythonPath: `${prefix}/bin/python`,
  };
  let routeRefreshes = 0;
  const routes = {
    getRoute: () => route,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => {
      routeRefreshes += 1;
      route = {
        ...route,
        directDependencies: [...route.directDependencies, { name: 'httpx', pypi: false }],
        packages: [{ name: 'httpx', version: '0.28.1', build: 'py_0' }],
      };
    },
  } as CondaWorkspaceRouteManager;
  let liveReads = 0;
  const workspaces = {
    listPackages: async () => {
      liveReads += 1;
      return [{ name: 'httpx', version: '0.28.1', build: 'py_0' }];
    },
  } as unknown as CondaWorkspacesClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    workspaces,
    routes,
  );
  t.after(() => packages.dispose());

  const provider: PackageManager = packages;
  assert.equal(typeof provider.getDirectPackageNames, 'function');
  assert.deepEqual(await provider.getDirectPackageNames!(environment), new Set(['python', 'rich']));

  assert.deepEqual(
    (await packages.getPackages(environment))?.map((pkg) => ({
      name: pkg.name,
      description: pkg.description,
      isTransitive: (pkg as Package & { readonly isTransitive?: boolean }).isTransitive,
    })),
    [
      {
        name: 'Python',
        description: 'Build h2_0, Direct dependency',
        isTransitive: false,
      },
      {
        name: 'rich',
        description: 'Build py_0, Direct dependency',
        isTransitive: false,
      },
      {
        name: 'bzip2',
        description: 'Build h1_0, Transitive dependency',
        isTransitive: true,
      },
    ],
  );
  assert.equal(liveReads, 0);
  assert.deepEqual(
    (await packages.getPackages(environment, { skipCache: true }))?.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      isTransitive: (pkg as Package & { readonly isTransitive?: boolean }).isTransitive,
    })),
    [{ name: 'httpx', version: '0.28.1', isTransitive: false }],
  );
  assert.equal(liveReads, 0);
  assert.equal(routeRefreshes, 1);
  assert.deepEqual(
    await provider.getDirectPackageNames!(environment),
    new Set(['python', 'rich', 'httpx']),
  );
});

test('package watchers use owned prefixes and regular direct dependencies stay unknown', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = path.resolve('/alternate/envs/demo');
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
    sysPrefix: prefix,
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    isConflictedPrefix: () => false,
  } as unknown as CondaWorkspaceRouteManager;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());
  const provider: PackageManager = packages;
  assert.equal(typeof provider.getPackageWatchTargets, 'function');
  const targets = provider.getPackageWatchTargets!(environment);
  assert.deepEqual(
    targets.map(({ baseUri, pattern }) => [baseUri.fsPath, pattern]),
    [[path.join(prefix, 'conda-meta'), '*.json']],
  );
  assert.equal(await provider.getDirectPackageNames!(environment), undefined);
  const foreign = { ...environment, envId: { ...environment.envId, managerId: 'other:conda' } };
  assert.deepEqual(provider.getPackageWatchTargets!(foreign), []);
  assert.equal(await provider.getDirectPackageNames!(foreign), undefined);
});

test('package version APIs use the owner, sort versions, and reject workspace lookup', async (t) => {
  const { vscode, packageManager } = modules();
  const { CondaClient } = requireFromTest('./conda.js') as typeof import('./conda');
  const prefix = path.resolve('/alternate/envs/demo');
  const owner = path.resolve('/alternate/bin/conda');
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  let route: CondaWorkspaceRoute | undefined = undefined;
  let output = JSON.stringify({
    numpy: [{ version: '2.9' }, { version: '2.10' }, { version: '2.10' }],
  });
  let exitCode = 0;
  const calls: string[] = [];
  const client = new CondaClient({
    runner: {
      run: async (executable, args) => {
        calls.push(executable);
        return {
          exitCode,
          stdout: args[0] === '--version' ? 'conda 26.5.3' : output,
          stderr: 'network unavailable',
        };
      },
    },
  });
  const routes = {
    getRoute: () => route,
    getEnvironmentForPrefix: () => environment,
    getCondaExecutableForPrefix: () => owner,
    isConflictedPrefix: () => false,
  } as unknown as CondaWorkspaceRouteManager;
  const implementation = new packageManager.CondaPackageManager(
    pythonApi([]),
    client,
    {} as CondaWorkspacesClient,
    routes,
  );
  const packages: PackageManager = implementation;
  t.after(() => implementation.dispose());
  assert.equal(typeof packages.getPackageAvailableVersions, 'function');
  assert.deepEqual(
    (await packages.getPackageAvailableVersions!(environment, 'numpy'))?.map((v) => v.public),
    ['2.10', '2.9'],
  );
  assert.equal((await packages.getVersion!(environment))?.public, '26.5.3');
  assert.deepEqual(calls, [owner, owner]);
  assert.equal(packages.formatInstallSpec!('numpy', '2.10'), 'numpy==2.10');
  output = JSON.stringify({ numpy: [{ version: 'not-a-version' }] });
  await assert.rejects(packages.getPackageAvailableVersions!(environment, 'numpy'), /version/i);
  exitCode = 1;
  output = '';
  await assert.rejects(
    packages.getPackageAvailableVersions!(environment, 'numpy'),
    /network unavailable/,
  );
  route = {} as CondaWorkspaceRoute;
  await assert.rejects(packages.getPackageAvailableVersions!(environment, 'numpy'), {
    code: 'PackageVersionLookupNotSupported',
  });
  assert.equal(calls.length, 4);
});

test('package version lookup preserves distinct local versions', async (t) => {
  const { vscode, packageManager } = modules();
  const { CondaClient } = requireFromTest('./conda.js') as typeof import('./conda');
  const prefix = path.resolve('/alternate/envs/demo');
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const client = new CondaClient({
    runner: {
      run: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          numpy: [{ version: '1.0+cpu' }, { version: '1.0+cuda' }, { version: '1.0+cpu' }],
        }),
      }),
    },
  });
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getCondaExecutableForPrefix: () => 'conda',
    isConflictedPrefix: () => false,
  } as unknown as CondaWorkspaceRouteManager;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    client,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());
  assert.deepEqual(
    (await packages.getPackageAvailableVersions(environment, 'numpy')).map((v) => v.local),
    ['cuda', 'cpu'],
  );
});

test('regular package operations use the environment owner', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = path.resolve('/alternate/envs/demo');
  const ownerExecutable = '/alternate/bin/conda';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => ownerExecutable,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  const operations: { readonly operation: string; readonly prefix: string }[] = [];
  const owner = {
    listPrefixPackages: async (target: string) => {
      operations.push({ operation: 'list', prefix: target });
      return [];
    },
    installPackages: async (target: string) => {
      operations.push({ operation: 'install', prefix: target });
    },
    removePackages: async (target: string) => {
      operations.push({ operation: 'remove', prefix: target });
    },
  } as unknown as CondaClient;
  const executables: string[] = [];
  const conda = {
    forExecutable: (executable: string) => {
      executables.push(executable);
      return owner;
    },
  } as unknown as CondaClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());

  const { window } = requireFromTest('vscode') as typeof import('vscode');
  t.mock.method(window, 'showWarningMessage', () => {
    throw new Error('headless prompt');
  });
  await packages.manage(environment, {
    install: ['ruff'],
    uninstall: ['black'],
    runHeadless: true,
  });

  assert.deepEqual(executables, [ownerExecutable, ownerExecutable]);
  assert.deepEqual(operations, [
    { operation: 'remove', prefix },
    { operation: 'install', prefix },
    { operation: 'list', prefix },
  ]);
});

test('regular package changes reject an environment without an owner', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/unknown/prefix';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    {} as CondaClient,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());

  await assert.rejects(
    packages.manage(environment, { install: ['ruff'] }),
    /Conda Code does not know which conda installation owns/,
  );
});

test('package cache clearing invalidates records without reporting removals', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/opt/conda/envs/demo';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  let listCalls = 0;
  const conda = {
    listPrefixPackages: async () => {
      listCalls += 1;
      return [
        {
          name: 'python',
          version: '3.13.5',
          build: 'h1_0',
          channel: 'conda-forge',
        },
      ];
    },
  } as unknown as CondaClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());
  const events: { readonly changes: readonly { readonly kind: string }[] }[] = [];
  packages.onDidChangePackages((event) => events.push(event));

  assert.equal(
    (await packages.getPackages(environment))?.[0]?.description,
    'Build h1_0, Channel conda-forge',
  );
  await packages.clearCache();
  assert.equal(
    (await packages.getPackages(environment))?.[0]?.description,
    'Build h1_0, Channel conda-forge',
  );
  assert.equal(listCalls, 2);
  assert.deepEqual(events, []);
});

test('package refresh returns packages and skipCache reloads them', async (t) => {
  const { vscode, packageManager } = modules();
  const prefix = '/opt/conda/envs/demo';
  const environment = {
    envId: { id: prefix, managerId: 'jezdez.conda-code:conda' },
    environmentPath: vscode.Uri.file(prefix),
  } as PythonEnvironment;
  const routes = {
    getRoute: () => undefined,
    getEnvironmentForPrefix: () => environment,
    getEnvironmentForRoute: () => environment,
    getCondaExecutableForPrefix: () => undefined,
    invalidateRegularDiscovery: () => undefined,
    isConflictedPrefix: () => false,
    refresh: async () => undefined,
  } as unknown as CondaWorkspaceRouteManager;
  let listCalls = 0;
  let version = '3.13.1';
  const conda = {
    listPrefixPackages: async () => {
      listCalls += 1;
      return [
        {
          name: 'python',
          version,
          build: 'h1_0',
          channel: 'defaults',
        },
      ];
    },
  } as unknown as CondaClient;
  const packages = new packageManager.CondaPackageManager(
    pythonApi([]),
    conda,
    {} as CondaWorkspacesClient,
    routes,
  );
  t.after(() => packages.dispose());
  const events: { readonly changes: readonly { readonly kind: string }[] }[] = [];
  packages.onDidChangePackages((event) => events.push(event));

  assert.equal((await packages.refresh(environment))[0]?.version, '3.13.1');
  assert.equal((await packages.refresh(environment))[0]?.version, '3.13.1');
  assert.equal((await packages.getPackages(environment))?.[0]?.version, '3.13.1');
  assert.equal(listCalls, 2);
  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['add']],
  );

  version = '3.13.2';
  assert.equal(
    (await packages.getPackages(environment, { skipCache: true }))?.[0]?.version,
    '3.13.2',
  );
  assert.equal(listCalls, 3);
  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['add']],
  );

  version = '3.13.3';
  assert.equal((await packages.refresh(environment))[0]?.version, '3.13.3');
  assert.equal(listCalls, 4);
  assert.deepEqual(
    events.map(({ changes }) => changes.map(({ kind }) => kind)),
    [['add'], ['remove', 'add']],
  );
});
