// console.log('Content script has been injected!')

// Add the extension ID to the document (used to send messages to extension)
var extensionId = document.getElementById('extension-id')
if (!extensionId) {
    let el = document.createElement('div')
    el.setAttribute('id', 'extension-id')
    el.setAttribute('data-extension-id', chrome.runtime.id)
    document.body.appendChild(el)
}

// Append a div with id 'extension' to document to allow pages to detect the extension
var extension = document.getElementById('extension')
if (!extension) {
    var el = document.createElement('div')
    el.setAttribute('id', 'extension')
    el.setAttribute('data-ver', chrome.runtime.getManifest().version.replaceAll('.', ''))
    document.body.appendChild(el)
}