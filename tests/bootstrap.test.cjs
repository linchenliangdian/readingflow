const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const MIGRATION_PREF = 'readingFlow.githubUpdatesMigrationVersion';
const AUTOUPDATE_DISABLE = 0;
const AUTOUPDATE_DEFAULT = 1;
const AUTOUPDATE_ENABLE = 2;

function sandbox({ failStart = false, failStop = false, backgroundUpdates = AUTOUPDATE_DISABLE,
  migrationVersion, addonPresent = true } = {}) {
  const calls = [];
  const addon = { applyBackgroundUpdates: backgroundUpdates };
  const presence = { value: addonPresent };
  const preferences = new Map(migrationVersion === undefined ? [] : [[MIGRATION_PREF, migrationVersion]]);
  const preferenceWrites = [];
  const scope = vm.createContext({
    // Deliberately omit Cc/Ci aliases, matching the documented injected API surface.
    Components: {
      classes: { '@mozilla.org/addons/addon-manager-startup;1': { getService() {
        return { registerChrome(uri, entries) {
          calls.push({ name: 'register', uri, entries: JSON.parse(JSON.stringify(entries)) });
          return { destruct() { calls.push({ name: 'destruct' }); } };
        } };
      } } },
      interfaces: { amIAddonManagerStartup: {} }
    },
    ChromeUtils: { importESModule(uri) {
      assert.equal(uri, 'resource://gre/modules/AddonManager.sys.mjs');
      return { AddonManager: { AUTOUPDATE_DISABLE, AUTOUPDATE_DEFAULT, AUTOUPDATE_ENABLE, async getAddonByID(id) {
        assert.equal(id, 'reading-flow@local');
        return presence.value ? addon : null;
      } } };
    } },
    Zotero: {
      initializationPromise: Promise.resolve(),
      logError(e) { calls.push({ name: 'log', error: e.message }); },
      Prefs: {
        get(key) { assert.equal(key, MIGRATION_PREF); return preferences.get(key); },
        set(key, value) {
          assert.equal(key, MIGRATION_PREF);
          preferences.set(key, value);
          preferenceWrites.push({ key, value });
        }
      }
    },
    Services: {
      io: { newURI: value => value },
      scriptloader: { loadSubScript(uri) {
        calls.push({ name: 'script', uri });
        if (uri.endsWith('integration.js')) {
          scope.ReadingFlowIntegration = {
            async start() { calls.push({ name: 'start' }); if (failStart) throw new Error('start failed'); },
            async stop() { calls.push({ name: 'stop' }); if (failStop) throw new Error('stop failed'); }
          };
        }
      } }
    }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../bootstrap.js'), 'utf8'), scope);
  return { scope, calls, addon, preferences, preferenceWrites, presence };
}
const args = { id: 'reading-flow@local', version: '1.0.0', rootURI: 'jar:file:///D:/test.xpi!/' };

test('bootstrap uses supported Components globals, registers chrome and cleans lifecycle', async () => {
  const { scope, calls, addon } = sandbox();
  await scope.startup(args);
  assert.equal(addon.applyBackgroundUpdates, AUTOUPDATE_DEFAULT);
  assert.equal(calls[0].uri, args.rootURI + 'manifest.json');
  assert.deepEqual(calls[0].entries, [['content', 'reading-flow', 'content/']]);
  assert.deepEqual(calls.filter(c => c.name === 'script').map(c => c.uri), [
    'chrome://reading-flow/content/core.js', 'chrome://reading-flow/content/sync.js', 'chrome://reading-flow/content/integration.js'
  ]);
  await scope.shutdown();
  assert.deepEqual(calls.slice(-2).map(c => c.name), ['stop', 'destruct']);
});

test('failed startup unregisters chrome and leaves no handle for duplicate teardown', async () => {
  const { scope, calls } = sandbox({ failStart: true });
  await assert.rejects(() => scope.startup(args), /start failed/);
  assert.equal(calls.filter(c => c.name === 'destruct').length, 1);
  await scope.shutdown();
  assert.equal(calls.filter(c => c.name === 'destruct').length, 1);
});

test('failed integration shutdown still releases the registered chrome handle', async () => {
  const { scope, calls } = sandbox({ failStop: true });
  await scope.startup(args);
  await assert.rejects(() => scope.shutdown(), /stop failed/);
  assert.equal(calls.at(-1).name, 'destruct');
});

test('first GitHub-enabled startup restores the default after legacy forced disable once', async () => {
  for (const migrationVersion of [undefined, 0]) {
    const { scope, addon, preferences, preferenceWrites } = sandbox({ migrationVersion });
    await scope.startup(args);
    assert.equal(addon.applyBackgroundUpdates, AUTOUPDATE_DEFAULT);
    assert.equal(preferences.get(MIGRATION_PREF), 1);
    assert.deepEqual(preferenceWrites, [{ key: MIGRATION_PREF, value: 1 }]);
    await scope.shutdown();
  }
});

test('first migration preserves an existing default or explicit enable setting', async () => {
  for (const backgroundUpdates of [AUTOUPDATE_DEFAULT, AUTOUPDATE_ENABLE]) {
    const { scope, addon, preferenceWrites } = sandbox({ backgroundUpdates });
    await scope.startup(args);
    assert.equal(addon.applyBackgroundUpdates, backgroundUpdates);
    assert.deepEqual(preferenceWrites, [{ key: MIGRATION_PREF, value: 1 }]);
    await scope.shutdown();
  }
});

test('later startup preserves the user choice to disable automatic updates', async () => {
  for (const migrationVersion of [1, 2]) {
    const { scope, addon, preferenceWrites } = sandbox({ migrationVersion });
    await scope.startup(args);
    assert.equal(addon.applyBackgroundUpdates, AUTOUPDATE_DISABLE);
    assert.deepEqual(preferenceWrites, []);
    await scope.shutdown();
  }
});

test('disabling after migration remains disabled across subsequent starts', async () => {
  const { scope, addon, preferenceWrites } = sandbox();
  await scope.startup(args);
  assert.equal(addon.applyBackgroundUpdates, AUTOUPDATE_DEFAULT);
  await scope.shutdown();
  addon.applyBackgroundUpdates = AUTOUPDATE_DISABLE;
  await scope.startup(args);
  assert.equal(addon.applyBackgroundUpdates, AUTOUPDATE_DISABLE);
  assert.deepEqual(preferenceWrites, [{ key: MIGRATION_PREF, value: 1 }]);
  await scope.shutdown();
});

test('missing addon does not consume migration and can migrate when available later', async () => {
  const { scope, addon, preferences, preferenceWrites, presence } = sandbox({ addonPresent: false });
  await scope.startup(args);
  assert.equal(preferences.has(MIGRATION_PREF), false);
  assert.deepEqual(preferenceWrites, []);
  await scope.shutdown();
  presence.value = true;
  await scope.startup(args);
  assert.equal(addon.applyBackgroundUpdates, AUTOUPDATE_DEFAULT);
  assert.deepEqual(preferenceWrites, [{ key: MIGRATION_PREF, value: 1 }]);
  await scope.shutdown();
});
