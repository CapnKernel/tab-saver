// script.js - runs in the extension page context
(() => {
  const $ = sel => document.querySelector(sel);
  const messageEl = $('#messages');
  const fileInput = $('#file-input');

  // show fragment message if present
  function showFragmentMessage() {
    const hash = location.hash || '';
    if (hash.startsWith('#')) {
      const msg = decodeURIComponent(hash.slice(1));
      if (msg.trim()) {
        const bannerEl = $('#banner');
        bannerEl.textContent = "Message: " + msg;
        // msgEl.style.display = 'block';
        document.querySelectorAll('.hide-on-banner').forEach(el => el.remove());
      }
    }
  }

  // util: promisify chrome APIs that still use callbacks
  function chromePromise(fn, ...args) {
    return new Promise((resolve, reject) => {
      try {
        fn(...args, (result) => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // save text by creating a blob url and calling chrome.downloads.download
  async function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    try {
      await chromePromise(chrome.downloads.download, { url, filename, conflictAction: 'overwrite' });
      message(`Saved ${filename}`);
    } catch (e) {
      message(`Error: Download failed: ${e.message || e}`);
    } finally {
      // revoke after a short delay to ensure download started
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }

  /**
   * Filter or transform a URL.
   * Return:
   *   - string: use this (possibly modified) URL
   *   - null / undefined: skip this URL entirely
   *
   * By default, skip any URL that belongs to this extension
   * (so we don't save extension pages).
   */
  function filterUrl(url) {
    if (!url) return null;
    const extOrigin = chrome.runtime.getURL('');
    if (url.startsWith(extOrigin)) {
      return null; // skip extension pages
    }
    // When saving (or loading), filter out use of Great Suspender pages, back to real URLs
    // FIXME: Of two minds about this, we're throwing away the title and position.
    url = url.replace(/^chrome-extension:\/\/lcfkjkinljmlbbffekcbpinpafbmjpde\/suspended.html#(ttl=[^&]+)?&(pos=[^&]+)?&uri=/, '');

    return url;
  }

  // format and save current window
  async function saveCurrentWindow() {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      // sort by index to maintain tab order
      tabs.sort((a, b) => a.index - b.index);
      const lines = tabs.map(t => filterUrl(t.url)).filter(url => url !== null);
      const text = lines.join('\n');
      await downloadTextFile('tabs-current-window.txt', text);
    } catch (e) {
      message(`Error: ${e.message || e}`);
    }
  }

  // save all windows, put a blank line between windows
  async function saveAllWindows() {
    try {
      const windows = await chrome.windows.getAll({ populate: true });
      // preserve window order by id (there's no guaranteed 'order' - this is best-effort)
      windows.sort((a, b) => a.id - b.id);
      const blocks = windows.map(w => {
        const tabs = (w.tabs || []).sort((a,b) => a.index - b.index);
        const lines = tabs.map(t => filterUrl(t.url)).filter(url => url !== null);
        return lines.join('\n');
      });
      const text = blocks.join('\n\n'); // blank line separates windows
      await downloadTextFile('tabs-all-windows.txt', text);
    } catch (e) {
      message(`Error: ${e.message || e}`);
    }
  }

  async function deleteAllWindows() {
    try {
      message("Starting to delete other windows...");

      // Show progress element
      const progressEl = document.getElementById('progress');
      const progressText = document.getElementById('progressText');
      // const progressBar = document.getElementById('progressBar');
      progressEl.style.display = 'block';

      // Get current window and all windows
      const currentWindow = await chrome.windows.getCurrent();
      const allWindows = await chrome.windows.getAll();

      // Filter out current window
      const windowsToDelete = allWindows.filter(win => win.id !== currentWindow.id);
      const totalWindows = windowsToDelete.length;

      if (totalWindows === 0) {
        message("No other windows to delete.");
        progressEl.style.display = 'none';
        return;
      }

      message(`Deleting ${totalWindows} other windows...`);

      // Update progress initially
      progressText.textContent = `0/${totalWindows} windows deleted`;
      // progressBar.value = 0;
      // progressBar.max = totalWindows;

      // Delete windows one by one with progress updates
      for (let i = 0; i < windowsToDelete.length; i++) {
        const window = windowsToDelete[i];

        try {
          await chrome.windows.remove(window.id);

          // Update progress
          const completed = i + 1;
          progressText.textContent = `${completed}/${totalWindows} windows deleted`;
          // progressBar.value = completed;

          // Optional: brief pause to show progress
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          console.error(`Failed to delete window ${window.id}:`, error);
          // Continue with other windows even if one fails
        }
      }

      message(`Successfully deleted ${totalWindows} windows.`);

      // Hide progress after a delay or keep it visible with final state
      setTimeout(() => {
        progressEl.style.display = 'none';
      }, 3000);

    } catch (error) {
      message('Error deleting windows: ' + error.message);

      // Hide progress on error too
      // document.getElementById('progress').style.display = 'none';
    }
  }

  // parse file text into groups (each group is one window). Blank line separates windows.
  // supports header lines that begin with '#' (e.g. "# Workspace 1") - treated as "workspace message"
  function parseWorkspaceFile(text) {
    const rawLines = text.split(/\r?\n/);
    const groups = [];
    let current = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (line === '') {
        if (current.length > 0) {
          groups.push(current);
          current = [];
        } else {
          // consecutive blank lines -> ignore extra
        }
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) groups.push(current);
    // Apply filtering AFTER parsing, so headers (#...) are preserved
    let res = groups.map(group => {
      if (group.length === 0) return group;
      // Keep header if first line starts with #
      const [first, ...rest] = group;
      if (first.startsWith('#')) {
        const filtered = rest
          .map(url => filterUrl(url))
          .filter(url => url !== null);
        return [first, ...filtered];
      } else {
        const filtered = group
          .map(url => filterUrl(url))
          .filter(url => url !== null);
        return filtered;
      }
    });
    return res;
  }

  function waitForTabNavigationStart(tabId, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let timeoutId;
      let resolved = false;

      // Declare functions first
      // Listen for navigation commit (more reliable than onUpdated)
      const onCommitted = (details) => {
        if (details.tabId === tabId && details.frameId === 0) {
          message(`WaitForTabNavigationStart: navigation committed for ${tabId}`);
          resolveOnce(true);
        }
      };

      // Fallback: also listen for tab updates
      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "loading") {
          message(`WaitForTabNavigationStart: "loading" event found for ${tabId}`);
          resolveOnce(true);
        }
      };

      function resolveOnce(success) {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(success);
        }
      }

      function cleanup() {
        clearTimeout(timeoutId);
        try {
          chrome.webNavigation.onCommitted.removeListener(onCommitted);
        } catch (e) {}
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        } catch (e) {}
      }

      // Set timeout
      timeoutId = setTimeout(() => {
        message(`WARN: WaitForTabNavigationStart: timeout for tab ${tabId}`);
        resolveOnce(false);
      }, timeoutMs);

      chrome.webNavigation.onCommitted.addListener(onCommitted);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  // Returns the id of the window the tab was created in.
  async function createTabAndSafeDiscard(windowId, url) {
    try {
      let tabId;

      if (windowId === null) {
        message(`In createTabAndSafeDiscard, winId is null, url=${url}.  Calling win create`);
        const win = await chrome.windows.create({ url, focused: false });
        windowId = win.id;
        tabId = win.tabs[0]?.id;
        message(`In createTabAndSafeDiscard, back from calling win create, windowId=${windowId} tabId=${tabId}`);
      } else {
        message(`In createTabAndSafeDiscard, windowId=${windowId} Calling tab create`);
        const tab = await chrome.tabs.create({ windowId, url, active: false });
        tabId = tab.id;
        message(`In createTabAndSafeDiscard, back from tab create, tabId=${tabId}`);
      }

      if (!tabId) throw new Error("Failed to get tab ID");

      // Wait for navigation with better timeout handling
      message(`In createTabAndSafeDiscard, waiting for nav start, tabId=${tabId}`);
      await Promise.race([
        waitForTabNavigationStart(tabId, 2000),
        new Promise(resolve => setTimeout(() => resolve(false), 2500))
      ]);

      message(`In createTabAndSafeDiscard, back from nav start wait, tabId=${tabId}, calling discard`);

      await chrome.tabs.discard(tabId);
      message(`In createTabAndSafeDiscard, back from tab discard`);
      message(`In createTabAndSafeDiscard, created url=${url} ok`);

      return windowId;

    } catch (error) {
      message("ERROR: createTabAndSafeDiscard failed:", error);
      return windowId; // Return whatever windowId we have
    }
  }

  // create windows and tabs from parsed groups
  async function restoreFromGroups(groups) {
    // If many tabs/windows, create them sequentially to avoid overload.
    // For each group:
    //  - if first line starts with '#', treat that as workspace header.
    //    first tab should be extension page with fragment containing that message.
    //  - else first tab is the first URL in group.
    // After creating each tab, call chrome.tabs.discard(tabId).

    message('In restoreFromGroups');
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      if (group.length === 0) continue;

      let winId = null;
      let urls = group.slice();

      for (let i = 0; i < urls.length; i++) {
        let url = urls[i];

        if (url.startsWith('#')) {
          const msg = urls[0].slice(1).trim();
          url = chrome.runtime.getURL('index.html#') + encodeURIComponent(msg);
        }

        try {
          message(`Calling createTabAndSafeDiscard.  winId=${winId} url=${url}`)
          winId = await createTabAndSafeDiscard(winId, url);
          message(`Successfully back from createTabAndSafeDiscard.  winId=${winId}`)
        } catch (e) {
          message(`Window create failed: ${e.message || e}`);
        }
      }
    }
    message('Restore completed.');
  }

  async function clearLog() {
    messageEl.textContent = '';
  }

  // load file from input element
  function loadFileViaInput() {
    fileInput.value = '';
    fileInput.click();
  }

  // handle file selected
  fileInput.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    message(`Loading ${file.name} ...`);
    const reader = new FileReader();
    reader.onload = async () => {
      const text = reader.result;
      const groups = parseWorkspaceFile(text);
      message(`Parsed ${groups.length} group(s). Restoring...`);
      message('Calling restoreFromGroups');
      await restoreFromGroups(groups);
      message('Back from restoreFromGroups');
    };
    reader.onerror = (e) => message('File read error');
    reader.readAsText(file);
  });

  function message(msg) {
    // const timestamp = new Date().toLocaleTimeString();
    // const fullMessage = `[${timestamp}] ${msg}\n`;

    // Append new message
    messageEl.textContent += (msg + "\n");
    messageEl.style.display = '';

    // Auto-scroll to bottom
    messageEl.scrollTop = messageEl.scrollHeight;

    console.log('[TabWorkspaces] ', msg);
  }

  // attach handlers
  $('#save-window').addEventListener('click', async () => {
    message('Saving current window...');
    await saveCurrentWindow();
  });

  $('#save-all').addEventListener('click', async () => {
    message('Saving all windows...');
    await saveAllWindows();
  });

  $('#delete-all').addEventListener('click', async () => {
    message('Deleting all windows...');
    await deleteAllWindows();
  });

  $('#load-file').addEventListener('click', () => {
    loadFileViaInput();
  });

  $('#clear').addEventListener('click', async () => {
    await clearLog();
  });

  // on load
  showFragmentMessage();
})();
