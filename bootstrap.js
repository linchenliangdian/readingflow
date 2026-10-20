/* Zotero 9 bootstrap lifecycle. Reading content is saved only through the app bridge. */
var readingFlowChromeHandle = null;
var readingFlowBootstrapGlobal = this;

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  // Older local releases forced automatic updates off. Restore Zotero's default
  // once when moving to GitHub, then preserve any later choice made by the user.
  var { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  var addon = await AddonManager.getAddonByID(id);
  if (addon && !(Zotero.Prefs.get("readingFlow.githubUpdatesMigrationVersion") >= 1)) {
    if (addon.applyBackgroundUpdates === AddonManager.AUTOUPDATE_DISABLE) {
      addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;
    }
    Zotero.Prefs.set("readingFlow.githubUpdatesMigrationVersion", 1);
  }
  var manager = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  readingFlowChromeHandle = manager.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", "reading-flow", "content/"]]
  );
  var resourceQuery = "?v=" + encodeURIComponent(version);
  try {
    Services.scriptloader.loadSubScript(
      "chrome://reading-flow/content/core.js" + resourceQuery, readingFlowBootstrapGlobal, "UTF-8"
    );
    Services.scriptloader.loadSubScript(
      "chrome://reading-flow/content/sync.js" + resourceQuery, readingFlowBootstrapGlobal, "UTF-8"
    );
    Services.scriptloader.loadSubScript(
      "chrome://reading-flow/content/integration.js" + resourceQuery, readingFlowBootstrapGlobal, "UTF-8"
    );
    await ReadingFlowIntegration.start({ id, version, rootURI });
  }
  catch (error) {
    if (typeof ReadingFlowIntegration !== "undefined") {
      await ReadingFlowIntegration.stop().catch(e => Zotero.logError(e));
    }
    readingFlowChromeHandle.destruct();
    readingFlowChromeHandle = null;
    throw error;
  }
}

async function shutdown() {
  try {
    if (typeof ReadingFlowIntegration !== "undefined") await ReadingFlowIntegration.stop();
  }
  finally {
    if (readingFlowChromeHandle) readingFlowChromeHandle.destruct();
    readingFlowChromeHandle = null;
  }
}

function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) {
  if (typeof ReadingFlowIntegration !== "undefined") ReadingFlowIntegration.attachWindow(window);
}
function onMainWindowUnload({ window }) {
  if (typeof ReadingFlowIntegration !== "undefined") ReadingFlowIntegration.detachWindow(window).catch(e => Zotero.logError(e));
}
