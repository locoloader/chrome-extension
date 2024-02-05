'use strict'

// Extension options
// ---------------------------------------------

// Get and set the default value for each checkbox option
const extensionOptions = {
    btDlAllFolder: true,
    btDlFolder: false
}
for (const key in extensionOptions) {
    chrome.storage.local.get(key, (res) => {
        if (res.hasOwnProperty(key)) {
            extensionOptions[key] = res[key]
        }
    })
}

// Download
// ---------------------------------------------
let downloadNext = {}

chrome.downloads.onChanged.addListener((downloadDelta) => {
    // Download ended with error or success
    if (downloadDelta.hasOwnProperty('error') || downloadDelta.hasOwnProperty('endTime')) {
        if (downloadNext[downloadDelta.id]) {
            // Download next link
            downloadLinks(downloadNext[downloadDelta.id].message, downloadNext[downloadDelta.id].index)

            // Delete a completed download from downloadNext
            delete (downloadNext[downloadDelta.id])
        }
    }
})

function downloadLinks(message, index = 0) {
    // Get links
    const links = message.downloadSingle || message.downloadMulti

    // All links have been downloaded
    if (typeof links[index] === 'undefined') {
        return
    }

    // User cannot download any more links
    if (links[index].url === 'exceeded') {
        return
    }

    // Is it a single download?
    const single = !!message.downloadSingle

    // Should we create a download folder?
    const createFolder = single && extensionOptions.btDlFolder || !single && extensionOptions.btDlAllFolder

    // Is it a native download?
    // Download cannot be native if we need to set custom req/res HTTP headers
    let isNativeDownload = true
    let tmpHeaders = {}
    if (message.extActions && message.extActions.headers) {
        if (message.extActions.headers.download && Object.keys(message.extActions.headers.download).length !== 0) {
            isNativeDownload = false
            decodeCookies(message.extActions.headers.download)
            tmpHeaders = message.extActions.headers.download
        }
        else if (message.extActions.headers.both && Object.keys(message.extActions.headers.both).length !== 0) {
            isNativeDownload = false
            decodeCookies(message.extActions.headers.both)
            tmpHeaders = message.extActions.headers.both
        }
    }

    // Download using document element
    if (!isNativeDownload) {
        // Find any Locoloader tab and init the download from it
        chrome.tabs.query({
            active: true,
            currentWindow: true,
            url: [
                'https://www.locoloader.com/*',
                'https://www.locoloader.test/*'
            ]
        }, (tabs) => {
            // Did we find any Locoloader tab?
            if (!tabs[0]) {
                return
            }

            // Filename
            let filename = links[index].filename.replaceAll('/', '-')
            if (createFolder && links[index].folder) {
                filename = links[index].folder + '/' + filename
            }

            // Set the download header
            tmpHeaders.action.responseHeaders = [{
                'header': 'content-disposition',
                'operation': 'set',
                'value': 'attachment; filename=' + filename
            }]

            // Set custom req/res HTTP headers
            const headerInfo = setHeaders(tmpHeaders.action, tmpHeaders.condition)

            // Send a message to content.js to create the href and init the download
            // console.log('Background.js sent message to content.js: ', {createHref: links[index].url})
            chrome.tabs.sendMessage(tabs[0].id, {
                createHref: links[index].url
            }, (res) => {
                // Got a response from content.js, that means the href was created and clicked
                // console.log('Got response from content.js: ', res)

                // Remove custom HTTP req/res headers 200 ms after the download started
                setTimeout(() => {
                    removeHeaders(headerInfo.UUID)
                }, 200)

                // Download next link
                setTimeout(() => {
                    downloadLinks(message, (index + 1))
                }, 500)
            })
        })
    }

    // Download using the browser's native download function
    if (isNativeDownload) {
        // Init max 10 parallel downloads when the link index equals 0,
        // then add next download when the previous download finishes
        const maxParallelDownloads = 10
        const downloadsToInit = index === 0 ? maxParallelDownloads : 1
        for (let i = 0; i < downloadsToInit; i++) {
            // Skip non-existing links
            if (!links[(index + i)]) {
                continue
            }

            // Filename
            let filename = links[(index + i)].filename.replaceAll('/', '-')
            if (createFolder && links[(index + i)].folder) {
                filename = links[(index + i)].folder + '/' + filename
            }

            // Download
            chrome.downloads.download({
                url: links[(index + i)].url,
                filename: filename,
                saveAs: false
            }, (downloadId) => {
                // Once the file with the downloadId is downloaded, download the file with the index below
                downloadNext[downloadId] = {
                    'index': (index + i + maxParallelDownloads),
                    'message': message,
                }
            })
        }
    }
}

// Open the pre-configured tab with fetcher.js
// ---------------------------------------------
function openTab(page) {
    return new Promise(async (resolve) => {

        // Open the background tab using page.url
        chrome.tabs.create({
            active: false,
            url: page.url
        }, (tab) => {

            // Monkeypatch MAIN JS code
            chrome.scripting.executeScript({
                world: 'MAIN',
                target: {tabId: tab.id},
                func: () => {
                    // Console clear monkeypatch
                    console.clear = () => {
                    }
                }
            }, () => {

                // Add configuration for fetcher.js
                chrome.scripting.executeScript({
                    world: 'MAIN',
                    target: {tabId: tab.id},
                    func: (page) => {
                        document.LLPage = page
                    },
                    args: [page],
                }, () => {

                    // Run and resolve fetcher.js
                    chrome.scripting.executeScript({
                        world: 'MAIN',
                        target: {tabId: tab.id},
                        files: ['fetcher.js'],
                    }, (result) => {
                        // console.log('Tab in background.js received result from fetcher.js: ', result)

                        // If the response contains reFetch attribute, it means that the page should be re-fetched
                        if (result[0].result.reFetch) {
                            setTimeout(async () => {
                                // Close the fetched tab
                                chrome.tabs.remove(tab.id)

                                // Only re-fetch once
                                page['doNotReFetch'] = true

                                // Re-open, re-fetch and return result from fetcher.js
                                resolve(await openTab(page))
                            }, 9000)

                        } else {
                            // Close the fetched tab
                            chrome.tabs.remove(tab.id)

                            // Return result from fetcher.js
                            resolve(result)
                        }
                    })
                })
            })
        })
    })
}

// Listening to message
// ---------------------------------------------
chrome.runtime.onMessage.addListener(async (message) => {
    // console.log('Background.js received message from content.js:', message)

    // Set options
    if (message.option === true) {
        extensionOptions[message.optionName] = message.optionVal
    }

    // Initiate preview
    if (message.previewURL) {
        // Update extension actions
        const extActions = message.extActions

        // Set the preview link headers, we got from extension actions
        if (extActions && extActions.headers) {
            if (extActions.headers.preview && (extActions.headers.preview.action.requestHeaders || extActions.headers.preview.action.responseHeaders)) {
                decodeCookies(extActions.headers.preview)
                const headerInfo = setHeaders(extActions.headers.preview.action, extActions.headers.preview.condition)
            } else if (extActions.headers.both && (extActions.headers.both.action.requestHeaders || extActions.headers.both.action.responseHeaders)) {
                decodeCookies(extActions.headers.both)
                const headerInfo = setHeaders(extActions.headers.both.action, extActions.headers.both.condition)
            }
        }

        setTimeout(() => {
            chrome.tabs.create({
                url: message.previewURL,
                active: true,
            }, (res) => {
                // Remove declarativeNetRequest session rules (remove preview link headers)
                if (typeof headerInfo !== 'undefined') {
                    setTimeout(() => {
                        removeHeaders(headerInfo.UUID)
                    }, 200)
                }
            })
        }, 100)
    }

    // Initiate download of a single file...
    if (message.downloadSingle && message.now === true) {
        downloadLinks(message)
    }

    // Initiate download of multiple files...
    if (message.downloadMulti && message.now === true) {
        downloadLinks(message)
    }
})

// Listening to an external message
// ---------------------------------------------
chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
    // console.log('Background.js received message from App.js:', message)
    // Allow only external messages from trusted origins
    if (sender.origin !== 'https://www.locoloader.com' && sender.origin !== 'https://www.locoloader.test') {
        return
    }

    // Update HTTP headers
    if (message.type && message.type === 'ext-headers') {
        if (message.setHeaders.length > 0) {
            // Debug logs, uncomment for testing
            // console.log('Received headers:', message.setHeaders)
            for (let setHeaderObj of message.setHeaders) {
                // Debug logs, uncomment for testing
                // console.log('Header obj:', setHeaderObj)
                setHeaders(setHeaderObj.action, setHeaderObj.condition, true)
            }
        }

        // Response
        sendResponse({
            'msg': 'headers set',
        })
    }

    // Fetch the specified URL in a new tab
    if (message.type && message.type === 'ext-tab') {

        // Set tab headers
        if (message.headers.action && message.headers.condition) {
            // console.log('Setting headers: ', message.headers)
            const headerInfo = setHeaders(message.headers.action, message.headers.condition)
        }

        // Set HTTP headers
        if (message.setHeaders.length > 0) {
            console.log('Received headers:', message.setHeaders)
            for (let setHeaderObj of message.setHeaders) {
                console.log('Header obj:', setHeaderObj)
                setHeaders(setHeaderObj.action, setHeaderObj.condition, true)
            }
        }

        // Request
        const pageObj = await openTab(message)

        // Remove request headers
        if (typeof headerInfo !== 'undefined' && message.headers.action && message.headers.condition) {
            removeHeaders(headerInfo.UUID)
        }

        // Response
        sendResponse(pageObj ? pageObj[0].result : {html: ''})
    }

    // Fetch the specified URL inline
    if (message.type && message.type === 'ext-fetch') {
        // Default response
        const pageObj = {
            'url': message.url,
            'headers': {},
            'html': '',
        }

        // Set request headers...
        let requestHeaders = []

        // ...other HTTP headers
        if (message.fetchOptions.headers && Object.keys(message.fetchOptions.headers)) {
            for (const [key, val] in message.fetchOptions.headers) {
                requestHeaders.push({
                    'header': key,
                    'operation': 'set',
                    'value': val
                })
            }
        }

        // ...referer
        if (message.fetchOptions.referrer) {
            requestHeaders.push({
                'header': 'Referer',
                'operation': 'set',
                'value': message.fetchOptions.referrer
            })
        }

        // ...referer policy
        if (message.fetchOptions.referrerPolicy) {
            requestHeaders.push({
                'header': 'Referrer-Policy',
                'operation': 'set',
                'value': message.fetchOptions.referrerPolicy
            })
        }

        // ...set headers
        if (requestHeaders.length) {
            const headerInfo = setHeaders({
                'type': 'modifyHeaders',
                'requestHeaders': requestHeaders,
            }, {
                'resourceTypes': ['xmlhttprequest']
            })
        }

        // Request
        const fetchResponse = await fetch(message.url, message.fetchOptions ? message.fetchOptions : {})

        // Remove request headers
        if (typeof headerInfo !== 'undefined') {
            removeHeaders(headerInfo.UUID)
        }

        // ...get page HTML
        pageObj.html = await fetchResponse.text()

        // ...get page HTTP headers
        pageObj.headers = Object.fromEntries(fetchResponse.headers.entries())

        // Response...
        // Send response back to Locoloader
        sendResponse(pageObj)
    }
})

// HTTP request / response modifications
// ---------------------------------------------

// Decode the HTTP request cookie header value
function decodeCookies(headersObj) {
    if (headersObj.action && headersObj.action.requestHeaders) {
        for (const key in headersObj.action.requestHeaders) {
            if (headersObj.action.requestHeaders[key].header === 'cookie') {
                headersObj.action.requestHeaders[key].value = decodeURIComponent(headersObj.action.requestHeaders[key].value)
            }
        }
    }
}

// Initial HTTP headers state
let headerCount = 0
let headerHash = {}

// Fast and good enough hashing function to generate the HTTP header UID
function hash(string) {
    let hash = 0, i, chr
    if (string.length === 0) return hash;
    for (i = 0; i < string.length; i++) {
        chr = string.charCodeAt(i)
        hash = ((hash << 5) - hash) + chr
        hash |= 0
    }
    return hash
}

// Set declarativeNetRequest HTTP headers
function setHeaders(action, condition, permanent = false) {
    // Generate header uid
    const jsonString = JSON.stringify({'action': action, 'condition': condition})
    const headerUUID = hash(jsonString)

    // Do not set the same header multiple times
    if (headerHash[headerUUID]) {
        return headerHash[headerUUID]
    }

    // Update the number of active headers
    headerCount++

    // Header info JSON
    const headerInfo = {
        id: headerCount,
        UUID: headerUUID,
        permanent: permanent
    }

    // Update the state of active headers
    headerHash[headerUUID] = headerInfo

    // Debug logs, uncomment for testing
    // console.log('Set headers (id): ', headerInfo.id)
    // console.log('Set headers (hash): ', headerInfo.UUID)
    // console.log('Set headers (permanent): ', headerInfo.permanent)
    // console.log('Set headers (action): ', action)
    // console.log('Set headers (condition): ', condition)

    // Set HTTP header
    chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
            {
                'id': headerInfo.id,
                'priority': 1,
                'action': action,
                'condition': condition
            }
        ],
        removeRuleIds: [headerInfo.id]
    })

    // Return header info
    return headerInfo
}

// Remove declarativeNetRequest HTTP headers incl. permanent ones if set to true
function removeHeaders(headerUUID, removePermanent = false) {

    // Do not try removing non-existing headers
    if (!headerHash[headerUUID]) {
        return
    }

    // Do not remove permanent headers if they are not required
    if (!headerHash[headerUUID].permanent || (headerHash[headerUUID].permanent && removePermanent)) {
        // Debug logs, uncomment for testing
        // console.log('Remove headers (id): ', headerHash[headerUUID].id)
        // console.log('Remove headers (hash): ', headerHash[headerUUID].UUID)
        // console.log('Remove headers (permanent): ', headerHash[headerUUID].permanent)

        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [headerHash[headerUUID].id]
        })

        delete headerHash[headerUUID]
        headerCount--
    }
}

// Remove all declarativeNetRequest HTTP headers incl. permanent ones if set to true
function removeHeadersAll(permanent = false) {
    for (const key in headerHash) {
        removeHeaders(headerHash[key].UUID, permanent)
    }

    // Debug logs, uncomment for testing
    // console.log('Number of active headers: ', headerCount)
}

// Remove all declarativeNetRequest session rules
// Load/reload to make sure there are no hanging rules
removeHeadersAll(true)

// Debug the matched net requests
// This feature requires 'declarativeNetRequestFeedback' permission in manifest.json
// todo Comment this out for production
// chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
//     console.log(info)
// })

// Content scripts
// ---------------------------------------------

// Inject content scripts into open Locoloader tabs and reload them
function injectContentScripts() {
    chrome.tabs.query({
        url: [
            'https://www.locoloader.com/*',
            'https://www.locoloader.test/*'
        ]
    }, (tabs) => {
        tabs.forEach((tab) => {
            chrome.scripting
                .executeScript({
                    target: {tabId: tab.id},
                    files: ['content.js']
                }, (result) => {
                    // console.log('Injected content scripts when loading/reloading the extension to: ' + tab.id)
                    // console.log('Created connection when loading/reloading the extension to: ' + tab.id)
                    chrome.tabs.connect(tab.id)

                    setTimeout(() => {
                        // console.log('Tab reloaded: ' + tab.id)
                        chrome.tabs.reload(tab.id)
                    }, 100)
                })
        })
    })
}

async function unregisterAllDynamicContentScripts() {
    try {
        const scripts = await chrome.scripting.getRegisteredContentScripts()
        // console.log('All registered content scripts:', scripts)
        const scriptIds = scripts.map(script => script.id)
        // console.log('Content scripts to unload:', scriptIds)
        if (scriptIds.length) {
            return chrome.scripting.unregisterContentScripts(scriptIds)
        } else {
            return false
        }
    } catch (err) {
        throw new Error(err)
    }
}
chrome.runtime.connect().onDisconnect.addListener(unregisterAllDynamicContentScripts)

// Fired when the extension is installed and when the extension or Chrome is updated.
// Fired also when the extension is reloaded.
function onInstalled(details) {
    injectContentScripts()

    // Open Locoloader page when extension is installed for the first time
    if (details.reason && chrome.runtime.OnInstalledReason && chrome.runtime.OnInstalledReason.INSTALL && details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        chrome.tabs.create({ url: 'https://www.locoloader.com' })
    }
}
chrome.runtime.onInstalled.addListener(onInstalled)

// Fired when user enables the extension
function onEnabled(extension) {
    if(extension.id === chrome.runtime.id) {
        injectContentScripts()
    }
}
chrome.management.onEnabled.addListener(onEnabled)

// Auto-update
// ---------------------------------------------

// Automatically update the extension as soon as possible
chrome.runtime.onUpdateAvailable.addListener(() => {
    chrome.runtime.reload()
})