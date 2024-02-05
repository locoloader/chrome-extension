// console.log('Content.js has been injected!')

// Prevent content.js from being re-injected into the same page
// ----------------------------------------------------
if (typeof document.injected == 'undefined') {

    // console.log('Content code has been injected!')
    document.injected = true

    // Cleanup
    // ---------------------------------------------

    // Remove listeners when background.js is disconnected
    chrome.runtime.onConnect.addListener((port) => {
        // Background script has been connected...
        port.onDisconnect.addListener(() => {
            // Clean up content script...
            // console.log('Content script has been cleaned!')
            document.removeEventListener('click', onClickButtons)
        })
    })

    // Functions
    // ---------------------------------------------

    const getExtensionActions = () => {
        const extActionsElement = document.getElementById('ext-actions')
        let extActions = extActionsElement.getAttribute('data-actions');
        return extActions ? JSON.parse(extActions) : {};
    }

    // Events
    // ---------------------------------------------

    // Detect the preview button element
    const isItPreviewButton = (el) => {
        if (
            el
            && el.tagName
            && el.tagName.toLowerCase() === 'a'
            && el.hasAttribute('data-bt-type')
            && el.getAttribute('data-bt-type') === 'bt-preview'
        ) {
            return el
        }

        // ...is the element inside the download button?
        if (
            el
            && el.parentNode
            && el.parentNode.tagName
            && el.parentNode.tagName.toLowerCase() === 'a'
            && el.parentNode.hasAttribute('data-bt-type')
            && el.parentNode.getAttribute('data-bt-type') === 'bt-preview'
        ) {
            return el.parentNode
        }

        return false
    }

    // Detect the download button element
    const isItDownloadButton = (el) => {
        if (
            el
            && el.tagName
            && el.tagName.toLowerCase() === 'a'
            && el.hasAttribute('data-bt-type')
            && el.getAttribute('data-bt-type') === 'bt-download'
        ) {
            return el
        }

        // ...is the element inside the download button?
        if (
            el
            && el.tagName
            && el.tagName.toLowerCase() === 'span'
            && el.parentNode
            && el.parentNode.hasAttribute('data-bt-type')
            && el.parentNode.getAttribute('data-bt-type') === 'bt-download'
        ) {
            return el.parentNode
        }

        return false
    }

    // Detect the download all button element
    const isItDownloadAllButton = (el) => {
        if (
            el
            && el.tagName
            && el.tagName.toLowerCase() === 'button'
            && el.hasAttribute('id')
            && el.getAttribute('id') === 'btCopyLinks'
        ) {
            return el
        }

        // ...is the element inside the download all button?
        if (
            el
            && el.parentNode
            && el.parentNode.tagName
            && el.parentNode.tagName.toLowerCase() === 'button'
            && el.parentNode.hasAttribute('id')
            && el.parentNode.getAttribute('id') === 'btCopyLinks'
        ) {
            return el.parentNode
        }

        return false
    }

    // Detect clicking the download buttons
    const onClickButtons = (e) => {

        // Did user click the Download button?
        let target = isItDownloadButton(e.target)
        if (target) {
            // console.log('Download button clicked!')
            e.preventDefault()

            // If URL is empty or equals 'exceeded' do not start the download
            const url = target.getAttribute('href')
            if (!url || url === 'exceeded') {
                return
            }

            // If the version of this extension is lower than the required extension version do not start the download
            const minExtensionVersion = parseInt(target.getAttribute('data-ext-ver'))
            const extVersion = parseInt(chrome.runtime.getManifest().version.replaceAll('.', ''))
            if (extVersion < minExtensionVersion) {
                return
            }

            chrome.runtime.sendMessage({
                now: true,
                downloadSingle: [{
                    url: url,
                    filename: target.getAttribute('download'),
                    fileType: target.getAttribute('data-file-type'),
                    folder: target.getAttribute('data-download-folder'),
                    minExtensionVersion: minExtensionVersion,
                }],
                extActions: getExtensionActions()
            })
        }

        // Did user click the Download All button?
        if (!target && isItDownloadAllButton(e.target)) {
            // console.log('Download All button clicked!')
            e.preventDefault()
            const dlButtons = document.querySelectorAll('.content-final-multi')
            const links = []
            dlButtons.forEach((el) => {
                const checkbox = el.querySelector('label input')
                if (checkbox && checkbox.checked) {
                    const link = el.querySelector('a[data-bt-type=bt-download]')
                    if (link) {
                        // If URL is empty or equals 'exceeded' do not start the download
                        const url = link.getAttribute('href')
                        if (!url || url === 'exceeded') {
                            return
                        }

                        // If the version of this extension is lower than the required extension version do not start the download
                        const minExtensionVersion = parseInt(link.getAttribute('data-ext-ver'))
                        const extVersion = parseInt(chrome.runtime.getManifest().version.replaceAll('.', ''))
                        if (extVersion < minExtensionVersion) {
                            return
                        }

                        links.push({
                            url: url,
                            filename: link.getAttribute('download'),
                            fileType: link.getAttribute('data-file-type'),
                            folder: link.getAttribute('data-download-folder'),
                            minExtensionVersion: minExtensionVersion
                        })
                    }
                }
            })
            if (links.length) {
                chrome.runtime.sendMessage({
                    now: true,
                    downloadMulti: links,
                    extActions: getExtensionActions()
                })
            }
        }

        // Did user click the Preview button?
        if (!target) {
            target = isItPreviewButton(e.target)

            if (target) {
                // If preview button link is not preview-able, do not initiate the preview
                const isPreviewable = target.getAttribute('data-is-previewable')
                if (isPreviewable === 'false') {
                    return
                }

                // If URL is empty or equals 'exceeded' do not initiate the preview
                const url = target.getAttribute('href')
                if (!url || url === 'exceeded') {
                    return
                }

                // If the version of this extension is lower than the required extension version do not initiate the preview
                const minExtensionVersion = parseInt(target.getAttribute('data-ext-ver'))
                const extVersion = parseInt(chrome.runtime.getManifest().version.replaceAll('.', ''))
                if (extVersion < minExtensionVersion) {
                    return
                }

                // Let the extension control the button
                e.preventDefault()

                chrome.runtime.sendMessage({
                    previewURL: url,
                    fileType: target.getAttribute('data-file-type'),
                    extActions: getExtensionActions()
                })
            }
        }
    }
    document.removeEventListener('click', onClickButtons)
    document.addEventListener('click', onClickButtons)

    // Listening to message
    // ---------------------------------------------
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // console.log('Content.js received message from background.js: ', message)

        // Detect the message from downloadLinks() in backround.js
        if (message.createHref) {
            const a = document.createElement('a')
            a.href = message.createHref
            a.target = '_blank'
            a.dispatchEvent(new MouseEvent('click'))
            sendResponse({createHref: true})
        }
    })

    // Helpers
    // ---------------------------------------------

    // Add the extension ID to the document (used to send messages to extension)
    const extensionId = document.getElementById('extension-id')
    if (!extensionId) {
        let el = document.createElement('div')
        el.setAttribute('id', 'extension-id')
        el.setAttribute('data-extension-id', chrome.runtime.id)
        document.body.appendChild(el)
    }

    // Append a div with id 'extension' to document to allow pages to detect the extension
    const extension = document.getElementById('extension')
    if (!extension) {
        let el = document.createElement('div')
        el.setAttribute('id', 'extension')
        el.setAttribute('data-ver', chrome.runtime.getManifest().version.replaceAll('.', ''))
        document.body.appendChild(el)
    }
}