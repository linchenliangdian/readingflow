/* Networked update test. Dispatch only after the release is publicly available.
 * Every mutation and application quit is gated by exact disposable paths.
 */
const settings = __UPDATE_SETTINGS__;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runUpdateTest() {
  const result = { status: "running", scenario: "public-github-update", checks: [], startedAt: new Date().toISOString() };
  let safeToQuit = false;
  let writes = Promise.resolve();
  function check(name, passed, detail = null) {
    result.stage = name;
    result.checks.push({ name, passed: !!passed, detail });
    const snapshot = JSON.stringify(result, null, 2);
    writes = writes.then(() => IOUtils.writeUTF8(settings.result, snapshot, { tmpPath: settings.result + ".tmp" }));
    if (!passed) throw new Error("Failed: " + name);
  }
  async function waitFor(predicate, label, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await delay(100);
    }
    throw new Error("Timeout waiting for " + label);
  }
  async function bounded(promise, label, timeout = 45000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timeout waiting for " + label)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function completeLifecycle(addon, enable) {
    const owner = Zotero.Plugins._addonObserver;
    const method = enable ? "onEnabling" : "onDisabled";
    const original = owner[method];
    let completed = false, failure = null;
    const wrapper = function (changed, ...args) {
      const returned = original.call(this, changed, ...args);
      if (changed.id === settings.addonId) {
        Promise.resolve(returned).then(() => { completed = true; }, error => { failure = error; completed = true; });
      }
      return returned;
    };
    owner[method] = wrapper;
    try {
      await bounded(Promise.resolve().then(() => enable ? addon.enable() : addon.disable()), "native addon toggle");
      await waitFor(() => completed, "native plugin lifecycle");
      if (failure) throw failure;
    } finally { if (owner[method] === wrapper) owner[method] = original; }
  }
  async function installFile(path) {
    const installation = await AddonManager.getInstallForFile(Zotero.File.pathToFile(path));
    if (installation.error) throw new Error("Baseline installer error: " + installation.error);
    await bounded(installation.install(), "local baseline installation");
    return await waitFor(async () => {
      const addon = await AddonManager.getAddonByID(settings.addonId);
      return addon?.isActive && addon;
    }, "baseline addon activation");
  }
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  try {
    await Zotero.initializationPromise;
    check("exact isolated profile", PathUtils.normalize(Zotero.Profile.dir) === PathUtils.normalize(settings.profile), Zotero.Profile.dir);
    check("exact isolated data directory", PathUtils.normalize(Zotero.DataDirectory.dir) === PathUtils.normalize(settings.data), Zotero.DataDirectory.dir);
    safeToQuit = true;
    result.processID = Services.appinfo.processID;
    result.zoteroVersion = Zotero.version;
    check("no synchronized account in disposable profile", !Zotero.Users.getCurrentUserID());
    let addon = await AddonManager.getAddonByID(settings.addonId);
    check("no preexisting Reading flow in disposable profile", !addon);
    Zotero.Prefs.clear("readingFlow.githubUpdatesMigrationVersion");
    addon = await installFile(settings.baseline);
    await waitFor(() => addon.applyBackgroundUpdates === AddonManager.AUTOUPDATE_DISABLE, "legacy forced update setting");
    check("local lower-version baseline is active", addon.version === settings.baselineVersion && addon.isActive, addon.version);
    check("baseline faithfully starts with legacy update disable", addon.applyBackgroundUpdates === AddonManager.AUTOUPDATE_DISABLE);
    check("baseline has no GitHub migration marker", !(Zotero.Prefs.get("readingFlow.githubUpdatesMigrationVersion") >= 1));

    const install = await new Promise((resolve, reject) => {
      let found = null;
      const timeout = setTimeout(() => reject(new Error("Public update lookup timed out")), 90000);
      addon.findUpdates({
        onUpdateAvailable(current, installation) { found = installation; },
        onNoUpdateAvailable() {},
        onUpdateFinished(current, error) {
          clearTimeout(timeout);
          if (error) reject(new Error("Native public-feed update lookup failed: " + error));
          else if (!found) reject(new Error("No public update available"));
          else resolve(found);
        }
      }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
    });
    result.updateSource = install.sourceURI?.spec || null;
    result.advertisedVersion = install.version;
    check("native update lookup discovers the published version", install.version === settings.version, install.version);
    check("native installer uses the exact GitHub HTTPS release asset", install.sourceURI?.spec === settings.assetURL, install.sourceURI?.spec);
    const installed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Public XPI update timed out")), 120000);
      install.addListener({
        onDownloadFailed(current) { clearTimeout(timeout); reject(new Error("Public XPI download failed: " + current.error)); },
        onInstallFailed(current) { clearTimeout(timeout); reject(new Error("Public XPI install failed: " + current.error)); },
        onDownloadCancelled() { clearTimeout(timeout); reject(new Error("Public XPI download cancelled")); },
        onInstallCancelled() { clearTimeout(timeout); reject(new Error("Public XPI install cancelled")); },
        onInstallEnded(current, updated) { clearTimeout(timeout); resolve(updated); },
      });
    });
    try {
      addon = await Promise.race([
        installed,
        Promise.resolve().then(() => install.install()).then(() => installed)
      ]);
    } catch (error) {
      try { install.cancel(); } catch (ignored) {}
      throw error;
    }
    await waitFor(() => Zotero.ReadingFlow?.openItem && Zotero.Prefs.get("readingFlow.githubUpdatesMigrationVersion") >= 1,
      "downloaded Reading flow startup and migration");
    check("downloaded addon is active at the published version", addon.version === settings.version && addon.isActive, addon.version);
    result.pluginVersion = addon.version;
    check("legacy forced disable migrates to Zotero default", addon.applyBackgroundUpdates === AddonManager.AUTOUPDATE_DEFAULT,
      addon.applyBackgroundUpdates);
    check("native manager permits subsequent background updates", AddonManager.shouldAutoUpdate(addon));
    const installedPath = PathUtils.join(settings.profile, "extensions", settings.addonId + ".xpi");
    const [actual, expected] = await Promise.all([IOUtils.read(installedPath), IOUtils.read(settings.package)]);
    check("downloaded installed XPI exactly matches the reviewed release", actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
      { bytes: actual.length, expectedSHA256: settings.sha256 });
    result.installedXPI = installedPath;
    result.expectedSHA256 = settings.sha256;
    addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE;
    await completeLifecycle(addon, false);
    await waitFor(() => !Zotero.ReadingFlow, "updated plugin shutdown");
    await completeLifecycle(addon, true);
    await waitFor(() => Zotero.ReadingFlow?.openItem, "updated plugin restart");
    check("later explicit user disable survives real plugin restart", addon.applyBackgroundUpdates === AddonManager.AUTOUPDATE_DISABLE);
    check("migration marker remains one after restart", Zotero.Prefs.get("readingFlow.githubUpdatesMigrationVersion") === 1);
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = { message: error.message || String(error), stack: error.stack || null };
    Zotero.logError(error);
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await writes;
      await IOUtils.writeUTF8(settings.result, JSON.stringify(result, null, 2), { tmpPath: settings.result + ".tmp" });
    } finally {
      delete Zotero.__readingFlowUpdateSandbox;
      if (safeToQuit) Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
    }
  }
}
