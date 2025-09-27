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
        const filtered = rest.map(url => filterUrl(url)).filter(url => url !== null);
        return [first, ...filtered];
      } else {
        const filtered = group.map(url => filterUrl(url)).filter(url => url !== null);
        return filtered;
      }
    });
    return res;
  }

  // Wait for tab navigation to start
  function waitForTabNavigationStart(prefix, tabId, timeoutMs = 10000) {
    return new Promise((resolve) => {
      let timeoutId;
      let resolved = false;

      // Listen for navigation commit (more reliable than onUpdated)
      const onCommitted = (details) => {
        if (details.tabId === tabId && details.frameId === 0) {
          message(`${prefix} navigation committed for ${tabId}`);
          resolveOnce(true);
        }
      };

      // Fallback: also listen for tab updates
      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "loading") {
          message(`${prefix} "loading" event found for ${tabId}`);
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
        message(`${prefix} WARN: timeout for tab ${tabId}`);
        resolveOnce(false);
      }, timeoutMs);

      chrome.webNavigation.onCommitted.addListener(onCommitted);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  // Process a single tab: create tab/window → wait for loading → discard → return windowId
  async function processSingleTab(windowId, url, tabIndex, totalTabs) {
    const prefix = `[Tab ${tabIndex}/${totalTabs}]`;
    try {
      let tabId;
      // Create tab or window based on whether we have a windowId
      if (windowId === null) {
        message(`${prefix} Creating new window with URL: ${url}`);
        const win = await chrome.windows.create({
          url: url,
          focused: false
        });

        if (!win || !win.tabs || win.tabs.length === 0) {
          throw new Error("Failed to create window or first tab");
        }

        windowId = win.id;
        tabId = win.tabs[0].id;
        // message(`${prefix} Created window ${windowId} with tab ${tabId}`);
      } else {
        message(`${prefix} Creating tab in window ${windowId} with URL: ${url}`);
        const tab = await chrome.tabs.create({
          windowId: windowId,
          url: url,
          active: false
        });

        tabId = tab.id;
        // message(`${prefix} Created tab ${tabId} in window ${windowId}`);
      }

      // Wait for this specific tab to be ready
      message(`${prefix} Waiting for tab ${tabId} to start loading...`);
      const waitForLoad = 10000;
      const grace = 500;
      const tabReady = await Promise.race([
        waitForTabNavigationStart(prefix, tabId, waitForLoad),
        new Promise(resolve => setTimeout(() => resolve(false), waitForLoad + grace))
      ]);

      if (tabReady) {
        message(`${prefix} Discarding tab ${tabId}...`);
        await chrome.tabs.discard(tabId);
        message(`${prefix} Successfully processed tab ${tabId}`);
      } else {
        message(`${prefix} WARN: Tab ${tabId} didn't start loading, discarding anyway...`);
        message(`  Lost URL: ${url}`);
        await chrome.tabs.discard(tabId).catch(() => {});
        message(`${prefix} Tab ${tabId} discarded (timeout)`);
      }

      return { success: true, windowId: windowId };

    } catch (error) {
      message(`${prefix} ERROR processing tab: ${error.message}`);
      // Try to discard anyway as a fallback if we have a tabId
      if (tabId) {
        try {
          await chrome.tabs.discard(tabId);
        } catch (e) {
          // Ignore discard errors at this point
        }
      }
      // Still return the windowId (might be null if window creation failed)
      return { success: false, windowId: windowId };
    }
  }

  // Process a single tab with a delay before starting
  async function processSingleTabWithDelay(getWindowId, url, tabIndex, totalTabs, startDelay) {
    // Wait for the scheduled start time
    if (startDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, startDelay));
    }

    // Get the current windowId (which should be fixed for parallel tabs)
    const windowId = getWindowId();

    return await processSingleTab(windowId, url, tabIndex, totalTabs);
  }

  // Process a group of URLs as a window (first tab creates window, rest are parallel)
  async function processWindowGroup(prefix, urls) {
    if (urls.length === 0) {
      throw new Error("No URLs provided for window group");
    }

    let currentWindowId = null;

    // First tab: sequential (creates window)
    message(`${prefix} Processing first tab (window creation) for ${urls.length} tabs...`);
    const firstResult = await processSingleTab(null, urls[0], 1, urls.length);
    currentWindowId = firstResult.windowId;

    if (!currentWindowId) {
      throw new Error("Failed to create window with first tab");
    }

    // If there are more tabs, process them in parallel with staggered starts
    if (urls.length > 1) {
      message(`${prefix} Processing remaining ${urls.length - 1} tabs in parallel...`);
      const remainingUrls = urls.slice(1);
      const remainingPromises = remainingUrls.map((url, i) => {
        const startDelay = (i + 1) * 300; // 300ms, 600ms, 900ms, etc.
        const tabIndex = i + 2; // tabs 2, 3, 4, etc.

        return processSingleTabWithDelay(
          () => currentWindowId, // Fixed windowId from first tab
          url,
          tabIndex,
          urls.length,
          startDelay
        );
      });

      const results = await Promise.allSettled(remainingPromises);

      // Log results for remaining tabs
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.filter(r => r.status === 'rejected' || !r.value.success).length;
      message(`${prefix} Parallel tabs completed, ${successful} successful, ${failed} failed`);
    }

    return currentWindowId;
  }

  // create windows and tabs from parsed groups
  async function restoreFromGroups(groups) {
    // If many tabs/windows, create them sequentially to avoid overload.
    // For each group:
    //  - if first line starts with '#', treat that as workspace header.
    //    first tab should be extension page with fragment containing that message.
    //  - else first tab is the first URL in group.
    // After creating each tab, call chrome.tabs.discard(tabId).

    message('Starting restore from groups...');

    for (let gi = 0; gi < groups.length; gi++) {
      const prefix = `[Group ${gi + 1}/${groups.length}]`;
      const group = groups[gi];
      if (group.length === 0) continue;

      message(`${prefix} ${group.length} URLs`);

      try {
        let urls = group.slice();

        // Process header if present
        if (urls[0].startsWith('#')) {
          const msg = urls[0].slice(1).trim();
          urls[0] = chrome.runtime.getURL('index.html#') + encodeURIComponent(msg);
        }

        // Filter out null URLs
        urls = urls.filter(url => url !== null);

        if (urls.length === 0) {
          message(`${prefix} Skipping empty group ${gi + 1}`);
          continue;
        }

        // Process this group (window)
        const windowId = await processWindowGroup(prefix, urls);

        message(`${prefix} Completed group in window ${windowId}\n`);

        // Small delay between windows to avoid overwhelming the browser
        if (gi < groups.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        message(`${prefix} ERROR: Failed to process group: ${error.message}`);
        // Continue with next group even if one fails
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
      message('Restore process finished');
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
