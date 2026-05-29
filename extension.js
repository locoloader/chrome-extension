// Append a div with id 'extension' to document to allow pages to detect the extension
const extension = document.getElementById('extension');
if (!extension) {
    let el = document.createElement('div');
    el.setAttribute('id', 'extension');
    el.setAttribute('data-extension-version', chrome.runtime.getManifest().version.replaceAll('.', ''));
    el.setAttribute('data-extension-id', chrome.runtime.id);
    el.setAttribute('data-extension-type', 'chrome');
    document.body.appendChild(el);
}
