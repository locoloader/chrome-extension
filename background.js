'use strict';

// Utils
// ---------------------------------------------
const debug = false;
function log(...message) {
    if (debug) {
        console.log(...message);
    }
}

function warn(...message) {
    if (debug) {
        console.warn(...message);
    }
}

// Extension options
// ---------------------------------------------

// Get and set default value for each checkbox option.
const extensionOptions = {
    btDlAllFolder: true,
    btDlFolder: false,
};
for (const key in extensionOptions) {
    chrome.storage.local.get(key, (res) => {
        if (res.hasOwnProperty(key)) {
            extensionOptions[key] = res[key];
        }
    });
}

// Download
// ---------------------------------------------
const maxActiveDownloads = 3;
const activeDownloadIds = new Set();
const filenameToDownloadInfo = new Map();
const downloadIdToFilename = new Map();
let remainingLinksUI = 0;
let activeBatchPort = null;
let activeMessage = {};

function randomChars() {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz012345678901';

    // Generate a random 32-bit unsigned integer.
    const r = (Math.random() * 0x100000000) >>> 0;

    // Extract 6 bits (values 0-63) four times using fast bitwise operations.
    return CHARS[r & 63] + CHARS[(r >>> 6) & 63] + CHARS[(r >>> 12) & 63] + CHARS[(r >>> 18) & 63];
}

function getDownloadInfoByFilename(downloadItem) {
    const filePath = downloadItem.filename;
    let filename = filePath.substring(filePath.lastIndexOf('/') + 1);

    if (!filenameToDownloadInfo.has(filename) && downloadIdToFilename.has(downloadItem.id)) {
        filename = downloadIdToFilename.get(downloadItem.id);
    }

    downloadIdToFilename.delete(downloadItem.id);

    if (filenameToDownloadInfo.has(filename)) {
        return { filename, ...filenameToDownloadInfo.get(filename) };
    } else {
        warn(`Filename '${filename}' cannot be found in:`, [...filenameToDownloadInfo.entries()]);
    }
}

chrome.downloads.onCreated.addListener((downloadItem) => {
    // Download started.
    log(`File download started(${activeDownloadIds.size}):`, downloadItem);

    activeDownloadIds.add(downloadItem.id);
});

chrome.downloads.onDeterminingFilename.addListener(async (downloadItem, suggest) => {
    // Download filename determinated.
    log('downloadItem:', downloadItem);

    // Get download info.
    const downloadInfo = getDownloadInfoByFilename(downloadItem);
    if (!downloadInfo) {
        // All downloads that were not initiated by extension.
        warn('Unknown download item:', downloadItem);
        return;
    }

    let filename = downloadInfo.filename;

    // Add folder to filename.
    if (downloadInfo.folder) {
        filename = downloadInfo.folder + '/' + filename;
    }

    // Set correct filename.
    await suggest({
        filename,
        conflictAction: 'overwrite',
    });

    if (downloadInfo.tabId) {
        // Close download tab, it's no longer needed.
        try {
            await chrome.tabs.remove(downloadInfo.tabId);
            log('Tab closed:', downloadInfo.tabId);
        } catch (e) {
            log('Tab hase been already closed:', downloadInfo.tabId);
        }
    }

    return true;
});

chrome.downloads.onChanged.addListener((downloadDelta) => {
    if (
        downloadDelta.state &&
        (downloadDelta.state.current === 'complete' || downloadDelta.state.current === 'interrupted')
    ) {
        // Download finished successfully.
        // - or -
        // Download was insterrupted by user or another reason.

        chrome.downloads.search({ id: downloadDelta.id }, function (downloadItems) {
            log('Download items:', downloadItems);

            if (downloadDelta.state.current === 'complete') {
                log(`File download finished(${activeDownloadIds.size}):`, downloadDelta.id);

                // Only completed downloads are subtracted from remaining links in app UI.
                remainingLinksUI--;
            } else {
                log(`File download interrupted(${activeDownloadIds.size}):`, downloadDelta.id);
            }

            // Whether download was completed or interrupted, it is no longer active.
            activeDownloadIds.delete(downloadDelta.id);

            if (!downloadItems || !downloadItems[0]) {
                // Unexpected situation.
                log(`Download delta (${downloadDelta.id}) has not download item.`);
                removeHeadersAll();
                return;
            }

            // Get download info by downloadItem. Required to:
            // - Auto-uncheck selected item in app UI.
            // - Remove headers for non-native downloads.
            const downloadInfo = getDownloadInfoByFilename(downloadItems[0]);
            let finalUrlIndex = '';

            if (!downloadInfo) {
                // All downloads that were not initiated by extension.
                warn('Unknown download item:', downloadItems[0]);
                return;
            }

            if (downloadInfo) {
                // Set finalUrlIndex of downloaded file for UI.
                finalUrlIndex = downloadInfo.isSingle ? '' : downloadInfo.linkIndex;

                if (downloadInfo.headerInfoArr?.length) {
                    for (const headerInfo of downloadInfo.headerInfoArr) {
                        // Remove custom req/res HTTP headers for non-native downloads.
                        removeHeaders(headerInfo.UUID);
                    }
                }

                filenameToDownloadInfo.delete(downloadInfo.filename);
            }

            log('Final URL index:', finalUrlIndex);

            if (activeBatchPort) {
                // Notify app to update UI.
                activeBatchPort.postMessage({
                    event: 'DOWNLOAD_PROGRESS',
                    target: 'app',
                    remainingLinks: remainingLinksUI,
                    finalUrlIndex,
                    isDownloaded: downloadDelta.state.current === 'complete',
                });
            }

            if (activeBatchPort && activeMessage.links?.length) {
                // Download next link with delay to avoid request bursts.
                setTimeout(() => {
                    downloadLinks(activeMessage);
                }, 500);
            } else if (activeBatchPort && activeMessage.links?.length === 0) {
                // All links have been sent to download queue, but downloading may still be in progress.
                log('All files have been sent to queue.');
                activeMessage = {};
            }

            if (!activeDownloadIds.size && !activeMessage.links) {
                log('All files have been downloaded.');
                filenameToDownloadInfo.clear();
                activeBatchPort = null;
            }
        });
    }
});

function normalizeFilename(name, ext) {
    const normalizedFileName = name.replace(/[\/\(\)]/g, '-');
    const normalizedFileExt = ext.replace(/[\/\(\)\.]/g, '');
    let filename = normalizedFileName + '.' + normalizedFileExt;

    for (const [key, val] of filenameToDownloadInfo) {
        if (key === filename) {
            //  Add random chars to filename when same file is already downloading.
            filename = normalizedFileName + '_' + randomChars() + '.' + normalizedFileExt;
        }
    }

    return filename;
}

function normalizeFolder(folder) {
    return folder.replace(/[\(\)]/g, '-');
}

async function downloadLinks(message) {
    const links = message.links;

    if (!links) {
        // Batch download have been interrupted by user.
        return;
    }

    if (!links.length) {
        // All links have been downloaded.
        return;
    }

    if (links[links.length - 1].url === 'exceeded') {
        // User can't download more links.
        return;
    }

    // Is it a single download?
    const isSingle = message.event === 'START_DOWNLOAD';

    // Should we create a download folder?
    const createFolder = (isSingle && extensionOptions.btDlFolder) || (!isSingle && extensionOptions.btDlAllFolder);

    // Are all downloads native or not?
    // Download cannot be native if we need to set custom HTTP headers for download.
    let isNativeDownload = true;
    const headerObjArr = [];
    if (message.extActions && message.extActions.headers) {
        if (message.extActions.headers.download && message.extActions.headers.download.length) {
            isNativeDownload = false;
            for (const index in message.extActions.headers.download) {
                decodeCookies(message.extActions.headers.download[index]);
                headerObjArr.push(message.extActions.headers.download[index]);
            }
        } else if (message.extActions.headers.both && message.extActions.headers.both.length) {
            isNativeDownload = false;
            for (const index in message.extActions.headers.both) {
                decodeCookies(message.extActions.headers.both[index]);
                headerObjArr.push(message.extActions.headers.both[index]);
            }
        }
    }

    // Download using tab.
    if (!isNativeDownload) {
        log('Non-native download.');

        // Find any Locoloader tab and init download from it.
        chrome.tabs.query(
            {
                active: true,
                currentWindow: true,
                url: ['https://www.locoloader.com/*', 'https://www.locoloader.test/*'],
            },
            async (tabs) => {
                // Did we find any Locoloader tab?
                if (!tabs[0]) {
                    log('No Locoloader tab found.');
                    return;
                }

                // Get and remove link from links array.
                const linkData = links.pop();
                const link = linkData.link;
                const linkIndex = linkData.index;

                // URL
                let url = link.link_url;

                if (link.download === 'raw') {
                    // Raw files live in memory, so there is no need to set custom headers to download them.
                    // Localoader uses raw files only for custom M3U8 files.

                    // Filename
                    let filename = normalizeFilename(link.file_name, link.file_ext);
                    if (createFolder && message.folder) {
                        filename = normalizeFolder(message.folder) + '_' + filename;
                    }

                    // Convert raw URL to Blob so Firefox can download it.
                    url = `data:application/octet-stream;base64,${link.link_raw}`;

                    // Save download info.
                    const downloadInfo = {
                        linkIndex,
                        isSingle,
                        folder: createFolder && message.folder ? normalizeFolder(message.folder) : '',
                    };
                    filenameToDownloadInfo.set(filename, downloadInfo);
                    log('Saved:', filename, downloadInfo);

                    // Init download.
                    const downloadId = await chrome.downloads.download({
                        url,
                        filename,
                        saveAs: false,
                    });

                    downloadIdToFilename.set(downloadId, filename);
                }

                if (link.download === 'url') {
                    // Filename
                    let filename = normalizeFilename(link.file_name, link.file_ext);

                    // Create empty download tab.
                    const tab = await chrome.tabs.create({ active: false });

                    // Set headers only to download tab.
                    headerObjArr.push({
                        action: {
                            type: 'modifyHeaders',
                            responseHeaders: [
                                {
                                    header: 'content-disposition',
                                    operation: 'set',
                                    value: 'attachment; filename=' + filename,
                                },
                            ],
                        },
                        condition: {
                            tabIds: [tab.id],
                            resourceTypes: ['main_frame', 'media'],
                        },
                    });

                    const headerInfoArr = [];
                    for (const headerObj of headerObjArr) {
                        headerObj.condition['tabIds'] = [tab.id];

                        const headerInfo = await setHeaders(headerObj.action, headerObj.condition);
                        if (headerInfo) {
                            headerInfoArr.push(headerInfo);
                        }
                    }

                    // Save download info.
                    const downloadInfo = {
                        linkIndex,
                        isSingle,
                        headerInfoArr,
                        tabId: tab.id,
                        folder: createFolder && message.folder ? normalizeFolder(message.folder) : '',
                    };
                    filenameToDownloadInfo.set(filename, downloadInfo);
                    log('Saved:', filename, downloadInfo);

                    // Update download tab.
                    await chrome.tabs.update(tab.id, { url, active: false });
                }
            },
        );
    }

    // Download using native download function.
    if (isNativeDownload) {
        log('Native download.');

        // Init max parallel downloads.
        const downloadsToInit = maxActiveDownloads - activeDownloadIds.size;
        log(`Sent ${downloadsToInit} file to download queue.`);

        for (let i = 0; i < downloadsToInit; i++) {
            if (!links.length) {
                // All links have been processed.
                log('All links have been processed.');
                break;
            }

            // Get and remove link from reversed links array.
            const linkData = links.pop();
            const link = linkData.link;
            const linkIndex = linkData.index;

            // URL
            let url = link.link_url;
            if (link.download === 'raw') {
                url = `data:application/octet-stream;base64,${link.link_raw}`;
            }

            // Filename
            let filename = normalizeFilename(link.file_name, link.file_ext);

            // Save download info.
            const downloadInfo = {
                linkIndex,
                isSingle,
                folder: createFolder && message.folder ? normalizeFolder(message.folder) : '',
            };
            filenameToDownloadInfo.set(filename, downloadInfo);
            log('Saved:', filename, downloadInfo);

            // Download
            const downloadId = await chrome.downloads.download({
                url,
                filename,
                saveAs: false,
            });

            downloadIdToFilename.set(downloadId, filename);
        }
    }
}

// Open pre-configured tab with fetcher.js
// ---------------------------------------------
function openFetcher(message) {
    return new Promise(async (resolve) => {
        const defaultResponse = [{
            result: {
                event: 'PRE_EXTRACTION',
                target: 'app',
                tabUUID: message.tabUUID,
                url: message.url,
                headers: {},
                html: '',
                dom: '',
                actions: {
                    err: [],
                    result: [],
                },
                xhr: [],
                windowURL: message.windowURL,
            }
        }];

        // Open background tab.
        const tab = await chrome.tabs.create({ active: false });

        // Set headers only to fetcher tab.
        log('Received headers:', message.headers);
        const headerInfoArr = [];
        for (const headerObj of message.headers) {
            headerObj.condition['tabIds'] = [tab.id];

            const headerInfo = await setHeaders(headerObj.action, headerObj.condition);
            if (headerInfo) {
                headerInfoArr.push(headerInfo);
            }
        }

        // Remove tab headers.
        function cleanupHeaders(headerInfoArr) {
            for (const headerInfo of headerInfoArr) {
                removeHeaders(headerInfo.UUID);
            }
        }

        // Set final tab URL.
        await chrome.tabs.update(tab.id, { url: message.url, active: false });

        // Wait for tab to complete URL update.
        const waitForLoad = new Promise((resolve) => {
            let timeoutId;

            // Listen for successful updates.
            function updateListener(tabId, changeInfo, currentTab) {
                if (tabId === tab.id && changeInfo.status === 'complete') {
                    if (currentTab.url && currentTab.url !== 'about:blank' && currentTab.url !== 'about:newtab') {
                        cleanup();
                        resolve(true);
                        log(`Tab ${tab.id} loading complete.`);
                    }
                }
            }

            // Listen for premature closures.
            function closeListener(closedTabId) {
                if (closedTabId === tab.id) {
                    cleanup();
                    resolve(false);
                    log(`Tab ${tab.id} closed prematurely.`);
                }
            }

            // Centralized cleanup to prevent memory leaks.
            function cleanup() {
                chrome.tabs.onUpdated.removeListener(updateListener);
                chrome.tabs.onRemoved.removeListener(closeListener);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            }

            chrome.tabs.onUpdated.addListener(updateListener);
            chrome.tabs.onRemoved.addListener(closeListener);

            // Failsafe: In case it finished loading before listeners attached.
            chrome.tabs.get(tab.id, (currentTab) => {
                if (currentTab.status === 'complete' && currentTab.url && currentTab.url !== 'about:blank' && currentTab.url !== 'about:newtab') {
                    cleanup();
                    resolve(true);
                    log(`Tab ${tab.id} finished loading before listeners attached.`);
                }
            });

            // Ultimate failsafe: Timeout after 120 seconds to prevent infinite hanging.
            timeoutId = setTimeout(() => {
                cleanup();
                resolve(false);
                log(`Timeout: Tab ${tab.id} took too long to load.`);
            }, 120000);
        });

        if (!await waitForLoad) {
            cleanupHeaders(headerInfoArr);
            return resolve(defaultResponse);
        }

        let injectionResult;

        // Monkeypatch console.clear().
        injectionResult = await ensureExecuteScript({
            world: 'MAIN',
            target: { tabId: tab.id },
            func: () => {
                console.clear = () => { };
            },
        });
        if (!injectionResult) {
            log(`Injecting monkeypatch failed.`);
            cleanupHeaders(headerInfoArr);
            return resolve(defaultResponse);
        }

        // Configuration for fetcher.js.
        injectionResult = await ensureExecuteScript({
            world: 'MAIN',
            target: { tabId: tab.id },
            func: (message) => {
                document.LLPage = message;
            },
            args: [message],
        });
        if (!injectionResult) {
            log(`Injecting message failed.`);
            cleanupHeaders(headerInfoArr);
            return resolve(defaultResponse);
        }

        // Run fetcher.js.
        const result = await ensureExecuteScript({
            world: 'MAIN',
            target: { tabId: tab.id },
            files: ['fetcher.js'],
        });

        log('Tab in background.js received result from fetcher.js:', result);

        // Remove tab headers.
        cleanupHeaders(headerInfoArr);

        try {
            // Close fetched tab.
            await chrome.tabs.remove(tab.id);
        } catch (err) {
            // Tab has been closed prematurely.
            return resolve(defaultResponse);
        }

        // If response contains reFetch attribute, it means that page should be re-fetched.
        if (result && result[0].result.reFetch) {
            setTimeout(async () => {
                // Only re-fetch once.
                message['doNotReFetch'] = true;

                // Re-open, re-fetch and return result from fetcher.js.
                resolve(await openFetcher(message));
            }, 2000);
        } else {
            // Return result from fetcher.js.
            resolve(result);
        }
    });
}

async function ensureExecuteScript(scriptOptions, maxRetries = 5, delayMs = 50) {
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await chrome.scripting.executeScript(scriptOptions);
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    log(`Script injection failed after ${maxRetries} attempts. Last error: ${lastError.message}`);
    return false;
}

// Listening to message
// ---------------------------------------------
chrome.runtime.onMessage.addListener((message, sender) => {
    log('Background.js received message from content script:', message);
    log('Sender:', sender);
    log('Runtime ID:', chrome.runtime.id);

    // Allow only trusted messages.
    if (
        sender.origin !== 'https://www.locoloader.com' &&
        sender.origin !== 'https://www.locoloader.test' &&
        sender.id !== chrome.runtime.id
    ) {
        return;
    }

    // Accept only message addressed to extension.
    if (message.target !== 'ext') {
        return;
    }

    // Set options.
    if (message.event === 'UPDATE_OPTIONS') {
        extensionOptions[message.optionName] = message.optionVal;
    }
});

// Listening to an external message
// ---------------------------------------------
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    log('Background.js received message from app.js:', message);

    // Allow only trusted messages.
    if (sender.origin !== 'https://www.locoloader.com' && sender.origin !== 'https://www.locoloader.test') {
        return true;
    }

    if (message.type === 'ext-fetch') {
        const job = async () => {
            // Default response.
            const pageObj = {
                event: 'PRE_EXTRACTION',
                target: 'app',
                url: message.url,
                headers: {},
                html: '',
            };

            // Set request headers...
            let requestHeaders = [];

            // ...other HTTP headers
            if (message.fetchOptions.headers && Object.keys(message.fetchOptions.headers)) {
                for (const [key, val] in message.fetchOptions.headers) {
                    requestHeaders.push({
                        header: key,
                        operation: 'set',
                        value: val,
                    });
                }
            }

            // ...referer
            if (message.fetchOptions.referrer) {
                requestHeaders.push({
                    header: 'Referer',
                    operation: 'set',
                    value: message.fetchOptions.referrer,
                });
            }

            // ...referer policy
            if (message.fetchOptions.referrerPolicy) {
                requestHeaders.push({
                    header: 'Referrer-Policy',
                    operation: 'set',
                    value: message.fetchOptions.referrerPolicy,
                });
            }

            // ...set headers
            let headerInfo = {};
            if (requestHeaders.length) {
                headerInfo = await setHeaders(
                    {
                        type: 'modifyHeaders',
                        requestHeaders: requestHeaders,
                    },
                    {
                        resourceTypes: ['xmlhttprequest'],
                        urlFilter: `|${message.url}|`,
                    },
                );
            }

            let fetchResponse = null;
            try {
                // Send request.
                fetchResponse = await fetch(message.url, message.fetchOptions ? message.fetchOptions : {});
            } catch (e) { }

            // Remove request headers.
            if (typeof headerInfo.UUID !== 'undefined') {
                removeHeaders(headerInfo.UUID);
            }

            if (!fetchResponse) {
                sendResponse(pageObj);
                return;
            }

            // ...get page HTML
            pageObj.html = await fetchResponse.text();

            // ...get page HTTP headers
            pageObj.headers = Object.fromEntries(fetchResponse.headers.entries());

            // Send response.
            sendResponse(pageObj);
        };

        job();
    }

    if (message.type === 'ext-tab') {
        const job = async () => {
            const pageObj = await openFetcher(message);
            log('Pre-extraction data:', pageObj);

            // Response.
            sendResponse(pageObj ? pageObj[0]?.result : { event: 'PRE_EXTRACTION', target: 'app', html: '' });
        };

        job();
    }

    // Mandatory: Keeps message channel open for async response.
    return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
    log('Background.js connected to app.js:', port);

    // Allow only trusted connections.
    if (port.sender.origin !== 'https://www.locoloader.com' && port.sender.origin !== 'https://www.locoloader.test') {
        return;
    }

    port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
            log('Port disconnected:', chrome.runtime.lastError.message);
        }
    });

    port.onMessage.addListener((message) => {
        log('RECEIVED:', message.event);

        if (message.event === 'START_DOWNLOAD') {
            if (activeBatchPort) {
                port.postMessage({ event: 'ERROR_ALREADY_DOWNLOADING', target: 'app' });
                return;
            }

            downloadLinks(message);
        }

        if (message.event === 'START_BATCH_DOWNLOAD') {
            if (activeBatchPort) {
                port.postMessage({ event: 'ERROR_ALREADY_DOWNLOADING', target: 'app' });
                return;
            }

            activeBatchPort = port;
            activeMessage = message;
            remainingLinksUI = message.links.length;

            log('Active port(1):', activeBatchPort);

            downloadLinks(activeMessage);
        }

        if (message.event === 'STOP_BATCH_DOWNLOAD') {
            // Stop current downloads.
            activeDownloadIds.forEach((id) => chrome.downloads.cancel(id));

            if (activeBatchPort) {
                activeBatchPort.postMessage({
                    event: 'DOWNLOAD_PROGRESS',
                    target: 'app',
                    remainingLinks: remainingLinksUI,
                    finalUrlIndex: '',
                });
            }

            activeBatchPort = null;
            activeMessage = {};
        }

        if (message.event === 'PREVIEW') {
            const job = async () => {
                // Determine preview tab URL.
                let tabUrl = message.previewURL;

                if (
                    message.player === 'true' ||
                    (message.extActions && message.extActions.playerPreview) ||
                    message.linkType === 'raw'
                ) {
                    // Use player.html for preview instead of native player.
                    const sessionId = 'preview_' + crypto.randomUUID();
                    tabUrl = chrome.runtime.getURL(`player.html?data=${message.linkType}&sessionId=${sessionId}`);
                    chrome.storage.session.set({ [sessionId]: message.previewURL });
                }

                // Set preview link headers retrieved from extension actions.
                const headerObjArr = [];
                if (message.extActions && message.extActions.headers) {
                    if (message.extActions.headers.preview && message.extActions.headers.preview.length) {
                        for (const index in message.extActions.headers.preview) {
                            decodeCookies(message.extActions.headers.preview[index]);
                            headerObjArr.push(message.extActions.headers.preview[index]);
                        }
                    } else if (message.extActions.headers.both && message.extActions.headers.both.length) {
                        for (const index in message.extActions.headers.both) {
                            decodeCookies(message.extActions.headers.both[index]);
                            headerObjArr.push(message.extActions.headers.both[index]);
                        }
                    }
                }

                // Create empty preview tab.
                const tab = await chrome.tabs.create({ active: false });

                // Set headers only to preview tab.
                const headerInfoArr = [];
                for (const headerObj of headerObjArr) {
                    headerObj.condition['tabIds'] = [tab.id];

                    const headerInfo = await setHeaders(headerObj.action, headerObj.condition);
                    if (headerInfo) {
                        headerInfoArr.push(headerInfo);
                    }
                }

                const closeTabListener = (tabId) => {
                    if (tabId === tab.id) {
                        // Remove declarativeNetRequest session rules (remove preview link headers).
                        for (const headerInfo of headerInfoArr) {
                            removeHeaders(headerInfo.UUID);
                        }
                        chrome.tabs.onRemoved.removeListener(closeTabListener);
                        log('Preview tab closed id:', tabId);
                    }
                };

                chrome.tabs.onRemoved.addListener(closeTabListener);

                // Update preview tab.
                await chrome.tabs.update(tab.id, { url: tabUrl, active: true });
            };

            job();
        }
    });
});

// HTTP request / response modifications
// ---------------------------------------------

// Decode HTTP request cookie header value.
function decodeCookies(headersObj) {
    if (headersObj.action && headersObj.action.requestHeaders) {
        for (const key in headersObj.action.requestHeaders) {
            if (headersObj.action.requestHeaders[key].header === 'cookie') {
                headersObj.action.requestHeaders[key].value = decodeURIComponent(
                    headersObj.action.requestHeaders[key].value,
                );
            }
        }
    }
}

// Initial HTTP headers state.
let headerCount = 0;
let headerHash = {};

// Fast and good enough hashing function to generate HTTP header UUID.
function hash(string) {
    let hash = 0;
    for (let i = 0; i < string.length; i++) {
        hash = (hash << 5) - hash + string.charCodeAt(i);
        hash |= 0;
    }
    return hash >>> 0;
}

// Set declarativeNetRequest HTTP headers
async function setHeaders(action, condition, permanent = false) {
    if (!action || !condition) {
        // Cannot update session rules without both action and condition.
        return;
    }

    // Generate header uid.
    const jsonString = JSON.stringify({ action, condition });
    const headerUUID = hash(jsonString);

    // Do not set same header multiple times.
    if (headerHash[headerUUID]) {
        return headerHash[headerUUID];
    }

    // Update number of active headers.
    headerCount++;

    // Header info JSON.
    const headerInfo = {
        id: headerCount,
        UUID: headerUUID,
        permanent: permanent,
    };

    // Store active header info.
    headerHash[headerUUID] = headerInfo;

    log('Set headers (ruleId):', headerInfo.id);
    log('Set headers (hash):', headerInfo.UUID);
    log('Set headers (permanent):', headerInfo.permanent);
    log('Set headers (action):', action);
    log('Set headers (condition):', condition);

    // Set HTTP header.
    await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
            {
                id: headerInfo.id,
                priority: 1,
                action,
                condition,
            },
        ],
        removeRuleIds: [headerInfo.id],
    });

    // Return header info.
    return headerInfo;
}

// Remove declarativeNetRequest HTTP headers incl. permanent ones if set to true
function removeHeaders(headerUUID, removePermanent = false) {
    // Do not try removing non-existing headers.
    if (!headerHash[headerUUID]) {
        return;
    }

    // Do not remove permanent headers if not set to true.
    if (!headerHash[headerUUID].permanent || (headerHash[headerUUID].permanent && removePermanent)) {
        log('Remove headers (ruleId):', headerHash[headerUUID].id);
        log('Remove headers (hash):', headerHash[headerUUID].UUID);
        log('Remove headers (permanent):', headerHash[headerUUID].permanent);

        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [headerHash[headerUUID].id],
        });

        delete headerHash[headerUUID];
        headerCount--;
    }
}

// Remove all declarativeNetRequest HTTP headers incl. permanent ones if set to true
async function removeHeadersAll() {
    for (const key in headerHash) {
        removeHeaders(headerHash[key].UUID, true);
    }

    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    const existingRuleIds = existingRules.map((rule) => rule.id);
    chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: existingRuleIds,
    });

    log('All headers removed:', headerCount);
}

// Remove all declarativeNetRequest session rules.
removeHeadersAll();

// Debug matched net requests.
// This feature requires 'declarativeNetRequestFeedback' permission in manifest.json.
// todo Comment this out for production.
// chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
//     log("onRuleMatchedDebug:", info);
// });

// Extension management.
// ---------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
    chrome.tabs.query(
        {
            url: ['https://www.locoloader.com/*', 'https://www.locoloader.test/*'],
        },
        (tabs) => {
            if (
                !tabs.length &&
                details.reason &&
                chrome.runtime.OnInstalledReason &&
                chrome.runtime.OnInstalledReason.INSTALL &&
                details.reason === chrome.runtime.OnInstalledReason.INSTALL
            ) {
                // Open Locoloader page upon installation if no other Locoloader pages are open.
                chrome.tabs.create({ url: 'https://www.locoloader.com' });
            }

            // Reload Locoloader pages when user installs extension.
            for (const tab of tabs) {
                setTimeout(() => {
                    log('Tab reloaded:' + tab.id);
                    chrome.tabs.reload(tab.id);
                }, 100);
            }
        },
    );
});

// Reload Locoloader pages when user enables extension.
chrome.management.onEnabled.addListener((extension) => {
    if (extension.id === chrome.runtime.id) {
        chrome.tabs.query(
            {
                url: ['https://www.locoloader.com/*', 'https://www.locoloader.test/*'],
            },
            (tabs) => {
                for (const tab of tabs) {
                    setTimeout(() => {
                        log('Tab reloaded:' + tab.id);
                        chrome.tabs.reload(tab.id);
                    }, 100);
                }
            },
        );
    }
});

// Automatically update extension as soon as possible.
chrome.runtime.onUpdateAvailable.addListener(() => {
    chrome.runtime.reload();
});
